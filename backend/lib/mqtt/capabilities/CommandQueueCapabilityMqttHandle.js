const CapabilityMqttHandle = require("./CapabilityMqttHandle");
const DataType = require("../homie/DataType");
const Logger = require("../../Logger");
const PropertyMqttHandle = require("../handles/PropertyMqttHandle");

class CommandQueueCapabilityMqttHandle extends CapabilityMqttHandle {
    /**
     * @param {object} options
     * @param {import("../handles/RobotMqttHandle")} options.parent
     * @param {import("../MqttController")} options.controller MqttController instance
     * @param {import("../../core/ValetudoRobot")} options.robot
     * @param {import("../../core/capabilities/CommandQueueCapability")} options.capability
     */
    constructor(options) {
        super(Object.assign(options, {
            friendlyName: "Command queue"
        }));
        this.capability = options.capability;

        this.queueUpdatedUnsubscribe = undefined;

        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: "queue",
            friendlyName: "Command queue",
            datatype: DataType.STRING,
            getter: async () => {
                return JSON.stringify(this.capability.getState());
            },
            helpText: "The current command queue as a JSON object."
        }));

        this.registerChild(new PropertyMqttHandle({
            parent: this,
            controller: this.controller,
            topicName: "command",
            friendlyName: "Queue command",
            datatype: DataType.STRING,
            format: "same json as the REST interface",
            setter: async (value) => {
                const command = JSON.parse(value);

                if (command && typeof command.action === "string") {
                    this.capability.applyAction(command);
                } else {
                    throw new Error("Invalid command queue payload");
                }
            },
            helpText: "This handle accepts a JSON object identical to the one used by the REST API.\n\n" +
                "It can enqueue a new command, remove or reorder queued commands, or clear the queue.\n\n" +
                "Sample payload:\n\n" +
                "```json\n" +
                JSON.stringify({
                    action: "enqueue",
                    type: "segment_clean",
                    segment_ids: [
                        "20",
                        "18"
                    ],
                    iterations: 1
                }, null, 2) +
                "\n```"
        }));
    }

    async configure() {
        await super.configure();

        this.queueUpdatedUnsubscribe = this.capability.onQueueUpdated(() => {
            this.refresh().catch(err => {
                Logger.error("Error during MqttHandle refresh", err);
            });
        });
    }

    async deconfigure(options) {
        if (this.queueUpdatedUnsubscribe) {
            this.queueUpdatedUnsubscribe();
            this.queueUpdatedUnsubscribe = undefined;
        }

        await super.deconfigure(options);
    }
}

CommandQueueCapabilityMqttHandle.OPTIONAL = false;

module.exports = CommandQueueCapabilityMqttHandle;
