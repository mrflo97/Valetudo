const ComponentType = require("../homeassistant/ComponentType");
const crc = require("crc");
const DataType = require("../homie/DataType");
const fs = require("fs");
const InLineHassComponent = require("../homeassistant/components/InLineHassComponent");
const Logger = require("../../Logger");
const NodeMqttHandle = require("./NodeMqttHandle");
const path = require("path");
const PropertyMqttHandle = require("./PropertyMqttHandle");
const zlib = require("zlib");

class MapNodeMqttHandle extends NodeMqttHandle {
    /**
     * @param {object} options
     * @param {import("./RobotMqttHandle")} options.parent}
     * @param {import("../MqttController")} options.controller MqttController instance
     * @param {import("../../core/ValetudoRobot")} options.robot
     */
    constructor(options) {
        super(Object.assign(options, {
            topicName: "MapData",
            friendlyName: "Map data",
            type: "Map"
        }));
        this.robot = options.robot;

        this.registerChild(
            new PropertyMqttHandle({
                parent: this,
                controller: this.controller,
                topicName: "map-data",
                friendlyName: "Raw map data",
                datatype: DataType.STRING,
                getter: async () => await this.getMapData(false)
            })
        );

        // Add "I Can't Believe It's Not Valetudo" map property. Unlike Home Assistant, Homie autodiscovery attributes
        // may not be changed by external services, so for proper autodiscovery support it needs to be provided by
        // Valetudo itself. ICBINV may publish the data at any point in time.
        if (this.controller.homieAddICBINVMapProperty) {
            this.registerChild(
                new PropertyMqttHandle({
                    parent: this,
                    controller: this.controller,
                    topicName: "map",
                    friendlyName: "Map",
                    datatype: DataType.STRING,
                    getter: async () => {
                    },
                })
            );
        }

        this.controller.withHass((hass) => {
            this.registerChild(
                new PropertyMqttHandle({
                    parent: this,
                    controller: this.controller,
                    topicName: "map-data-hass-hack",
                    friendlyName: "Raw map data with Home Assistant hack",
                    datatype: DataType.STRING,
                    getter: async () => await this.getMapData(true)
                }).also((prop) => {
                    prop.attachHomeAssistantComponent(
                        new InLineHassComponent({
                            hass: hass,
                            robot: this.robot,
                            name: "MapData",
                            friendlyName: "Map data",
                            componentType: ComponentType.CAMERA,
                            autoconf: {
                                topic: prop.getBaseTopic()
                            }
                        })
                    );
                })
            );
        });
    }

    /**
     * Called by MqttController on map updated.
     *
     * @public
     */
    onMapUpdated() {
        if (this.controller.isInitialized()) {
            this.refresh().then();
        }
    }

    /**
     * @private
     * @param {boolean} mapHack
     * @return {Promise<Buffer|null>}
     */
    async getMapData(mapHack) {
        if (this.robot.state.map === null || !this.controller.provideMapData || !this.controller.isInitialized()) {
            return null;
        }
        const robot = this.robot;

        const promise = new Promise((resolve, reject) => {
            zlib.deflate(JSON.stringify(robot.state.map), (err, buf) => {
                if (err !== null) {
                    return reject(err);
                }
                let payload;

                if (mapHack) {
                    const length = Buffer.alloc(4);
                    const checksum = Buffer.alloc(4);

                    const textChunkData = Buffer.concat([
                        HOMEASSISTANT_MAP_HACK.TEXT_CHUNK_TYPE,
                        HOMEASSISTANT_MAP_HACK.TEXT_CHUNK_METADATA,
                        buf
                    ]);

                    length.writeInt32BE(HOMEASSISTANT_MAP_HACK.TEXT_CHUNK_METADATA.length + buf.length, 0);
                    checksum.writeUInt32BE(crc.crc32(textChunkData), 0);


                    payload = Buffer.concat([
                        HOMEASSISTANT_MAP_HACK.IMAGE_WITHOUT_END_CHUNK,
                        length,
                        textChunkData,
                        checksum,
                        HOMEASSISTANT_MAP_HACK.END_CHUNK
                    ]);
                } else {
                    payload = buf;
                }

                resolve(payload);
            });
        });

        try {
            return await promise;
        } catch (err) {
            Logger.error("Error while deflating map data for mqtt publish", err);
        }
        return null;
    }


}


const HOMEASSISTANT_MAP_HACK = {
    TEXT_CHUNK_TYPE: Buffer.from("zTXt"),
    TEXT_CHUNK_METADATA: Buffer.from("ValetudoMap\0\0"),
    IMAGE: fs.readFileSync(path.join(__dirname, "../../res/valetudo_home_assistant_mqtt_camera_hack.png"))
};
HOMEASSISTANT_MAP_HACK.IMAGE_WITHOUT_END_CHUNK = HOMEASSISTANT_MAP_HACK.IMAGE.slice(0, HOMEASSISTANT_MAP_HACK.IMAGE.length - 12);
//The PNG IEND chunk is always the last chunk and consists of a 4-byte length, the 4-byte chunk type, 0-byte chunk data and a 4-byte crc
HOMEASSISTANT_MAP_HACK.END_CHUNK = HOMEASSISTANT_MAP_HACK.IMAGE.slice(HOMEASSISTANT_MAP_HACK.IMAGE.length - 12);

module.exports = MapNodeMqttHandle;