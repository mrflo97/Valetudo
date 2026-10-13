const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PersistData = require("./PersistData");

const pending = new Set(["prepared", "original_moved", "installed", "rebooting", "failed"]);
const hash = buffer => crypto.createHash("sha256").update(buffer).digest("hex");
const exists = filename => fs.existsSync(filename);

async function atomicJSON(filename, value) {
    const tmp = filename + ".tmp";
    const handle = await fs.promises.open(tmp, "w", 0o600);
    try {
        await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
        await handle.sync();
    } finally {
        await handle.close();
    }
    await fs.promises.rename(tmp, filename);
    await syncDirectory(path.dirname(filename));
}

async function syncDirectory(directory) {
    const handle = await fs.promises.open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function readJSON(filename, fallback) {
    return exists(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : fallback;
}

async function inventory(directory, prefix = "") {
    const result = [];
    const names = (await fs.promises.readdir(path.join(directory, prefix))).sort();
    for (const name of names) {
        if (!prefix && name === "rrlog") {
            continue;
        }
        const relative = path.join(prefix, name);
        const filename = path.join(directory, relative);
        const stat = await fs.promises.lstat(filename);
        if (!stat.isDirectory() && !stat.isFile()) {
            throw new Error(`Backup cannot copy special file or symlink: ${relative}`);
        }
        const entry = {path: relative, directory: stat.isDirectory(), mode: stat.mode & 0o7777,
            uid: stat.uid, gid: stat.gid, bytes: stat.isFile() ? stat.size : 0,
            sha256: stat.isFile() ? hash(await fs.promises.readFile(filename)) : null};
        result.push(entry);
        if (stat.isDirectory()) {
            result.push(...await inventory(directory, relative));
        }
    }
    return result;
}

async function copyTree(source, destination, entries) {
    const sourceStat = await fs.promises.stat(source);
    await fs.promises.mkdir(destination, {mode: sourceStat.mode & 0o7777});
    for (const entry of entries) {
        const target = path.join(destination, entry.path);
        if (entry.directory) {
            await fs.promises.mkdir(target, {mode: entry.mode});
        } else {
            await fs.promises.copyFile(path.join(source, entry.path), target, fs.constants.COPYFILE_EXCL);
            const handle = await fs.promises.open(target, "r");
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
        }
        await fs.promises.chmod(target, entry.mode);
        if (process.getuid?.() === 0) {
            await fs.promises.chown(target, entry.uid, entry.gid);
        }
    }
    if (process.getuid?.() === 0) {
        await fs.promises.chown(destination, sourceStat.uid, sourceStat.gid);
    }
    await fs.promises.chmod(destination, sourceStat.mode & 0o7777);
    await syncDirectory(destination);
}

function activeMap(directory) {
    const config = fs.readFileSync(path.join(directory, "slam_info.cfg"), "utf8");
    const maps = [...config.matchAll(/Map(-?\d+)\s*:\s*\{([^}]*)\}/g)]
        .filter(match => /\bUsing\s*=\s*1\s*;/.test(match[2]));
    if (maps.length !== 1 || Number(maps[0][1]) < 0) {
        throw new Error("A single saved active map is required");
    }
    return Number(maps[0][1]);
}

class MapStore {
    /**
     * @param {object} options
     * @param {string} options.dataDirectory
     * @param {string} options.bootId
     * @param {() => Promise<object>} options.profile
     * @param {() => Promise<void>} options.assertIdle
     * @param {(operation: any) => Promise<void>} options.verifyRuntime
     */
    constructor(options) {
        this.options = options;
        this.live = path.join(options.dataDirectory, "rockrobo");
        this.root = path.join(options.dataDirectory, "valetudo-s7-maps");
        this.busy = false;
        this.reconciling = null;
        this.operation = readJSON(path.join(this.root, "operation.json"), null);
        this.slots = readJSON(path.join(this.root, "slots.json"), {});
    }

    isBlocked() {
        return this.busy || !!(this.operation && pending.has(this.operation.status));
    }

    async reconcile() {
        if (this.reconciling) {
            return this.reconciling;
        }
        this.reconciling = this.reconcileOperation();
        try {
            await this.reconciling;
        } finally {
            this.reconciling = null;
        }
    }

    async reconcileOperation() {
        if (this.busy || !this.operation || !pending.has(this.operation.status) || this.operation.status === "failed" ||
            this.operation.bootId === this.options.bootId || os.uptime() < 20) {
            return;
        }
        try {
            if (this.operation.status === "prepared" && exists(this.live) && !exists(this.objectPath(this.operation.recoveryId))) {
                await this.record({...this.operation, status: "aborted", error: "The operation stopped before directory replacement."});
                return;
            }
            if (!["installed", "rebooting"].includes(this.operation.status)) {
                throw new Error("Restore was interrupted. Use the retained recovery copy.");
            }
            if (activeMap(this.live) !== this.operation.mapId) {
                throw new Error("The active map does not match the restore request");
            }
            for (const entry of this.operation.expected) {
                if (hash(await fs.promises.readFile(path.join(this.live, entry.path))) !== entry.sha256) {
                    throw new Error(`Restored map verification failed: ${entry.path}`);
                }
            }
            await this.options.verifyRuntime(this.operation);
            await this.record({...this.operation, status: "verified", error: null});
        } catch (error) {
            if (os.uptime() < 90) {
                return;
            }
            await this.record({...this.operation, status: "failed", error: error.message});
        }
    }

    async record(operation) {
        await fs.promises.mkdir(this.root, {recursive: true, mode: 0o700});
        await atomicJSON(path.join(this.root, "operation.json"), operation);
        this.operation = operation;
    }

    async exclusive(action, allowRecovery = false) {
        await this.reconcile();
        if (this.busy || (!allowRecovery && this.isBlocked())) {
            throw new Error("Another map operation needs to finish or be recovered first");
        }
        this.busy = true;
        try {
            await this.options.assertIdle();
            await fs.promises.mkdir(this.root, {recursive: true, mode: 0o700});
            return await action();
        } finally {
            this.busy = false;
        }
    }

    async checkSpace(entries) {
        const stat = await fs.promises.statfs(this.root);
        const bytes = entries.reduce((sum, entry) => sum + entry.bytes + 4096, 0);
        if (stat.bavail * stat.bsize < bytes + 4 * 1024 * 1024) {
            throw new Error("Not enough free space for a staged map copy and 4 MiB reserve");
        }
    }

    async snapshot(source, destination) {
        const before = await inventory(source);
        await this.checkSpace(before);
        await copyTree(source, destination, before);
        const after = await inventory(source);
        const copied = await inventory(destination);
        if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(copied)) {
            throw new Error("Map files changed during copying; retry while the robot is idle");
        }
        activeMap(destination);
        return copied;
    }

    validateSlot(slot) {
        if (slot !== "a" && slot !== "b") {
            throw new Error("Unknown map slot");
        }
    }

    objectPath(id) {
        if (!/^[a-f0-9-]{36}$/.test(id)) {
            throw new Error("Invalid backup identifier");
        }
        return path.join(this.root, id);
    }

    async save(slot, name, preview) {
        this.validateSlot(slot);
        if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 48) {
            throw new Error("Enter a backup name between 1 and 48 characters");
        }
        return this.exclusive(async () => {
            const id = crypto.randomUUID();
            const destination = this.objectPath(id);
            await fs.promises.mkdir(destination, {mode: 0o700});
            let committed = false;
            try {
                const profile = await this.options.profile();
                const entries = await this.snapshot(this.live, path.join(destination, "rockrobo"));
                const manifest = {format: 1, id: id, name: name.trim(), createdAt: new Date().toISOString(),
                    profile: profile, mapId: activeMap(path.join(destination, "rockrobo")), entries: entries,
                    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0)};
                await atomicJSON(path.join(destination, "manifest.json"), manifest);
                await atomicJSON(path.join(destination, "preview.json"), preview);
                const previous = this.slots[slot];
                const slots = {...this.slots, [slot]: id};
                await atomicJSON(path.join(this.root, "slots.json"), slots);
                this.slots = slots;
                committed = true;
                if (previous) {
                    await fs.promises.rm(this.objectPath(previous), {recursive: true, force: true});
                }
                return manifest;
            } finally {
                if (!committed) {
                    await fs.promises.rm(destination, {recursive: true, force: true});
                }
            }
        });
    }

    getSlot(slot) {
        this.validateSlot(slot);
        const id = this.slots[slot];
        if (!id) {
            return null;
        }
        return readJSON(path.join(this.objectPath(id), "manifest.json"), null);
    }

    getPreview(slot) {
        const manifest = this.getSlot(slot);
        if (!manifest) {
            throw new Error("This map slot is empty");
        }
        return readJSON(path.join(this.objectPath(manifest.id), "preview.json"), null);
    }

    async restore(slot, expectedId) {
        return this.exclusive(async () => {
            const manifest = this.getSlot(slot);
            if (!manifest || manifest.id !== expectedId) {
                throw new Error("The saved map changed; reopen its preview");
            }
            if (JSON.stringify(manifest.profile) !== JSON.stringify(await this.options.profile())) {
                throw new Error("Backup belongs to a different robot or firmware profile");
            }
            const source = path.join(this.objectPath(manifest.id), "rockrobo");
            if (JSON.stringify(await inventory(source)) !== JSON.stringify(manifest.entries)) {
                throw new Error("Backup integrity check failed");
            }
            return this.install(source, "restore", manifest.name);
        });
    }

    async recover() {
        return this.exclusive(async () => {
            if (!this.operation?.recoveryId || !exists(this.objectPath(this.operation.recoveryId))) {
                throw new Error("No recovery directory is available");
            }
            return this.install(this.objectPath(this.operation.recoveryId), "recovery", "Previous state");
        }, true);
    }

    async install(source, kind, name, edit = null) {
        const stageId = crypto.randomUUID();
        const recoveryId = crypto.randomUUID();
        const stage = this.objectPath(stageId);
        const oldRecoveryId = this.operation?.recoveryId;
        const previousOperation = this.operation;
        const entries = await this.snapshot(source, stage).catch(async error => {
            await fs.promises.rm(stage, {recursive: true, force: true});
            throw error;
        });
        let renamed = false;
        let installed = false;
        try {
            if (edit) {
                await edit(stage);
            }
            const mapId = activeMap(stage);
            const expected = (edit ? await inventory(stage) : entries).filter(entry =>
                !entry.directory && /^(PersistData_-?\d+\.data|last_map|user_map\d+|SharedMultiMapInfo)$/.test(entry.path));
            const pose = PersistData.parse(await fs.promises.readFile(path.join(stage, `PersistData_${mapId}.data`))).pose;
            await this.options.assertIdle();
            if (source === this.live && JSON.stringify(await inventory(source)) !== JSON.stringify(entries)) {
                throw new Error("Map changed before installation; reopen the editor");
            }
            await this.record({id: crypto.randomUUID(), kind: kind, name: name, status: "prepared",
                bootId: this.options.bootId, stageId: stageId, recoveryId: recoveryId,
                mapId: mapId, pose: pose, expected: expected, error: null, createdAt: new Date().toISOString()});
            await fs.promises.rename(this.live, this.objectPath(recoveryId));
            renamed = true;
            await syncDirectory(this.options.dataDirectory);
            await syncDirectory(this.root);
            await this.record({...this.operation, status: "original_moved"});
            await fs.promises.rename(stage, this.live);
            installed = true;
            await syncDirectory(this.options.dataDirectory);
            await syncDirectory(this.root);
            await this.record({...this.operation, status: "installed", applied: true});
            // The old recovery copy can be released only after the new one is durable.
            if (oldRecoveryId && oldRecoveryId !== recoveryId) {
                await fs.promises.rm(this.objectPath(oldRecoveryId), {recursive: true, force: true});
            }
            return this.operation;
        } catch (error) {
            if (renamed && !exists(this.live)) {
                await fs.promises.rename(this.objectPath(recoveryId), this.live);
                await syncDirectory(this.options.dataDirectory);
            }
            if (this.operation?.stageId === stageId) {
                if (!installed && !exists(this.objectPath(recoveryId))) {
                    await this.record(previousOperation);
                } else {
                    await this.record({...this.operation, status: "failed", applied: installed, error: error.message});
                }
            }
            throw error;
        } finally {
            if (exists(stage)) {
                await fs.promises.rm(stage, {recursive: true, force: true});
            }
        }
    }

    dock() {
        const mapId = activeMap(this.live);
        const source = fs.readFileSync(path.join(this.live, `PersistData_${mapId}.data`));
        const pose = PersistData.parse(source).pose;
        return {mapId: mapId, token: hash(source), pose: pose,
            mapPosition: {x: (pose.x + 25600) / 10, y: (25600 - pose.y) / 10}};
    }

    async moveDock(token, mapId, dx, dy, rotation = 0) {
        return this.exclusive(async () => {
            const current = this.dock();
            if (current.token !== token || current.mapId !== mapId) {
                throw new Error("Map changed since preview; reopen the dock editor");
            }
            if (![dx, dy].every(value => Number.isFinite(value) && Math.abs(value) <= 5120)) {
                throw new Error("Invalid dock displacement");
            }
            const dxMM = Math.round(dx * 10);
            const dyMM = -Math.round(dy * 10);
            const filename = `PersistData_${mapId}.data`;
            const source = await fs.promises.readFile(path.join(this.live, filename));
            if (hash(source) !== token) {
                throw new Error("Map changed during dock preparation");
            }
            const edited = PersistData.moveDock(source, dxMM, dyMM, rotation);
            if (edited.equals(source)) {
                return {status: "unchanged"};
            }
            return this.install(this.live, "dock", "Dock position and orientation", async stage => {
                const copied = await fs.promises.readFile(path.join(stage, filename));
                if (hash(copied) !== token || this.dock().token !== token) {
                    throw new Error("Map changed during dock preparation");
                }
                const handle = await fs.promises.open(path.join(stage, filename), "w");
                try {
                    await handle.writeFile(edited);
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            });
        });
    }
}

module.exports = MapStore;
