const CapabilityRouter = require("./CapabilityRouter");
const {spawn} = require("child_process");

class S7MapToolsCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                res.json(await this.capability.getState());
            } catch (error) {
                this.sendErrorResponse(req, res, error);
            }
        });
        this.router.put("/", this.validator, async (req, res) => {
            try {
                const result = await this.capability.action(req.body);
                res.status(["save"].includes(req.body.action) || result.status === "unchanged" ? 200 : 202).json(result);
            } catch (error) {
                this.sendErrorResponse(req, res, error);
            }
        });
        this.router.get("/slots/:slot/preview", async (req, res) => {
            try {
                res.json(this.capability.store.getPreview(req.params.slot));
            } catch (error) {
                this.sendErrorResponse(req, res, error);
            }
        });
        this.router.get("/slots/:slot/download", async (req, res) => {
            try {
                const store = this.capability.store;
                await store.exclusive(async () => {
                    const saved = store.getSlot(req.params.slot);
                    if (!saved) {
                        throw new Error("This map slot is empty");
                    }
                    const child = spawn("tar", ["-czf", "-", "-C", store.objectPath(saved.id), "."]);
                    res.attachment(`s7-map-${req.params.slot}-${saved.id}.tar.gz`);
                    await new Promise((resolve, reject) => {
                        child.once("error", reject);
                        child.once("close", code => code === 0 ? resolve(null) : reject(new Error("Backup export failed")));
                        res.once("close", () => {
                            if (!res.writableFinished) {
                                child.kill();
                            }
                        });
                        child.stdout.pipe(res);
                        child.stderr.resume();
                    });
                });
            } catch (error) {
                if (!res.headersSent) {
                    this.sendErrorResponse(req, res, error);
                } else {
                    res.destroy(error);
                }
            }
        });
    }
}

module.exports = S7MapToolsCapabilityRouter;
