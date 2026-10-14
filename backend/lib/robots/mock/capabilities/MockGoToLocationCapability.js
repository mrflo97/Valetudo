const GoToLocationCapability = require("../../../core/capabilities/GoToLocationCapability");
const stateAttrs = require("../../../entities/state/attributes");
const {PointMapEntity, PathMapEntity} = require("../../../entities/map");

/**
 * @extends GoToLocationCapability<import("../MockValetudoRobot")>
 */
class MockGoToLocationCapability extends GoToLocationCapability {
    /**
     * @param {import("../../../entities/core/ValetudoGoToLocation")} valetudoGoToLocation
     * @returns {Promise<void>}
     */
    async goTo(valetudoGoToLocation) {
        let map = this.robot.state.map;
        let robotEntity = map.entities.find(e => {
            return e.type === PointMapEntity.TYPE.ROBOT_POSITION;
        });

        let predictedPath = new PathMapEntity({
            type: PathMapEntity.TYPE.PREDICTED_PATH,
            points: [
                robotEntity.points[0], robotEntity.points[1],
                valetudoGoToLocation.coordinates.x, valetudoGoToLocation.coordinates.y]
        });
        map.addEntity(predictedPath);
        this.robot.emitMapUpdated();

        let path = map.entities.find(e => {
            return e.type === PathMapEntity.TYPE.PATH;
        });
        if (!path) {
            path = new PathMapEntity({
                type: PathMapEntity.TYPE.PATH,
                points: [robotEntity.points[0], robotEntity.points[1]]
            });
            map.addEntity(path);
        }

        this.setStatus(stateAttrs.StatusStateAttribute.VALUE.MOVING);

        setTimeout(() => {
            map.entities.splice(map.entities.indexOf(predictedPath), 1);
            path.points.push(valetudoGoToLocation.coordinates.x, valetudoGoToLocation.coordinates.y);
            robotEntity.points = [valetudoGoToLocation.coordinates.x, valetudoGoToLocation.coordinates.y];
            this.robot.emitMapUpdated();

            this.setStatus(stateAttrs.StatusStateAttribute.VALUE.IDLE);
        }, 2000);
    }

    /**
     * @private
     * @param {string} value
     */
    setStatus(value) {
        const statusStateAttr = this.robot.state.getFirstMatchingAttribute({
            attributeClass: stateAttrs.StatusStateAttribute.name
        });

        if (statusStateAttr) {
            statusStateAttr.value = value;
            this.robot.emitStateAttributesUpdated();
        }
    }
}

module.exports = MockGoToLocationCapability;
