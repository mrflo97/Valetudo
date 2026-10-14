const CapabilityRouter = require("./CapabilityRouter");

class BasicControlCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        const methodMap = {
            "start": () => {
                const commandQueue = this.getCommandQueue();

                // "start" also resumes a paused clean. That has to happen immediately,
                // so it is never queued.
                if (commandQueue && !this.isPaused()) {
                    return commandQueue.enqueueFullClean();
                }

                return this.capability.start();
            },
            "stop": async () => {
                // Stopping the robot invalidates the queue.
                this.getCommandQueue()?.cancelAll();

                return this.capability.stop();
            },
            "pause": () => {
                return this.capability.pause();
            },
            "home": () => {
                const commandQueue = this.getCommandQueue();

                if (commandQueue && !this.isPaused()) {
                    return commandQueue.enqueueHome();
                }

                return this.capability.home();
            }
        };

        this.router.put("/", this.validator, async (req, res) => {
            const method = methodMap[req.body.action];

            if (method) {
                try {
                    await method();
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

module.exports = BasicControlCapabilityRouter;
