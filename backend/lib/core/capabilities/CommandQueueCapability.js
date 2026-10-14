const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BasicControlCapability = require("./BasicControlCapability");
const CommandQueueValetudoEvent = require("../../valetudo_events/events/CommandQueueValetudoEvent");
const GoToLocationCapability = require("./GoToLocationCapability");
const Logger = require("../../Logger");
const MapSegmentationCapability = require("./MapSegmentationCapability");
const ValetudoBasedCapability = require("./ValetudoBasedCapability");
const ValetudoGoToLocation = require("../../entities/core/ValetudoGoToLocation");
const ValetudoZone = require("../../entities/core/ValetudoZone");
const ZoneCleaningCapability = require("./ZoneCleaningCapability");
const {StatusStateAttribute} = require("../../entities/state/attributes");

/**
 * A Valetudo-based capability that holds an ordered list of robot actions and executes them
 * one after another as soon as the robot is able to accept a new command.
 *
 * This makes it possible to, for example, send a "go to", a segment clean and another segment
 * clean while the robot is still busy. Actions submitted while the robot is idle run (almost)
 * immediately; actions submitted while it is busy are appended to the queue.
 *
 * @template {import("../ValetudoRobot")} T
 * @extends ValetudoBasedCapability<T>
 */
class CommandQueueCapability extends ValetudoBasedCapability {
    /**
     * @param {object} options
     * @param {T} options.robot
     */
    constructor(options) {
        super(options);

        /** @type {Array<QueuedCommand>} */
        this.actions = [];
        this.runningId = undefined;
        this.lastStatusValue = undefined;
        this.readySince = undefined;
        this.settleTimer = undefined;
        this.startTimeoutTimer = undefined;
        this.runTimeoutTimer = undefined;
        /** @type {Set<(state: object) => void>} */
        this.listeners = new Set();
        this.persistencePath = path.join(path.dirname(this.robot.config.location), "command_queue.json");

        this.loadFromDisk();

        this.robot.onStateAttributesUpdated(() => {
            this.handleStateUpdate();
        });

        this.readySince = this.isReady() ? Date.now() : undefined;
        this.evaluate();
    }

    getType() {
        return CommandQueueCapability.TYPE;
    }

    /**
     * @returns {{maxQueueLength: number, supportedCommands: Array<string>}}
     */
    getProperties() {
        return {
            maxQueueLength: CommandQueueCapability.MAX_QUEUE_LENGTH,
            supportedCommands: Object.values(CommandQueueCapability.COMMAND_TYPE)
        };
    }

    /**
     * @public
     * @returns {{runningId: (string|undefined), actions: Array<object>}}
     */
    getState() {
        return {
            runningId: this.runningId,
            actions: this.actions.map(action => {
                return {
                    id: action.id,
                    type: action.type,
                    params: action.params,
                    state: action.state,
                    createdAt: action.createdAt,
                    startedAt: action.startedAt,
                    lastError: action.lastError
                };
            })
        };
    }

