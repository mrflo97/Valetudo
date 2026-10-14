const ZoneCleaningCapability = require("../../../core/capabilities/ZoneCleaningCapability");

/**
 * @extends ZoneCleaningCapability<import("../MockValetudoRobot")>
 */
class MockZoneCleaningCapability extends ZoneCleaningCapability {
    async start(options) {
        await this.robot.capabilities.BasicControlCapability.start();
    }

    getProperties() {
        // TODO: implement
        return super.getProperties();
    }
}

module.exports = MockZoneCleaningCapability;
