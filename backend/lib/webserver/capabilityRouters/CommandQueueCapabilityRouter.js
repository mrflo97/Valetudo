const CapabilityRouter = require("./CapabilityRouter");
const {SSEHub, SSEMiddleware} = require("../middlewares/sse");

class CommandQueueCapabilityRouter extends CapabilityRouter {
    preInit() {
        this.sseHub = new SSEHub({name: "CommandQueue"});

        this.capability.onQueueUpdated((state) => {
            this.sseHub.event("CommandQueueUpdated", JSON.stringify(state));
        });
    }

    initRoutes() {
        this.router.get("/", (req, res) => {
            res.json(this.capability.getState());
        });

        this.router.get(
            "/sse",
            SSEMiddleware({
                hub: this.sseHub,
                keepAliveInterval: 5000,
                maxClients: 5
            }),
            (req, res) => {
                //Intentional, as the response will be handled by the SSEMiddleware
            }
        );

        this.router.put("/", this.validator, async (req, res) => {
            try {
                this.capability.applyAction(req.body);

                res.status(req.body.action === "enqueue" ? 201 : 200).send();
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });
    }
}

module.exports = CommandQueueCapabilityRouter;