    /**
     * @public
     * @param {(state: object) => void} listener
     * @returns {() => void} unsubscribe function
     */
    onQueueUpdated(listener) {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Applies an external queue management command as used by the REST and MQTT interfaces.
     *
     * @public
     * @param {object} body
     */
    applyAction(body) {
        switch (body?.action) {
            case "enqueue":
                return this.enqueueFromRequest(body);
            case "remove":
                return this.removeAction(body.id);
            case "clear":
                return this.clearPending();
            case "reorder":
                return this.reorder(body.ids);
            default:
                throw new Error("Unknown action");
        }
    }

    /**
     * @private
     * @param {object} body
     * @returns {string}
     */
    enqueueFromRequest(body) {
        switch (body.type) {
            case CommandQueueCapability.COMMAND_TYPE.GO_TO:
                if (body.coordinates === undefined) {
                    throw new Error("Missing coordinates");
                }

                return this.enqueueGoTo(body.coordinates);
            case CommandQueueCapability.COMMAND_TYPE.SEGMENT_CLEAN:
                return this.enqueueSegmentClean({
                    segmentIds: body.segment_ids,
                    iterations: body.iterations,
                    customOrder: body.customOrder
                });
            case CommandQueueCapability.COMMAND_TYPE.ZONE_CLEAN:
                return this.enqueueZoneClean({
                    zones: body.zones,
                    iterations: body.iterations
                });
            case CommandQueueCapability.COMMAND_TYPE.FULL_CLEAN:
                return this.enqueueFullClean();
            case CommandQueueCapability.COMMAND_TYPE.HOME:
                return this.enqueueHome();
            default:
                throw new Error("Unknown command type");
        }
    }

    /**
     * @public
     * @param {{x: number, y: number}} coordinates
     * @returns {string} the id of the queued action
     */
    enqueueGoTo(coordinates) {
        if (typeof coordinates?.x !== "number" || typeof coordinates?.y !== "number") {
            throw new Error("Invalid go to coordinates");
        }

        return this.submit({
            type: CommandQueueCapability.COMMAND_TYPE.GO_TO,
            params: {
                x: coordinates.x,
                y: coordinates.y
            }
        });
    }

    /**
     * @public
     * @param {{segmentIds: Array<string|number>, iterations?: number, customOrder?: boolean}} options
     * @returns {string} the id of the queued action
     */
    enqueueSegmentClean(options) {
        if (!(Array.isArray(options?.segmentIds) && options.segmentIds.length > 0)) {
            throw new Error("Missing segment ids");
        }

        return this.submit({
            type: CommandQueueCapability.COMMAND_TYPE.SEGMENT_CLEAN,
            params: {
                segmentIds: options.segmentIds.map(id => {
                    return `${id}`;
                }),
                iterations: options.iterations ?? 1,
                customOrder: options.customOrder === true
            }
        });
    }

    /**
     * @public
     * @param {{zones: Array<object>, iterations?: number}} options
     * @returns {string} the id of the queued action
     */
    enqueueZoneClean(options) {
        if (!(Array.isArray(options?.zones) && options.zones.length > 0)) {
            throw new Error("Missing zones");
        }

        return this.submit({
            type: CommandQueueCapability.COMMAND_TYPE.ZONE_CLEAN,
            params: {
                zones: options.zones.map(zone => {
                    if (!zone?.points) {
                        throw new Error("Invalid Zone");
                    }

                    return {
                        points: {
                            pA: {x: zone.points.pA?.x, y: zone.points.pA?.y},
                            pB: {x: zone.points.pB?.x, y: zone.points.pB?.y},
                            pC: {x: zone.points.pC?.x, y: zone.points.pC?.y},
                            pD: {x: zone.points.pD?.x, y: zone.points.pD?.y}
                        }
                    };
                }),
                iterations: options.iterations ?? 1
            }
        });
    }

    /**
     * @public
     * @returns {string} the id of the queued action
     */
    enqueueFullClean() {
        return this.submit({
            type: CommandQueueCapability.COMMAND_TYPE.FULL_CLEAN,
            params: {}
        });
    }

    /**
     * @public
     * @returns {string} the id of the queued action
     */
    enqueueHome() {
        return this.submit({
            type: CommandQueueCapability.COMMAND_TYPE.HOME,
            params: {}
        });
    }

    /**
     * Adds a command to the queue and returns its id.
     * If the robot is idle, the command will be dispatched after a short settle delay.
     *
     * @public
     * @param {{type: string, params: object}} command
     * @returns {string}
     */
    submit(command) {
        const requiredCapability = CommandQueueCapability.CAPABILITY_FOR_COMMAND_TYPE[command?.type];

        if (!requiredCapability) {
            throw new Error(`Unknown command type: ${command?.type}`);
        }

        if (!this.robot.hasCapability(requiredCapability)) {
            throw new Error(`Robot is missing the ${requiredCapability}`);
        }

        if (this.actions.filter(a => {
            return a.state === CommandQueueCapability.COMMAND_STATE.PENDING;
        }).length >= CommandQueueCapability.MAX_QUEUE_LENGTH) {
            throw new Error("Command queue is full");
        }

        const action = {
            id: crypto.randomUUID(),
            type: command.type,
            params: command.params ?? {},
            state: CommandQueueCapability.COMMAND_STATE.PENDING,
            createdAt: new Date().toISOString(),
            startedAt: undefined,
            lastError: undefined,
            busyObserved: false
        };

        this.actions.push(action);
        this.persist();
        this.emitQueueUpdated();
        this.evaluate();

        return action.id;
    }

    /**
     * Removes a single pending command from the queue
     *
     * @public
     * @param {string} id
     */
    removeAction(id) {
        const index = this.actions.findIndex(action => {
            return action.id === id && action.state === CommandQueueCapability.COMMAND_STATE.PENDING;
        });

        if (index === -1) {
            throw new Error("No such queued command");
        }

        this.actions.splice(index, 1);
        this.persist();
        this.emitQueueUpdated();
        this.evaluate();
    }

    /**
     * Removes all pending commands from the queue. A currently running command is not affected.
     *
     * @public
     */
    clearPending() {
        this.actions = this.actions.filter(action => {
            return action.state !== CommandQueueCapability.COMMAND_STATE.PENDING;
        });
        this.persist();
        this.emitQueueUpdated();
    }

    /**
     * Reorders the pending commands. The provided ids must be a permutation of the currently pending ids.
     *
     * @public
     * @param {Array<string>} ids
     */
    reorder(ids) {
        const pending = this.actions.filter(action => {
            return action.state === CommandQueueCapability.COMMAND_STATE.PENDING;
        });

        if (!Array.isArray(ids) || ids.length !== pending.length) {
            throw new Error("Invalid order");
        }

        const byId = new Map(pending.map(action => {
            return [action.id, action];
        }));

        const reordered = ids.map(id => {
            const action = byId.get(id);

            if (!action) {
                throw new Error("Invalid order");
            }

            byId.delete(id);

            return action;
        });

        let pendingIndex = 0;
        this.actions = this.actions.map(action => {
            if (action.state === CommandQueueCapability.COMMAND_STATE.PENDING) {
                return reordered[pendingIndex++];
            }

            return action;
        });

        this.persist();
        this.emitQueueUpdated();
    }

    /**
     * Cancels the running command and removes all pending ones.
     * Used when the user presses Stop, as the queue then no longer makes sense.
     *
     * @public
     */
    cancelAll() {
        this.actions.forEach(action => {
            if (
                action.state === CommandQueueCapability.COMMAND_STATE.PENDING ||
                action.state === CommandQueueCapability.COMMAND_STATE.RUNNING
            ) {
                action.state = CommandQueueCapability.COMMAND_STATE.CANCELLED;
            }
        });

        this.clearRunningTimers();
        this.runningId = undefined;
        this.actions = [];
        this.readySince = Date.now();
        this.persist();
        this.emitQueueUpdated();
    }

    /**
     * @public
     * @returns {Promise<void>}
     */
    async shutdown() {
        this.clearSettleTimer();
        this.clearRunningTimers();
    }

    /**
     * @private
     */
    handleStateUpdate() {
        const status = this.getStatusValue();

        if (this.runningId !== undefined) {
            const action = this.getRunningAction();

            if (action) {
                if (!action.busyObserved && CommandQueueCapability.ACTIVE_STATUSES.includes(status)) {
                    action.busyObserved = true;
                    clearTimeout(this.startTimeoutTimer);
                    this.startTimeoutTimer = undefined;
                } else if (action.busyObserved && CommandQueueCapability.READY_STATUSES.includes(status)) {
                    this.completeRunning();

                    return;
                } else if (status === StatusStateAttribute.VALUE.ERROR) {
                    this.failRunning("Robot reported an error");

                    return;
                }
            }
        }

        if (status !== this.lastStatusValue) {
            if (
                CommandQueueCapability.READY_STATUSES.includes(status) &&
                !CommandQueueCapability.READY_STATUSES.includes(this.lastStatusValue)
            ) {
                this.readySince = Date.now();
            } else if (!CommandQueueCapability.READY_STATUSES.includes(status)) {
                this.readySince = undefined;
                this.clearSettleTimer();
            }

            this.lastStatusValue = status;
        }

        this.evaluate();
    }

    /**
     * Determines whether the next queued command can be dispatched
     *
     * @private
     */
    evaluate() {
        if (this.runningId !== undefined) {
            return;
        }

        const next = this.actions.find(action => {
            return action.state === CommandQueueCapability.COMMAND_STATE.PENDING;
        });

        if (!next) {
            return;
        }

        const status = this.getStatusValue();

        if (status === StatusStateAttribute.VALUE.PAUSED) {
            // A paused robot might be resumable. Hold the queue until it is either resumed or stopped.
            return;
        }

        if (!CommandQueueCapability.READY_STATUSES.includes(status)) {
            return;
        }

        if (this.commandsBlocked()) {
            return;
        }

        if (this.readySince === undefined) {
            this.readySince = Date.now();
        }

        const remaining = CommandQueueCapability.SETTLE_DELAY_MS - (Date.now() - this.readySince);

        if (remaining <= 0) {
            this.dispatch(next);
        } else if (this.settleTimer === undefined) {
            this.settleTimer = setTimeout(() => {
                this.settleTimer = undefined;
                this.evaluate();
            }, remaining);
        }
    }

    /**
     * @private
     * @param {QueuedCommand} action
     */
    async dispatch(action) {
        this.clearSettleTimer();

        this.runningId = action.id;
        action.state = CommandQueueCapability.COMMAND_STATE.RUNNING;
        action.startedAt = new Date().toISOString();
        action.busyObserved = false;

        if (
            action.type === CommandQueueCapability.COMMAND_TYPE.HOME &&
            this.getStatusValue() === StatusStateAttribute.VALUE.DOCKED
        ) {
            // The robot is already docked. Docking again is a no-op rather than a two-minute wait.
            this.completeRunning();

            return;
        }

        Logger.info(`CommandQueueCapability: Dispatching ${action.type}`);

        this.persist();
        this.emitQueueUpdated();

        this.startTimeoutTimer = setTimeout(() => {
            this.startTimeoutTimer = undefined;
            this.handleStartTimeout(action);
        }, CommandQueueCapability.START_TIMEOUT_MS);

        this.runTimeoutTimer = setTimeout(() => {
            this.runTimeoutTimer = undefined;
            this.failRunning("Command did not finish in time");
        }, CommandQueueCapability.RUN_TIMEOUT_MS);

        try {
            await this.execute(action);
        } catch (e) {
            this.failRunning(e?.message ?? `${e}`);
        }
    }

    /**
     * @private
     * @param {QueuedCommand} action
     */
    async execute(action) {
        switch (action.type) {
            case CommandQueueCapability.COMMAND_TYPE.GO_TO: {
                const capability = this.robot.capabilities[GoToLocationCapability.TYPE];

                return capability.goTo(new ValetudoGoToLocation({
                    coordinates: {
                        x: action.params.x,
                        y: action.params.y
                    }
                }));
            }

            case CommandQueueCapability.COMMAND_TYPE.SEGMENT_CLEAN: {
                const capability = this.robot.capabilities[MapSegmentationCapability.TYPE];
                const availableSegments = await capability.getSegments();

                const segments = action.params.segmentIds.map(id => {
                    const segment = availableSegments.find(segm => {
                        return segm.id === `${id}`;
                    });

                    if (!segment) {
                        throw new Error(`Segment no longer exists: ${id}`);
                    }

                    return segment;
                });

                return capability.executeSegmentAction(segments, {
                    iterations: action.params.iterations,
                    customOrder: action.params.customOrder
                });
            }

            case CommandQueueCapability.COMMAND_TYPE.ZONE_CLEAN: {
                const capability = this.robot.capabilities[ZoneCleaningCapability.TYPE];

                return capability.start({
                    zones: action.params.zones.map(zone => {
                        return new ValetudoZone({
                            points: zone.points
                        });
                    }),
                    iterations: action.params.iterations
                });
            }

            case CommandQueueCapability.COMMAND_TYPE.FULL_CLEAN: {
                const capability = this.robot.capabilities[BasicControlCapability.TYPE];

                return capability.start();
            }

            case CommandQueueCapability.COMMAND_TYPE.HOME: {
                const capability = this.robot.capabilities[BasicControlCapability.TYPE];

                return capability.home();
            }

            default:
                throw new Error(`Unknown command type: ${action.type}`);
        }
    }

    /**
     * @private
     * @param {QueuedCommand} action
     */
    handleStartTimeout(action) {
        if (this.runningId !== action.id || action.busyObserved) {
            return;
        }

        const status = this.getStatusValue();

        if (
            action.type === CommandQueueCapability.COMMAND_TYPE.HOME &&
            CommandQueueCapability.READY_STATUSES.includes(status)
        ) {
            // The robot is already docked. Docking again is a no-op rather than a failure.
            this.completeRunning();
        } else {
            this.failRunning("Robot did not start the command in time");
        }
    }

    /**
     * @private
     */
    completeRunning() {
        const action = this.getRunningAction();

        if (action) {
            action.state = CommandQueueCapability.COMMAND_STATE.DONE;
        }

        this.finishRunning();
    }

    /**
     * @private
     * @param {string} message
     */
    failRunning(message) {
        const action = this.getRunningAction();

        if (action) {
            action.state = CommandQueueCapability.COMMAND_STATE.FAILED;
            action.lastError = message;

            Logger.warn(`CommandQueueCapability: ${action.type} failed: ${message}`);

            this.raiseEvent(`A queued command (${action.type}) was skipped: ${message}`);
        }

        this.finishRunning();
    }

    /**
     * @private
     */
    finishRunning() {
        this.clearRunningTimers();
        this.runningId = undefined;
        this.readySince = Date.now();

        this.actions = this.actions.filter(action => {
            return action.state === CommandQueueCapability.COMMAND_STATE.PENDING;
        });

        this.persist();
        this.emitQueueUpdated();
        this.evaluate();
    }

    /**
     * @private
     * @returns {QueuedCommand|undefined}
     */
    getRunningAction() {
        return this.actions.find(action => {
            return action.id === this.runningId;
        });
    }

    /**
     * @private
     * @returns {string|undefined}
     */
    getStatusValue() {
        const statusStateAttribute = this.robot.state.getFirstMatchingAttribute({
            attributeClass: StatusStateAttribute.name
        });

        return statusStateAttribute?.value;
    }

    /**
     * @private
     * @returns {boolean}
     */
    isReady() {
        return CommandQueueCapability.READY_STATUSES.includes(this.getStatusValue());
    }

    /**
     * @private
     * @returns {boolean}
     */
    commandsBlocked() {
        // The private S7 map tools block commands while a map maintenance operation is running.
        const mapToolsCapability = this.robot.capabilities[CommandQueueCapability.BLOCKING_CAPABILITY_TYPE];

        if (mapToolsCapability && typeof mapToolsCapability.blocksCommands === "function") {
            return mapToolsCapability.blocksCommands() === true;
        }

        return false;
    }

    /**
     * @private
     * @param {string} message
     */
    raiseEvent(message) {
        if (this.robot.valetudoEventStore) {
            this.robot.valetudoEventStore.raise(new CommandQueueValetudoEvent({
                message: message
            }));
        }
    }

    /**
     * @private
     */
    emitQueueUpdated() {
        const state = this.getState();

        this.listeners.forEach(listener => {
            try {
                listener(state);
            } catch (e) {
                Logger.debug("CommandQueueCapability: Queue listener threw", e);
            }
        });
    }

    /**
     * @private
     */
    clearSettleTimer() {
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = undefined;
        }
    }

