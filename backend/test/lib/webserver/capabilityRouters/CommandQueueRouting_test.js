const assert = require("node:assert/strict");
const express = require("express");
const {test} = require("node:test");

const BasicControlCapabilityRouter = require("../../../../lib/webserver/capabilityRouters/BasicControlCapabilityRouter");
const GoToLocationCapabilityRouter = require("../../../../lib/webserver/capabilityRouters/GoToLocationCapabilityRouter");
const MapSegmentationCapabilityRouter = require("../../../../lib/webserver/capabilityRouters/MapSegmentationCapabilityRouter");
const ZoneCleaningCapabilityRouter = require("../../../../lib/webserver/capabilityRouters/ZoneCleaningCapabilityRouter");

const passThroughValidator = (req, res, next) => next();

function createRobot(options) {
    return {
        capabilities: options.capabilities ?? {},
        state: {
            getFirstMatchingAttribute: function() {
                return options.status ? {value: options.status} : undefined;
            }
        }
    };
}

// Starts a router on a random port and returns a function to PUT a JSON body to it.
async function startRouter(t, Router, robot, capability) {
    const app = express();
    app.use(express.json());
    app.use("/cap", new Router({capability: capability, validator: passThroughValidator, robot: robot}).getRouter());
    app.use((error, req, res, next) => res.status(500).json({message: error.message}));

    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, "127.0.0.1");
        listening.once("listening", () => resolve(listening));
        listening.once("error", reject);
    });

    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    return body => fetch(`http://127.0.0.1:${server.address().port}/cap/`, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
    });
}

test("map action routers enqueue through the command queue", async t => {
    const queued = [];
    const direct = [];
    const robot = createRobot({
        status: "docked",
        capabilities: {
            CommandQueueCapability: {
                enqueueGoTo: params => queued.push(["go_to", params]),
                enqueueSegmentClean: params => queued.push(["segment_clean", params]),
                enqueueZoneClean: params => queued.push(["zone_clean", params])
            },
            GoToLocationCapability: {goTo: async () => direct.push("go_to")},
            MapSegmentationCapability: {executeSegmentAction: async () => direct.push("segment_clean")},
            ZoneCleaningCapability: {start: async () => direct.push("zone_clean")}
        }
    });

    const putGoTo = await startRouter(t, GoToLocationCapabilityRouter, robot, robot.capabilities.GoToLocationCapability);
    const putSegments = await startRouter(t, MapSegmentationCapabilityRouter, robot, robot.capabilities.MapSegmentationCapability);
    const putZones = await startRouter(t, ZoneCleaningCapabilityRouter, robot, robot.capabilities.ZoneCleaningCapability);

    assert.equal((await putGoTo({action: "goto", coordinates: {x: 5, y: 6}})).status, 200);
    assert.equal((await putSegments({action: "start_segment_action", segment_ids: ["1", "2"], iterations: 2})).status, 200);
    assert.equal((await putZones({action: "clean", zones: [{points: {}}]})).status, 200);

    assert.deepEqual(queued, [
        ["go_to", {x: 5, y: 6}],
        ["segment_clean", {segmentIds: ["1", "2"], iterations: 2, customOrder: undefined}],
        ["zone_clean", {zones: [{points: {}}], iterations: 1}]
    ]);
    assert.equal(direct.length, 0);
});

test("map action routers fall back to direct execution without a command queue", async t => {
    const direct = [];
    const robot = createRobot({
        status: "docked",
        capabilities: {
            GoToLocationCapability: {goTo: async location => direct.push(location.coordinates)}
        }
    });

    const put = await startRouter(t, GoToLocationCapabilityRouter, robot, robot.capabilities.GoToLocationCapability);

    assert.equal((await put({action: "goto", coordinates: {x: 1, y: 2}})).status, 200);
    assert.deepEqual(direct, [{x: 1, y: 2}]);
});

test("basic control routes start, home, pause and stop correctly", async t => {
    const queued = [];
    const control = [];
    let cancelled = 0;
    const robot = createRobot({
        status: "docked",
        capabilities: {
            CommandQueueCapability: {
                enqueueFullClean: () => queued.push("full_clean"),
                enqueueHome: () => queued.push("home"),
                cancelAll: () => {
                    cancelled += 1;
                }
            },
            BasicControlCapability: {
                start: async () => control.push("start"),
                stop: async () => control.push("stop"),
                pause: async () => control.push("pause"),
                home: async () => control.push("home")
            }
        }
    });

    const put = await startRouter(t, BasicControlCapabilityRouter, robot, robot.capabilities.BasicControlCapability);

    await put({action: "start"});
    await put({action: "home"});
    await put({action: "pause"});
    await put({action: "stop"});

    assert.deepEqual(queued, ["full_clean", "home"]);
    assert.deepEqual(control, ["pause", "stop"]);
    assert.equal(cancelled, 1);

    // While paused, start resumes immediately instead of queueing a full clean
    robot.state.getFirstMatchingAttribute = () => ({value: "paused"});
    await put({action: "start"});

    assert.deepEqual(control, ["pause", "stop", "start"]);
    assert.deepEqual(queued, ["full_clean", "home"]);
});
