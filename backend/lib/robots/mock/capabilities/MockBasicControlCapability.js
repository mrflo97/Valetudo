const BasicControlCapability = require("../../../core/capabilities/BasicControlCapability");
const entities = require("../../../entities");
const stateAttrs = entities.state.attributes;

/**
 * @extends BasicControlCapability<import("../MockValetudoRobot")>
 */
class MockBasicControlCapability extends BasicControlCapability {
    /**
     * @param {object} options
     * @param {import("../MockValetudoRobot")} options.robot
     */
    constructor(options) {
        super(options);

        this.StatusStateAttr = new stateAttrs.StatusStateAttribute({
            value: stateAttrs.StatusStateAttribute.VALUE.DOCKED,
            flag: stateAttrs.StatusStateAttribute.FLAG.NONE
        });
        this.robot.state.upsertFirstMatchingAttribute(this.StatusStateAttr);

        this.BatteryStateAttr = new stateAttrs.BatteryStateAttribute({ level: 100 });
        this.robot.state.upsertFirstMatchingAttribute(this.BatteryStateAttr);
        setInterval(() => {
            if (this.StatusStateAttr.value === stateAttrs.StatusStateAttribute.VALUE.DOCKED && this.BatteryStateAttr.level < 100) {
                this.BatteryStateAttr.level++;
                this.robot.emitStateAttributesUpdated();
            } else if (this.StatusStateAttr.value !== stateAttrs.StatusStateAttribute.VALUE.DOCKED && this.BatteryStateAttr.level > 0) {
                this.BatteryStateAttr.level--;
                this.robot.emitStateAttributesUpdated();
            }
        }, 5 * 1000);
    }

    /**
     * @private
     * @param {string} value
     */
    setStatus(value) {
        if (this.statusTimer) {
            clearTimeout(this.statusTimer);
            this.statusTimer = undefined;
        }

        this.StatusStateAttr.value = value;
        this.robot.emitStateAttributesUpdated();
    }

    /**
     * Simulates a clean that finishes on its own after a while so that a queued command can follow it
     *
     * @private
     * @param {string} value
     * @param {number} delay
     */
    scheduleReturnToDock(value, delay) {
        this.statusTimer = setTimeout(() => {
            this.statusTimer = undefined;

            if (this.StatusStateAttr.value === value) {
                this.setStatus(stateAttrs.StatusStateAttribute.VALUE.DOCKED);
            }
        }, delay);
    }

    async start() {
        this.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        this.scheduleReturnToDock(stateAttrs.StatusStateAttribute.VALUE.CLEANING, 15 * 1000);
    }

    async stop() {
        this.setStatus(stateAttrs.StatusStateAttribute.VALUE.IDLE);
    }

    async pause() {
        this.setStatus(stateAttrs.StatusStateAttribute.VALUE.PAUSED);
    }

    async home() {
        this.setStatus(stateAttrs.StatusStateAttribute.VALUE.RETURNING);
        this.scheduleReturnToDock(stateAttrs.StatusStateAttribute.VALUE.RETURNING, 10 * 1000);
    }
}

module.exports = MockBasicControlCapability;