    /**
     * @private
     */
    clearRunningTimers() {
        if (this.startTimeoutTimer) {
            clearTimeout(this.startTimeoutTimer);
            this.startTimeoutTimer = undefined;
        }

        if (this.runTimeoutTimer) {
            clearTimeout(this.runTimeoutTimer);
            this.runTimeoutTimer = undefined;
        }
    }

    /**
     * @private
     */
    persist() {
        try {
            fs.mkdirSync(path.dirname(this.persistencePath), {recursive: true});

            const temporaryPath = `${this.persistencePath}.tmp`;

            fs.writeFileSync(temporaryPath, JSON.stringify({
                actions: this.actions.filter(action => {
                    return action.state === CommandQueueCapability.COMMAND_STATE.PENDING;
                })
            }, null, 2));

            fs.renameSync(temporaryPath, this.persistencePath);
        } catch (e) {
            Logger.warn("CommandQueueCapability: Failed to persist command queue", e);
        }
    }

    /**
     * @private
     */
    loadFromDisk() {
        try {
            if (!fs.existsSync(this.persistencePath)) {
                return;
            }

            const data = JSON.parse(fs.readFileSync(this.persistencePath).toString());

            if (Array.isArray(data?.actions)) {
                this.actions = data.actions.filter(action => {
                    return action && action.id && action.type && action.state === CommandQueueCapability.COMMAND_STATE.PENDING;
                }).map(action => {
                    return {
                        id: action.id,
                        type: action.type,
                        params: action.params ?? {},
                        state: CommandQueueCapability.COMMAND_STATE.PENDING,
                        createdAt: action.createdAt ?? new Date().toISOString(),
                        startedAt: undefined,
                        lastError: undefined,
                        busyObserved: false
                    };
                });

                if (this.actions.length > 0) {
                    Logger.info(`CommandQueueCapability: Restored ${this.actions.length} queued command(s)`);
                }
            }
        } catch (e) {
            Logger.warn("CommandQueueCapability: Failed to load command queue", e);
        }
    }
}

