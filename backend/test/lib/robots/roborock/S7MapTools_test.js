const assert = require("node:assert/strict");
const {describe, it, afterEach} = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const PersistData = require("../../../../lib/robots/roborock/s7/PersistData");
const MapStore = require("../../../../lib/robots/roborock/s7/MapStore");

function varint(value) {
    const bytes = [];
    do {
        const byte = value % 128;
        value = Math.floor(value / 128);
        bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return Buffer.from(bytes);
}

function field(number, value) {
    return Buffer.isBuffer(value) ? Buffer.concat([varint(number * 8 + 2), varint(value.length), value]) :
        Buffer.concat([varint(number * 8), varint(value)]);
}

function container(x = 5439, y = 4073) {
    return Buffer.concat([field(10, Buffer.alloc(0)), ...[1306912, 9312, 1184780, 131080, 262168, 90008].map((size, index) => {
        const payload = Buffer.alloc(size);
        if (index === 0) {
            payload.writeUInt16LE(x, 0x10);
            payload.writeUInt16LE(y, 0x12);
            payload.writeFloatLE(-1.5744379758834839, 0x14);
        }
        return field(20, Buffer.concat([field(10, index === 0 ? 5 : index + 10), field(20, 1), field(30, 1),
            field(40, size), field(99, Buffer.from("unknown preserved metadata")), field(50, zlib.deflateSync(payload))]));
    })]);
}

describe("S7 persistence editor", () => {
    it("changes only X/Y payload bytes while retaining angle, unknown fields and other chunks", () => {
        const original = container();
        const edited = PersistData.moveDock(original, 300, -75);
        const before = PersistData.parse(original);
        const after = PersistData.parse(edited);
        assert.equal(after.pose.x, 5739);
        assert.equal(after.pose.y, 3998);
        assert.equal(after.pose.angle, before.pose.angle);
        const expected = Buffer.from(before.payload);
        expected.writeUInt16LE(5739, 0x10);
        expected.writeUInt16LE(3998, 0x12);
        assert.deepEqual(after.payload, expected);
        assert.deepEqual(edited.subarray(after.outer.end), original.subarray(before.outer.end));
        assert(edited.includes(Buffer.from("unknown preserved metadata")));
    });

    it("makes a no-op byte-identical and rejects unknown coordinate ranges", () => {
        const original = container();
        assert.deepEqual(PersistData.moveDock(original, 0, 0), original);
        assert.throws(() => PersistData.moveDock(original, -6000, 0), /coordinate range/);
        assert.throws(() => PersistData.moveDock(original, NaN, 0), /millimetres/);
    });

    it("rejects truncated, corrupt and oversized containers", () => {
        const original = container();
        assert.throws(() => PersistData.parse(original.subarray(0, original.length - 1)));
        const corrupt = Buffer.from(original);
        corrupt[PersistData.parse(original).outer.end - 1] ^= 255;
        assert.throws(() => PersistData.parse(corrupt));
        assert.throws(() => PersistData.parse(Buffer.alloc(3 * 1024 * 1024)));
    });

    it("round-trips the captured S7 containers and reproduces the demonstrated X edit", {
        skip: !process.env.S7_FIXTURE_DIRECTORY
    }, () => {
        const directory = process.env.S7_FIXTURE_DIRECTORY;
        for (const id of [1, 2, 6]) {
            const original = fs.readFileSync(path.join(directory, `PersistData_${id}.data`));
            assert.deepEqual(PersistData.moveDock(original, 0, 0), original);
        }
        const original = fs.readFileSync(path.join(directory, "PersistData_1.data"));
        const historical = fs.readFileSync(path.join(directory, "PersistData_1.modified_candidate.data"));
        const edited = PersistData.moveDock(original, 300, 0);
        assert.deepEqual(PersistData.parse(edited).payload, PersistData.parse(historical).payload);
        assert.equal(PersistData.parse(edited).pose.x, 5739);
        const oldChunk = PersistData.parse(original);
        const newChunk = PersistData.parse(edited);
        assert.deepEqual(original.subarray(oldChunk.outer.end), edited.subarray(newChunk.outer.end));
    });
});

describe("S7 whole-directory backups", () => {
    const directories = [];
    afterEach(async () => {
        for (const directory of directories.splice(0)) {
            await fs.promises.rm(directory, {recursive: true, force: true});
        }
    });

    async function fixture(overrides = {}) {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "s7-maps-test-"));
        directories.push(directory);
        const live = path.join(directory, "rockrobo");
        await fs.promises.mkdir(path.join(live, "rrlog"), {recursive: true});
        await fs.promises.mkdir(path.join(live, "nested"));
        await fs.promises.writeFile(path.join(live, "rrlog", "ignored.log"), "do not copy");
        await fs.promises.writeFile(path.join(live, "nested", "settings"), "original settings", {mode: 0o640});
        await fs.promises.writeFile(path.join(live, "last_map"), "original raster");
        await fs.promises.writeFile(path.join(live, "slam_info.cfg"), "Map1 : { Using = 1; }; Map2 : { Using = 0; };");
        await fs.promises.writeFile(path.join(live, "PersistData_1.data"), container());
        const options = {dataDirectory: directory, bootId: "boot-one", profile: async () => ({model: "S7", firmware: "1612"}),
            assertIdle: async () => {}, verifyRuntime: async () => {}, ...overrides};
        return {store: new MapStore(options), options: options, directory: directory, live: live};
    }

    it("saves two independent immutable slots without rrlog and restores the complete directory", async () => {
        const {store, options, live} = await fixture();
        const a = await store.save("a", "Original", {entities: []});
        assert.equal(fs.existsSync(path.join(store.objectPath(a.id), "rockrobo/rrlog")), false);
        await fs.promises.writeFile(path.join(live, "nested/settings"), "second settings");
        const b = await store.save("b", "Second", {entities: []});
        await fs.promises.writeFile(path.join(live, "extra"), "current-only file");
        await store.restore("a", a.id);
        assert.equal(fs.readFileSync(path.join(live, "nested/settings"), "utf8"), "original settings");
        assert.equal(fs.existsSync(path.join(live, "extra")), false);
        assert.equal(fs.existsSync(path.join(store.objectPath(store.operation.recoveryId), "extra")), true);
        assert.equal(store.getSlot("b").id, b.id);
        assert.equal(store.isBlocked(), true);
        await assert.rejects(() => store.save("a", "No", {}), /finish or be recovered/);
        const restarted = new MapStore({...options, bootId: "boot-two"});
        await restarted.reconcile();
        assert.equal(restarted.operation.status, "verified");
        assert.equal(restarted.isBlocked(), false);
        await restarted.recover();
        assert.equal(fs.readFileSync(path.join(live, "nested/settings"), "utf8"), "second settings");
        assert.equal(fs.existsSync(path.join(live, "extra")), true);
    });

    it("rejects modified backups, changed firmware and stale slot IDs before replacing live files", async () => {
        const {store, live} = await fixture();
        const a = await store.save("a", "Original", {});
        await assert.rejects(() => store.restore("a", "stale"), /changed/);
        store.options.profile = async () => ({model: "S7", firmware: "other"});
        await assert.rejects(() => store.restore("a", a.id), /different robot or firmware/);
        store.options.profile = async () => ({model: "S7", firmware: "1612"});
        await fs.promises.writeFile(path.join(store.objectPath(a.id), "rockrobo/last_map"), "corrupt");
        await assert.rejects(() => store.restore("a", a.id), /integrity/);
        assert.equal(fs.readFileSync(path.join(live, "last_map"), "utf8"), "original raster");
    });

    it("preserves exact pose for no-op and rejects a stale dock source", async () => {
        const {store, live} = await fixture();
        const dock = store.dock();
        const original = fs.readFileSync(path.join(live, "PersistData_1.data"));
        assert.deepEqual(await store.moveDock(dock.token, dock.mapId, 0, 0), {status: "unchanged"});
        assert.deepEqual(fs.readFileSync(path.join(live, "PersistData_1.data")), original);
        await fs.promises.writeFile(path.join(live, "PersistData_1.data"), container(5441));
        await assert.rejects(() => store.moveDock(dock.token, dock.mapId, 30, 0), /changed since preview/);
        const fresh = store.dock();
        await store.moveDock(fresh.token, fresh.mapId, 30, 10);
        assert.equal(store.dock().pose.x, 5741);
        assert.equal(store.dock().pose.y, 3973);
        assert.equal(fs.existsSync(path.join(store.objectPath(store.operation.recoveryId), "rrlog/ignored.log")), true);
    });

    it("rejects symlinks, invalid slots, active cleaning and insufficient disk space", async () => {
        const {store, live} = await fixture();
        await assert.rejects(() => store.save("../escape", "No", {}), /Unknown map slot/);
        await fs.promises.symlink("last_map", path.join(live, "link"));
        await assert.rejects(() => store.save("a", "No", {}), /symlink/);
        await fs.promises.unlink(path.join(live, "link"));
        store.options.assertIdle = async () => {
            throw new Error("cleaning");
        };
        await assert.rejects(() => store.save("a", "No", {}), /cleaning/);
        store.options.assertIdle = async () => {};
        const originalStatfs = fs.promises.statfs;
        fs.promises.statfs = async () => ({bavail: 0, bsize: 4096});
        try {
            await assert.rejects(() => store.save("a", "No", {}), /free space/);
        } finally {
            fs.promises.statfs = originalStatfs;
        }
        assert.equal(store.getSlot("a"), null);
    });

    it("keeps a failed postboot verification blocked and retains recovery", async () => {
        const {store, options, live} = await fixture();
        const a = await store.save("a", "Original", {});
        await store.restore("a", a.id);
        await fs.promises.writeFile(path.join(live, "last_map"), "firmware overwrote the map");
        const restarted = new MapStore({...options, bootId: "boot-two"});
        await restarted.reconcile();
        assert.equal(restarted.operation.status, "failed");
        assert.equal(restarted.isBlocked(), true);
        assert.match(restarted.operation.error, /verification failed/);
        assert(fs.existsSync(restarted.objectPath(restarted.operation.recoveryId)));
        const originalError = restarted.operation.error;
        await restarted.reconcile();
        assert.equal(restarted.operation.error, originalError);
    });

    it("rolls back an install failure between the two directory renames", async () => {
        const {store, live} = await fixture();
        const a = await store.save("a", "Original", {});
        await fs.promises.writeFile(path.join(live, "last_map"), "new raster");
        const rename = fs.promises.rename;
        let injected = false;
        fs.promises.rename = async (source, target) => {
            if (target === live && !injected) {
                injected = true;
                throw new Error("simulated rename failure");
            }
            return rename(source, target);
        };
        try {
            await assert.rejects(() => store.restore("a", a.id), /simulated/);
        } finally {
            fs.promises.rename = rename;
        }
        assert.equal(fs.readFileSync(path.join(live, "last_map"), "utf8"), "new raster");
        assert.equal(store.isBlocked(), false);
        assert.equal(store.getSlot("a").id, a.id);
    });

    it("rejects source changes before installation and preserves the previous slot on failed save", async () => {
        const {store, live} = await fixture();
        const a = await store.save("a", "Original", {});
        let checks = 0;
        store.options.assertIdle = async () => {
            if (++checks === 2) {
                await fs.promises.writeFile(path.join(live, "last_map"), "changed during staging");
            }
        };
        const dock = store.dock();
        await assert.rejects(() => store.moveDock(dock.token, dock.mapId, 30, 0), /changed before installation/);
        assert.equal(store.dock().pose.x, dock.pose.x);
        assert.equal(store.isBlocked(), false);
        store.checkSpace = async () => {
            throw new Error("not enough space");
        };
        await assert.rejects(() => store.save("a", "Replacement", {}), /not enough space/);
        assert.equal(store.getSlot("a").id, a.id);
    });
});
