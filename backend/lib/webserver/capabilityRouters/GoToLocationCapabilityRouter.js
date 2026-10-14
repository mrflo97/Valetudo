const CapabilityRouter = require("./CapabilityRouter");
const ValetudoGoToLocation = require("../../entities/core/ValetudoGoToLocation");

class GoToLocationCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.put("/", this.validator, async (req, res) => {
            if (req.body.action === "goto" && req.body.coordinates !== undefined) {
                try {
                    const commandQueue = this.getCommandQueue();

                    if (commandQueue) {
                        commandQueue.enqueueGoTo({
                            x: req.body.coordinates.x,
                            y: req.body.coordinates.y
                        });
                    } else {
                        await this.capability.goTo(new ValetudoGoToLocation({
                            coordinates: {
                                x: req.body.coordinates.x,
                                y: req.body.coordinates.y
                            }
                        }));
                    }

                    res.sendStatus(200);
                } catch (e) {
                    this.sendErrorResponse(req, res, e);
                }
            } else {
                res.sendStatus(400);
            }
        });
    }
}

module.exports = GoToLocationCapabilityRouter;