CommandQueueCapability.TYPE = "CommandQueueCapability";

CommandQueueCapability.COMMAND_TYPE = Object.freeze({
    GO_TO: "go_to",
    SEGMENT_CLEAN: "segment_clean",
    ZONE_CLEAN: "zone_clean",
    FULL_CLEAN: "full_clean",
    HOME: "home"
});

CommandQueueCapability.COMMAND_STATE = Object.freeze({
    PENDING: "pending",
    RUNNING: "running",
    DONE: "done",
    FAILED: "failed",
    CANCELLED: "cancelled"
});

CommandQueueCapability.CAPABILITY_FOR_COMMAND_TYPE = Object.freeze({
    [CommandQueueCapability.COMMAND_TYPE.GO_TO]: GoToLocationCapability.TYPE,
    [CommandQueueCapability.COMMAND_TYPE.SEGMENT_CLEAN]: MapSegmentationCapability.TYPE,
    [CommandQueueCapability.COMMAND_TYPE.ZONE_CLEAN]: ZoneCleaningCapability.TYPE,
    [CommandQueueCapability.COMMAND_TYPE.FULL_CLEAN]: BasicControlCapability.TYPE,
    [CommandQueueCapability.COMMAND_TYPE.HOME]: BasicControlCapability.TYPE
});

