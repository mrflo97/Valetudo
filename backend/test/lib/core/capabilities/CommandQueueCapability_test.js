const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {afterEach, beforeEach, describe, it} = require("node:test");

const CommandQueueCapability = require("../../../../lib/core/capabilities/CommandQueueCapability");
const {StatusStateAttribute} = require("../../../../lib/entities/state/attributes");

const STATUS = StatusStateAttribute.VALUE;

function createRobot(options) {
    const listeners = [];
    const capabilities = options.capabilities ?? {};

    return {
        config: {
            location: path.join(options.directory, "valetudo_config.json")
        },
        state: {
            status: options.status,
            getFirstMatchingAttribute: function() {
                return this.status ? {value: this.status} : undefined;
            }
        },
        capabilities: capabilities,
        hasCapability: function(type) {
            return capabilities[type] !== undefined;
        },
        valetudoEventStore: {
            events: [],
            raise: function(event) {
                this.events.push(event);
            }
        },
        onStateAttributesUpdated: function(listener) {
            listeners.push(listener);
        },
        setStatus: function(status) {
            this.state.status = status;
            listeners.forEach(listener => {
                listener();
            });
        }
    };
}

function tick() {
    return new Promise(resolve => {
        setImmediate(resolve);
    });
}

describe("CommandQueueCapability", () => {
    let directory;
    let capabilities;
    let robot;
    let queue;
    let originalSettleDelay;

    beforeEach(async () => {
        directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "command-queue-test-"));

        capabilities = {
            GoToLocationCapability: {
                goTo: async (location) => {
                    capabilities.GoToLocationCapability.calls.push(location.coordinates);
                    robot.setStatus(STATUS.MOVING);
                },
                calls: []
            },
            MapSegmentationCapability: {
                getSegments: async () => {
                    return [{id: "1"}, {id: "2"}];
                },
                executeSegmentAction: async (segments) => {
                    capabilities.MapSegmentationCapability.calls.push(segments.map(s => s.id));
                    robot.setStatus(STATUS.CLEANING);
                },
                calls: []
            },
            ZoneCleaningCapability: {
                start: async () => {
                    capabilities.ZoneCleaningCapability.calls.push(true);
                    robot.setStatus(STATUS.CLEANING);
                },
                calls: []
            },
            BasicControlCapability: {
                start: async () => {
                    capabilities.BasicControlCapability.startCalls.push(true);
                    robot.setStatus(STATUS.CLEANING);
                },
                home: async () => {
                    capabilities.BasicControlCapability.homeCalls.push(true);
                    robot.setStatus(STATUS.RETURNING);
                },
                pause: async () => undefined,
                stop: async () => undefined,
                startCalls: [],
                homeCalls: []
            }
        };

        robot = createRobot({directory: directory, status: STATUS.DOCKED, capabilities: capabilities});

        originalSettleDelay = CommandQueueCapability.SETTLE_DELAY_MS;
        CommandQueueCapability.SETTLE_DELAY_MS = 0;

        queue = new CommandQueueCapability({robot: robot});
    });

    afterEach(async () => {
        CommandQueueCapability.SETTLE_DELAY_MS = originalSettleDelay;
        await queue.shutdown();
        await fs.promises.rm(directory, {recursive: true, force: true});
    });

    it("dispatches immediately when the robot is idle", async () => {
        queue.enqueueGoTo({x: 10, y: 20});
        await tick();

        assert.equal(capabilities.GoToLocationCapability.calls.length, 1);
        assert.deepEqual(capabilities.GoToLocationCapability.calls[0], {x: 10, y: 20});
        assert.equal(queue.getState().actions[0].state, CommandQueueCapability.COMMAND_STATE.RUNNING);
    });

    it("queues while the robot is busy and runs the next command once it is done", async () => {
        robot.setStatus(STATUS.CLEANING);

        queue.enqueueGoTo({x: 1, y: 1});
        queue.enqueueSegmentClean({segmentIds: ["1"]});
        await tick();

        assert.equal(capabilities.GoToLocationCapability.calls.length, 0);
        assert.equal(queue.getState().actions.length, 2);

        robot.setStatus(STATUS.IDLE);
        await tick();

        assert.equal(capabilities.GoToLocationCapability.calls.length, 1);
        assert.equal(queue.getState().actions[0].state, CommandQueueCapability.COMMAND_STATE.RUNNING);

        // The go-to command completes and the segment clean is dispatched afterwards
        robot.setStatus(STATUS.IDLE);
        await tick();

        assert.equal(capabilities.MapSegmentationCapability.calls.length, 1);
        assert.deepEqual(capabilities.MapSegmentationCapability.calls[0], ["1"]);
    });

    it("holds the queue while the robot is paused", async () => {
        robot.setStatus(STATUS.PAUSED);
        queue.enqueueFullClean();
        await tick();

        assert.equal(capabilities.BasicControlCapability.startCalls.length, 0);

        robot.setStatus(STATUS.IDLE);
        await tick();

        assert.equal(capabilities.BasicControlCapability.startCalls.length, 1);
    });

    it("treats docking while already docked as a completed no-op", async () => {
        queue.enqueueHome();
        await tick();

        assert.equal(capabilities.BasicControlCapability.homeCalls.length, 0);
        assert.equal(queue.getState().actions.length, 0);
        assert.equal(queue.getState().runningId, undefined);
    });

    it("clears the queue on cancelAll", async () => {
        robot.setStatus(STATUS.CLEANING);
        queue.enqueueGoTo({x: 1, y: 1});
        queue.enqueueGoTo({x: 2, y: 2});
        assert.equal(queue.getState().actions.length, 2);

        queue.cancelAll();

        assert.equal(queue.getState().actions.length, 0);
        assert.equal(queue.getState().runningId, undefined);
    });

    it("skips a failing command, raises an event and continues with the next one", async () => {
        capabilities.GoToLocationCapability.goTo = async () => {
            throw new Error("boom");
        };
        robot.setStatus(STATUS.CLEANING);
        queue.enqueueGoTo({x: 1, y: 1});
        queue.enqueueFullClean();

        robot.setStatus(STATUS.IDLE);
        await tick();

        assert.equal(robot.valetudoEventStore.events.length, 1);
        assert.match(robot.valetudoEventStore.events[0].message, /boom/);

        // The failing command is dropped and the full clean is dispatched
        assert.equal(capabilities.BasicControlCapability.startCalls.length, 1);
    });

    it("skips a segment clean whose segment no longer exists", async () => {
        robot.setStatus(STATUS.CLEANING);
        queue.enqueueSegmentClean({segmentIds: ["42"]});

        robot.setStatus(STATUS.IDLE);
        await tick();

        assert.equal(capabilities.MapSegmentationCapability.calls.length, 0);
        assert.equal(robot.valetudoEventStore.events.length, 1);
        assert.match(robot.valetudoEventStore.events[0].message, /no longer exists/);
    });

    it("does not dispatch while the S7 map tools block commands", async () => {
        robot.capabilities.S7MapToolsCapability = {
            blocksCommands: () => true
        };
        queue.enqueueGoTo({x: 1, y: 1});
        await tick();

        assert.equal(capabilities.GoToLocationCapability.calls.length, 0);

        robot.capabilities.S7MapToolsCapability.blocksCommands = () => false;
        robot.setStatus(STATUS.IDLE);
        await tick();

        assert.equal(capabilities.GoToLocationCapability.calls.length, 1);
    });

    it("reorders and removes pending commands", () => {
        robot.setStatus(STATUS.CLEANING);
        const first = queue.enqueueGoTo({x: 1, y: 1});
        const second = queue.enqueueGoTo({x: 2, y: 2});

        queue.reorder([second, first]);
        assert.deepEqual(queue.getState().actions.map(a => a.id), [second, first]);

        queue.removeAction(second);
        assert.deepEqual(queue.getState().actions.map(a => a.id), [first]);
    });

    it("persists pending commands and restores them on startup", async () => {
        robot.setStatus(STATUS.CLEANING);
        queue.enqueueGoTo({x: 5, y: 6});
        queue.enqueueSegmentClean({segmentIds: ["1"], iterations: 2});

        const restoredQueue = new CommandQueueCapability({robot: robot});

        try {
            const restored = restoredQueue.getState().actions;
            assert.equal(restored.length, 2);
            assert.equal(restored[0].type, CommandQueueCapability.COMMAND_TYPE.GO_TO);
            assert.equal(restored[1].type, CommandQueueCapability.COMMAND_TYPE.SEGMENT_CLEAN);
            assert.equal(restored[1].params.iterations, 2);
        } finally {
            await restoredQueue.shutdown();
        }
    });

    it("rejects commands for capabilities the robot does not have", () => {
        delete robot.capabilities.GoToLocationCapability;

        assert.throws(() => {
            queue.enqueueGoTo({x: 1, y: 1});
        }, /GoToLocationCapability/);
    });
});
