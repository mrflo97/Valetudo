const assert = require("node:assert/strict");
const {test} = require("node:test");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const validation = require("openapi-validator-middleware");
const Router = require("../../../../lib/webserver/capabilityRouters/S7MapToolsCapabilityRouter");
const S7 = require("../../../../lib/robots/roborock/RoborockS7ValetudoRobot");

test("S7 map-tools API and command guard", async t => {
    const prefix = "/api/v2/robot/capabilities/S7MapToolsCapability";
    const actions = [];
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "s7-api-test-"));
    await fs.promises.writeFile(path.join(directory, "manifest.json"), JSON.stringify({name: "Test backup"}));
    validation.init({openapi: "3.0.0", info: {title: "S7 API test", version: "1"},
        paths: require("../../../../lib/webserver/capabilityRouters/doc/S7MapToolsCapabilityRouter.openapi.json")});
    const capability = {
        getProperties: () => ({}),
        getState: async () => ({available: true, slots: [{slot: "a", saved: null}, {slot: "b", saved: null}]}),
        action: async body => {
            actions.push(body);
            return {status: body.action === "move_dock" && body.dx === 0 && body.dy === 0 ? "unchanged" : "installed"};
        },
        store: {
            exclusive: async action => action(),
            getSlot: slot => slot === "a" ? {id: "f9d783b3-0018-4b02-8753-5b04c5c3ff01"} : null,
            objectPath: () => directory,
            getPreview: () => ({entities: []})
        }
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
        await fs.promises.rm(directory, {recursive: true, force: true});
    });
    const url = `http://127.0.0.1:${server.address().port}${prefix}`;
    const put = body => fetch(url, {method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});

    await t.test("serves state and distinguishes save/no-op from reboot operations", async () => {
        assert.equal((await (await fetch(url)).json()).slots.length, 2);
        assert.equal((await put({action: "save", slot: "a", name: "Home"})).status, 200);
        assert.equal((await put({action: "restore", slot: "a", id: "f9d783b3-0018-4b02-8753-5b04c5c3ff01"})).status, 202);
        assert.equal((await put({action: "move_dock", token: "a".repeat(64), mapId: 1, dx: 0, dy: 0})).status, 200);
    });

    await t.test("rejects malformed writes before dispatching an action", async () => {
        const count = actions.length;
        for (const body of [{action: "save", slot: "../../escape", name: "Home"},
            {action: "save", slot: "a"}, {action: "recover", path: "/etc"},
            {action: "move_dock", token: "a".repeat(64), mapId: 1, dx: 99999, dy: 0},
            {action: "shell", command: "reboot"}]) {
            assert.equal((await put(body)).status, 400);
        }
        assert.equal(actions.length, count);
    });

    await t.test("streams a complete downloadable backup", async () => {
        const response = await fetch(url + "/slots/a/download");
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-disposition"), /s7-map-a/);
        const archive = zlib.gunzipSync(Buffer.from(await response.arrayBuffer()));
        assert(archive.includes(Buffer.from("Test backup")));
    });

    await t.test("blocks cleaning and map writes while preserving read, pause and stop commands", () => {
        const robot = Object.create(S7.prototype);
        robot.capabilities = {S7MapToolsCapability: {blocksCommands: () => true}};
        robot.dummyCloud = {miioSocket: {connected: false}};
        robot.localSocket = {sendMessage: message => message.method};
        for (const command of ["app_start", "app_charge", "app_goto_target", "set_lab_status", "del_map"]) {
            assert.throws(() => robot.sendCommand(command), /maintenance/);
        }
        for (const command of ["get_status", "app_pause", "app_stop"]) {
            assert.equal(robot.sendCommand(command), command);
        }
    });
});