CommandQueueCapability.READY_STATUSES = [
    StatusStateAttribute.VALUE.IDLE,
    StatusStateAttribute.VALUE.DOCKED,
    StatusStateAttribute.VALUE.ERROR
];

CommandQueueCapability.ACTIVE_STATUSES = [
    StatusStateAttribute.VALUE.CLEANING,
    StatusStateAttribute.VALUE.RETURNING,
    StatusStateAttribute.VALUE.MOVING,
    StatusStateAttribute.VALUE.MANUAL_CONTROL
];

CommandQueueCapability.BLOCKING_CAPABILITY_TYPE = "S7MapToolsCapability";

CommandQueueCapability.SETTLE_DELAY_MS = 3000;
CommandQueueCapability.START_TIMEOUT_MS = 120 * 1000;
CommandQueueCapability.RUN_TIMEOUT_MS = 12 * 60 * 60 * 1000;
CommandQueueCapability.MAX_QUEUE_LENGTH = 50;

module.exports = CommandQueueCapability;

/**
 * @typedef {object} QueuedCommand
 * @property {string} id
 * @property {string} type
 * @property {object} params
 * @property {string} state
 * @property {string} createdAt
 * @property {string} [startedAt]
 * @property {string} [lastError]
 * @property {boolean} busyObserved
 */
