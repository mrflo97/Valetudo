const Capability = require("./Capability");

/** @template {import("../ValetudoRobot")} T @extends Capability<T> */
class S7MapToolsCapability extends Capability {
    getType() {
        return S7MapToolsCapability.TYPE;
    }
}

S7MapToolsCapability.TYPE = "S7MapToolsCapability";
module.exports = S7MapToolsCapability;
