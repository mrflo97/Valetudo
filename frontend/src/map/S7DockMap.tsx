import React from "react";
import BaseMap, {MapContainer, MapProps, MapState} from "./BaseMap";
import S7DockClientStructure from "./structures/client_structures/S7DockClientStructure";
import {S7DockPreview} from "../api/s7MapTools";

interface Props extends MapProps {
    dock: S7DockPreview;
    rotation: number;
    onChange: (dx: number, dy: number) => void;
    onRotate: (rotation: number) => void;
}

class S7DockMap extends BaseMap<Props, MapState> {
    private readonly dockMarker: S7DockClientStructure;

    constructor(props: Props) {
        super(props);
        const {x, y} = props.dock.mapPosition;
        this.dockMarker = new S7DockClientStructure(
            x / props.rawMap.pixelSize, y / props.rawMap.pixelSize, props.dock.pose.angle,
            (newX, newY) => this.props.onChange(newX - x, newY - y), rotation => this.props.onRotate(rotation)
        );
        this.dockMarker.rotation = props.rotation;
        this.structureManager.addClientStructure(this.dockMarker);
    }

    componentDidUpdate(prevProps: Readonly<Props>, prevState: Readonly<MapState>): void {
        super.componentDidUpdate(prevProps, prevState);
        if (prevProps.rotation !== this.props.rotation) {
            this.dockMarker.rotation = this.props.rotation;
            this.draw();
        }
    }

    protected onTap(): void {
        // This editor handles dock movement/rotation; map segments remain read-only.
    }

    render(): React.ReactElement {
        return <MapContainer style={{overflow: "hidden"}}>
            <canvas ref={this.canvasRef} aria-label="Drag the blue dock marker to move it, or the orange handle to rotate it"
                style={{width: "100%", height: "100%", touchAction: "none"}}/>
        </MapContainer>;
    }
}

export default S7DockMap;
