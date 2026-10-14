const assert = require("node:assert/strict");
const express = require("express");
const Router = require("../../../../lib/webserver/capabilityRouters/CommandQueueCapabilityRouter");
const validation = require("openapi-validator-middleware");
const {test} = require("node:test");

test("Command queue API", async t => {
    const prefix = "/api/v2/robot/capabilities/CommandQueueCapability";
    const applied = [];

    validation.init({
        openapi: "3.0.0",
        info: {title: "Command queue API test", version: "1"},
        paths: require("../../../../lib/webserver/capabilityRouters/doc/CommandQueueCapabilityRouter.openapi.json")
    });

    const capability = {
        getProperties: () => ({maxQueueLength: 50}),
        getState: () => ({
            runningId: undefined,
            actions: [{id: "abc", type: "full_clean", params: {}, state: "pending", createdAt: "2026-01-01T00:00:00.000Z"}]
        }),
        applyAction: body => {
            applied.push(body);
        },
        onQueueUpdated: () => () => undefined
    };

    const app = express();
    app.use(express.json());
    app.use(prefix, new Router({capability: capability, validator: validation.validate}).getRouter());
    app.use((error, req, res, next) => res.status(error.status ?? 400).json({message: error.message}));

    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, "127.0.0.1");
        listening.once("listening", () => resolve(listening));
        listening.once("error", reject);
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    const url = `http://127.0.0.1:${server.address().port}${prefix}`;
    const put = body => fetch(url, {method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});

    await t.test("serves the queue state", async () => {
        const response = await fetch(url);
        assert.equal(response.status, 200);
        const state = await response.json();
        assert.equal(state.actions[0].id, "abc");
    });

    await t.test("enqueues a command", async () => {
        const response = await put({action: "enqueue", type: "segment_clean", segment_ids: ["1"], iterations: 2});
        assert.equal(response.status, 201);
        assert.deepEqual(applied.at(-1), {action: "enqueue", type: "segment_clean", segment_ids: ["1"], iterations: 2});
    });

    await t.test("removes, reorders and clears commands", async () => {
        assert.equal((await put({action: "remove", id: "abc"})).status, 200);
        assert.equal((await put({action: "reorder", ids: ["abc"]})).status, 200);
        assert.equal((await put({action: "clear"})).status, 200);
    });

    await t.test("rejects malformed requests before dispatching", async () => {
        const count = applied.length;
        for (const body of [{}, {action: "nonsense"}, {action: "enqueue", type: "go_to"}, {action: "remove"}]) {
            assert.equal((await put(body)).status, 400);
        }
        assert.equal(applied.length, count);
    });
});
