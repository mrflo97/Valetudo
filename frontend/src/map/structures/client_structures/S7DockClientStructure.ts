import ClientStructure from "./ClientStructure";
import {Canvas2DContextTrackingWrapper} from "../../utils/Canvas2DContextTrackingWrapper";
import {PointCoordinates} from "../../utils/types";
import {considerHiDPI} from "../../utils/helpers";
import {StructureInterceptionHandlerResult} from "../Structure";

export function normalizeDockRotation(degrees: number): number {
    return ((degrees + 180) % 360 + 360) % 360 - 180;
}

class S7DockClientStructure extends ClientStructure {
    public static readonly TYPE = "S7DockClientStructure";
    public rotation = 0;
    private gesture: "move" | "rotate" | null = null;
    private gestureChecked = false;

    constructor(x: number, y: number, private initialAngle: number,
        private changed: (x: number, y: number) => void, private rotated: (rotation: number) => void) {
        super(x, y);
    }

    private screenHandles(matrix: DOMMatrixInit) {
        const angle = this.initialAngle - this.rotation * Math.PI / 180;
        const center = new DOMPoint(this.x0, this.y0).matrixTransform(matrix);
        const direction = new DOMPoint(this.x0 + Math.cos(angle), this.y0 - Math.sin(angle)).matrixTransform(matrix);
        const screenAngle = Math.atan2(direction.y - center.y, direction.x - center.x);
        return {center: center, angle: screenAngle, rotation: {
            x: center.x + Math.cos(screenAngle) * considerHiDPI(72),
            y: center.y + Math.sin(screenAngle) * considerHiDPI(72)
        }};
    }

    draw(wrapper: Canvas2DContextTrackingWrapper, matrix: DOMMatrixInit): void {
        const ctx = wrapper.getContext();
        const handles = this.screenHandles(matrix);
        const p = handles.center;
        ctx.save();
        // The arrow points out of the dock toward its approach/start position.
        ctx.translate(p.x, p.y);
        ctx.rotate(handles.angle);
        ctx.strokeStyle = "#126e9b";
        ctx.fillStyle = "#126e9b";
        ctx.lineWidth = considerHiDPI(4);
        ctx.beginPath();
        ctx.moveTo(considerHiDPI(19), 0);
        ctx.lineTo(considerHiDPI(52), 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(considerHiDPI(53), 0);
        ctx.lineTo(considerHiDPI(42), -considerHiDPI(7));
        ctx.lineTo(considerHiDPI(42), considerHiDPI(7));
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.fillStyle = "#126e9b";
        ctx.strokeStyle = "white";
        ctx.lineWidth = considerHiDPI(3);
        ctx.beginPath();
        ctx.arc(p.x, p.y, considerHiDPI(19), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "white";
        ctx.font = `${considerHiDPI(18)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("↔", p.x, p.y);
        ctx.beginPath();
        ctx.arc(handles.rotation.x, handles.rotation.y, considerHiDPI(16), 0, Math.PI * 2);
        ctx.fillStyle = "#bd6513";
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "white";
        ctx.fillText("↻", handles.rotation.x, handles.rotation.y);
        ctx.restore();
    }

    translate(start: PointCoordinates, last: PointCoordinates, current: PointCoordinates,
        matrix: DOMMatrixInit, scale: number, pixelSize: number): StructureInterceptionHandlerResult {
        if (!this.gestureChecked) {
            const handles = this.screenHandles(matrix);
            if (Math.hypot(last.x - handles.rotation.x, last.y - handles.rotation.y) <= considerHiDPI(24)) {
                this.gesture = "rotate";
            } else if (Math.hypot(last.x - handles.center.x, last.y - handles.center.y) <= considerHiDPI(30)) {
                this.gesture = "move";
            }
            this.gestureChecked = true;
        }
        if (!this.gesture) {
            return {stopPropagation: false};
        }
        const delta = ClientStructure.calculateTranslateDelta(last, current, matrix);
        if (this.gesture === "rotate") {
            const center = this.screenHandles(matrix).center;
            // Crossing the center has no meaningful angle; do not jump by half a turn.
            if ([last, current].every(point => Math.hypot(point.x - center.x, point.y - center.y) > considerHiDPI(12))) {
                const before = Math.atan2(delta.lastInMapSpace.y - this.y0, delta.lastInMapSpace.x - this.x0);
                const after = Math.atan2(delta.currentInMapSpace.y - this.y0, delta.currentInMapSpace.x - this.x0);
                this.rotation = normalizeDockRotation(this.rotation + (after - before) * 180 / Math.PI);
                this.rotated(this.rotation);
            }
            return {stopPropagation: true};
        }
        this.x0 = Math.max(2560 / pixelSize, Math.min(5120 / pixelSize, this.x0 + delta.dx));
        this.y0 = Math.max(0, Math.min(2560 / pixelSize, this.y0 + delta.dy));
        this.changed(this.x0 * pixelSize, this.y0 * pixelSize);
        return {stopPropagation: true};
    }

    postProcess(): void {
        this.gesture = null;
        this.gestureChecked = false;
    }
}

export default S7DockClientStructure;
