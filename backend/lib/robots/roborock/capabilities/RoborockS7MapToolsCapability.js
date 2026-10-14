const crypto = require("crypto");
const fs = require("fs");
const Logger = require("../../../Logger");
const MapStore = require("../s7/MapStore");
const S7MapToolsCapability = require("../../../core/capabilities/S7MapToolsCapability");
const StatusStateAttribute = require("../../../entities/state/attributes/StatusStateAttribute");
const Tools = require("../../../utils/Tools");
const {execFile} = require("child_process");
const {promisify} = require("util");

const run = promisify(execFile);

/** @extends S7MapToolsCapability<import("../RoborockS7ValetudoRobot")> */
class RoborockS7MapToolsCapability extends S7MapToolsCapability {
    constructor(options) {
        super(options);
        this.initializationError = null;
        this.rebootScheduled = false;
        try {
            this.store = new MapStore({
                dataDirectory: "/mnt/data",
                bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
                profile: () => this.profile(),
                assertIdle: () => this.assertIdle(),
                verifyRuntime: async operation => {
                    const data = await fs.promises.readFile("/run/shm/SharedMapInfo");
                    if (data.length !== 1306912 || data.readUInt16LE(0x10) !== operation.pose.x ||
                        data.readUInt16LE(0x12) !== operation.pose.y || data.readFloatLE(0x14) !== operation.pose.angle) {
                        throw new Error("The vendor has not loaded the requested dock pose");
                    }
                }
            });
            // Verify after reboot even if nobody opens the map-tools page.
            if (this.store.operation && this.store.operation.bootId !== this.store.options.bootId && this.store.isBlocked()) {
                const timer = setInterval(() => {
                    this.store.reconcile().then(() => {
                        if (!["installed", "rebooting", "prepared", "original_moved"].includes(this.store.operation?.status)) {
                            clearInterval(timer);
                        }
                    }).catch(error => Logger.warn("S7 map verification failed", error));
                }, 5000);
                timer.unref();
            }
        } catch (error) {
            this.initializationError = error.message;
        }
    }

    async profile() {
        if (this.robot.config.get("embedded") !== true || this.robot.getModelName() !== "S7") {
            throw new Error("Map tools require an embedded Roborock S7");
        }
        const firmware = this.robot.getProperties().firmwareVersion;
        const library = crypto.createHash("md5").update(
            await fs.promises.readFile("/opt/rockrobo/cleaner/lib/librobopersist.so")
        ).digest("hex");
        if (firmware !== "1612" || library !== "5089e838b7bf55ffefe4e872c42982a0") {
            throw new Error("Map tools have not been validated for this S7 firmware/library");
        }
        return {model: "S7", systemId: Tools.GET_SYSTEM_ID(), firmware: firmware, persistenceLibrary: library};
    }

    async assertIdle() {
        await this.profile();
        await this.robot.pollState();
        const state = this.robot.state.getFirstMatchingAttributeByConstructor(StatusStateAttribute);
        if (!state || !["docked", "idle"].includes(state.value) || state.flag !== "none") {
            throw new Error("Stop the robot before saving, restoring or editing its map");
        }
    }

    blocksCommands() {
        return this.initializationError !== null || this.store?.isBlocked() === true;
    }

    async getState() {
        if (this.initializationError) {
            return {available: false, error: this.initializationError, slots: []};
        }
        await this.store.reconcile();
        let error = null;
        let dock = null;
        try {
            await this.profile();
        } catch (e) {
            error = e.message;
        }
        let dockError = error;
        if (!error && !this.store.isBlocked()) {
            try {
                dock = this.dockPreview();
            } catch (e) {
                dockError = e.message;
            }
        }
        return {available: error === null, error: error, dockError: dockError, dock: dock,
            blocked: this.store.isBlocked(), operation: this.store.operation,
            recoveryAvailable: !!this.store.operation?.recoveryId &&
                fs.existsSync(this.store.objectPath(this.store.operation.recoveryId)),
            slots: ["a", "b"].map(slot => {
                const saved = this.store.getSlot(slot);
                return {slot: slot, saved: saved ? {id: saved.id, name: saved.name,
                    createdAt: saved.createdAt, bytes: saved.bytes, mapId: saved.mapId} : null};
            })};
    }

    dockPreview() {
        const dock = this.store.dock();
        const charger = this.robot.state.map.entities.find(entity => entity.type === "charger_location");
        if (!charger || Math.abs(charger.points[0] - dock.mapPosition.x) > 1 ||
            Math.abs(charger.points[1] - dock.mapPosition.y) > 1) {
            throw new Error("Wait for a fresh map whose dock matches the saved map");
        }
        if ([dock.pose.x, dock.pose.y].some(value => value < 0 || value > 25600)) {
            throw new Error("This dock is outside the currently supported coordinate range");
        }
        return dock;
    }

    async action(body) {
        if (this.initializationError) {
            throw new Error(this.initializationError);
        }
        await this.profile();
        if (this.rebootScheduled) {
            throw new Error("Reboot is already scheduled; wait for the robot to reconnect");
        }
        switch (body.action) {
            case "save":
                return this.store.save(body.slot, body.name, this.robot.state.map);
            case "restore":
                return this.applyAndReboot(() => this.store.restore(body.slot, body.id));
            case "recover":
                return this.applyAndReboot(() => this.store.recover());
            case "move_dock":
                this.dockPreview();
                return this.applyAndReboot(() => this.store.moveDock(body.token, body.mapId, body.dx, body.dy, body.rotation));
            case "retry_reboot":
                if (!this.store.operation?.applied || !["installed", "rebooting", "failed"].includes(this.store.operation.status)) {
                    throw new Error("There is no applied operation awaiting reboot");
                }
                await this.assertIdle();
                this.scheduleReboot();
                return this.store.operation;
            default:
                throw new Error("Unknown map action");
        }
    }

    async applyAndReboot(action) {
        const result = await action();
        if (result.status !== "unchanged") {
            this.scheduleReboot();
        }
        return result;
    }

    scheduleReboot() {
        if (this.rebootScheduled) {
            return;
        }
        this.rebootScheduled = true;
        setTimeout(async () => {
            try {
                await this.store.record({...this.store.operation, status: "rebooting", error: null,
                    bootId: this.store.options.bootId});
                // These must not rely on PATH: Valetudo's environment may not include /sbin,
                // which is where busybox provides reboot on the S7.
                await run("/bin/sync");
                await run("/sbin/reboot");
            } catch (error) {
                this.rebootScheduled = false;
                await this.store.record({...this.store.operation, status: "failed", error: error.message});
                Logger.error("S7 map operation could not reboot", error);
            }
        }, 750);
    }
}

module.exports = RoborockS7MapToolsCapability;
