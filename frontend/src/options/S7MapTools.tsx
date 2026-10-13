import React from "react";
import axios from "axios";
import {Alert, Box, Button, Card, CardContent, CircularProgress, Slider, Stack, TextField, Typography, useTheme} from "@mui/material";
import {useQuery} from "@tanstack/react-query";
import {RawMapData, RawMapEntityType, useRobotMapQuery, useRobotStatusQuery, valetudoAPIBaseURL} from "../api";
import {fetchS7Preview, S7DockPreview, S7MapAction, S7SavedSlot, s7MapToolsPath, useS7MapAction, useS7MapTools} from "../api/s7MapTools";
import PaperContainer from "../components/PaperContainer";
import ConfirmationDialog from "../components/ConfirmationDialog";
import S7DockMap from "../map/S7DockMap";
import {normalizeDockRotation} from "../map/structures/client_structures/S7DockClientStructure";

function MapThumbnail({map}: {map: RawMapData}): React.ReactElement {
    const ref = React.useRef<HTMLCanvasElement>(null);
    React.useEffect(() => {
        const ctx = ref.current?.getContext("2d");
        if (!ctx) {
            return;
        }
        const occupied = map.layers.filter(layer => layer.pixels.length > 0);
        if (!occupied.length) {
            return;
        }
        const minX = Math.min(...occupied.map(layer => layer.dimensions.x.min)) - 5;
        const minY = Math.min(...occupied.map(layer => layer.dimensions.y.min)) - 5;
        const maxX = Math.max(...occupied.map(layer => layer.dimensions.x.max)) + 5;
        const maxY = Math.max(...occupied.map(layer => layer.dimensions.y.max)) + 5;
        const scale = Math.min(480 / (maxX - minX), 240 / (maxY - minY));
        ctx.clearRect(0, 0, 480, 240);
        ctx.save();
        ctx.translate((480 - (maxX - minX) * scale) / 2, (240 - (maxY - minY) * scale) / 2);
        ctx.scale(scale, scale);
        ctx.translate(-minX, -minY);
        occupied.forEach((layer, index) => {
            ctx.fillStyle = layer.type === "wall" ? "#455a64" : ["#94cce3", "#add6ac", "#e0c691", "#b7b3dc"][index % 4];
            for (let i = 0; i < layer.pixels.length; i += 2) {
                ctx.fillRect(layer.pixels[i], layer.pixels[i + 1], 1, 1);
            }
        });
        const charger = map.entities.find(entity => entity.type === RawMapEntityType.ChargerLocation);
        if (charger) {
            ctx.fillStyle = "#d84315";
            ctx.beginPath();
            ctx.arc(charger.points[0] / map.pixelSize, charger.points[1] / map.pixelSize, 5 / scale, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }, [map]);
    return <canvas ref={ref} width={480} height={240} aria-label="Saved map preview; orange dot marks the dock"
        style={{width: "100%", height: "auto", background: "#edf3f6", borderRadius: 8}}/>;
}

function SavedMapCard({slot, disabled, request}: {
    slot: S7SavedSlot; disabled: boolean; request: (action: S7MapAction, text: string) => void;
}): React.ReactElement {
    const [name, setName] = React.useState(slot.saved?.name ?? `Map ${slot.slot.toUpperCase()}`);
    const preview = useQuery({queryKey: ["s7_preview", slot.slot, slot.saved?.id],
        queryFn: () => fetchS7Preview(slot.slot), enabled: !!slot.saved});
    return <Card variant="outlined" sx={{flex: 1, minWidth: 240}}><CardContent>
        <Stack spacing={2}>
            <Typography variant="h6">Slot {slot.slot.toUpperCase()}</Typography>
            {preview.data && <MapThumbnail map={preview.data}/>}
            {preview.isError && <Alert severity="warning">Saved preview could not be loaded.</Alert>}
            <Typography variant="body2">{slot.saved ?
                `${slot.saved.name} · ${new Date(slot.saved.createdAt).toLocaleString()} · ${(slot.saved.bytes / 1048576).toFixed(1)} MB` :
                "No map saved yet"}</Typography>
            <TextField label="Backup name" value={name} onChange={event => setName(event.target.value)}
                slotProps={{htmlInput: {maxLength: 48}}} disabled={disabled}/>
            <Button variant="outlined" disabled={disabled || !name.trim()} onClick={() => request(
                {action: "save", slot: slot.slot, name: name.trim()},
                slot.saved ? `Replace “${slot.saved.name}” with the current map?` : "Save the current map in this slot?"
            )}>Save current map</Button>
            <Button variant="contained" disabled={disabled || !slot.saved} onClick={() => {
                if (slot.saved) {
                    request({action: "restore", slot: slot.slot, id: slot.saved.id},
                        `Restore “${slot.saved.name}” and reboot? Its dock position, robot settings and history will be restored too. The current state will be retained for recovery.`);
                }
            }}>Restore and reboot</Button>
            {slot.saved && <Button component="a" href={`${valetudoAPIBaseURL}${s7MapToolsPath}/slots/${slot.slot}/download`}
                disabled={disabled}>Download backup</Button>}
        </Stack>
    </CardContent></Card>;
}

const S7MapTools = (): React.ReactElement => {
    const state = useS7MapTools();
    const mutation = useS7MapAction();
    const map = useRobotMapQuery();
    const robot = useRobotStatusQuery();
    const theme = useTheme();
    const [confirmation, setConfirmation] = React.useState<{action: S7MapAction; text: string} | null>(null);
    const [editor, setEditor] = React.useState<{dock: S7DockPreview; map: RawMapData} | null>(null);
    const [delta, setDelta] = React.useState({x: 0, y: 0});
    const [rotation, setRotation] = React.useState(0);
    const [rotationText, setRotationText] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState("");
    const [error, setError] = React.useState("");
    const [previewKey, setPreviewKey] = React.useState(0);
    const idle = !!robot.data && ["docked", "idle"].includes(robot.data.value) && robot.data.flag === "none";
    const disabled = mutation.isPending || !idle || !state.data?.available || state.data?.blocked === true;
    const invalidRotation = rotationText !== null && (!rotationText.trim() ||
        !Number.isFinite(Number(rotationText)) || Math.abs(Number(rotationText)) > 180);
    const updateRotation = (value: number) => {
        setRotation(value);
        setRotationText(null);
    };
    const request = (action: S7MapAction, text: string) => setConfirmation({action: action, text: text});

    const submit = async (action: S7MapAction) => {
        setError("");
        try {
            const result = await mutation.mutateAsync(action);
            setEditor(null);
            setNotice(action.action === "save" ? "Map saved. This restore point changes only when you save over it." :
                result.status === "unchanged" ? "Dock position and orientation are unchanged." : "Operation applied. Waiting for the robot to reboot and reconnect…");
        } catch (e) {
            setError(axios.isAxiosError(e) ? String(e.response?.data ?? e.message) : String(e));
        }
    };

    return <PaperContainer><Stack spacing={3} sx={{p: 2}}>
        <Typography variant="h5">S7 saved maps and dock</Typography>
        <Typography>Keep up to two restore points. Each includes the map, dock position, and the robot settings and history stored with them.</Typography>
        {notice && <Alert severity={state.data?.operation?.status === "verified" ? "success" : "info"}>
            {state.data?.operation?.status === "verified" ? "The restored files and loaded dock position and orientation were verified after reboot." : notice}
        </Alert>}
        {state.isPending && <CircularProgress/>}
        {state.isError && <Alert severity="info">Waiting for connection to the robot…</Alert>}
        {state.data?.error && <Alert severity="error">{state.data.error}</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        {!idle && <Alert severity="info">Stop the robot to save, restore or edit its map.</Alert>}
        {state.data?.operation && state.data.operation.status !== "verified" && <Alert severity={state.data.operation.error ? "error" : "info"}>
            {state.data.operation.error ?? `Map operation: ${state.data.operation.status}. Waiting for reboot verification.`}
        </Alert>}
        <Stack direction={{xs: "column", md: "row"}} spacing={2}>
            {state.data?.slots.map(slot => <SavedMapCard key={slot.slot} slot={slot} disabled={disabled} request={request}/>)}
        </Stack>
        {state.data?.recoveryAvailable && <Stack direction="row" spacing={2} flexWrap="wrap">
            <Button disabled={mutation.isPending || !idle || !state.data.available} onClick={() => request(
                {action: "recover"}, "Restore the state from before the last change and reboot?"
            )}>Restore previous state</Button>
            {state.data.blocked && <Button disabled={mutation.isPending || !idle} onClick={() => request(
                {action: "retry_reboot"}, "Retry the reboot for the applied map operation?"
            )}>Retry reboot</Button>}
        </Stack>}
        <Typography variant="h6">Dock position and orientation</Typography>
        <Typography>Move and rotate the map’s dock marker to match the physical dock. The arrow points outward from the dock.</Typography>
        {state.data?.dockError && <Alert severity="info">{state.data.dockError}</Alert>}
        {!editor && <Button variant="outlined" disabled={disabled || !state.data?.dock || !map.data} onClick={() => {
            if (state.data?.dock && map.data) {
                setDelta({x: 0, y: 0});
                updateRotation(0);
                setEditor({dock: state.data.dock, map: map.data});
            }
        }}>Edit dock</Button>}
        {editor && <>
            <Typography variant="body2">Drag the blue marker to move the dock. Drag the orange handle to rotate it. Pan and zoom the map to place it accurately.</Typography>
            <Box sx={{height: {xs: 380, md: 520}, position: "relative"}}>
                <S7DockMap key={previewKey} rawMap={editor.map} dock={editor.dock} paletteMode={theme.palette.mode}
                    rotation={rotation} onRotate={updateRotation} onChange={(x, y) => setDelta({x: x, y: y})}/>
            </Box>
            <Typography>Displacement: {(delta.x / 100).toFixed(2)} m horizontally, {(delta.y / 100).toFixed(2)} m vertically.</Typography>
            <Stack direction={{xs: "column", sm: "row"}} spacing={2} alignItems={{sm: "flex-start"}}>
                <TextField label="Rotation (°)" type="number" value={rotationText ?? rotation.toFixed(1)}
                    disabled={disabled} error={invalidRotation}
                    helperText={invalidRotation ? "Enter a value from −180 to 180." : "Clockwise from the original orientation. Use negative values for counterclockwise."}
                    slotProps={{htmlInput: {min: -180, max: 180, step: 0.1}}}
                    onChange={event => {
                        const text = event.target.value;
                        setRotationText(text);
                        const value = Number(text);
                        if (text.trim() && Number.isFinite(value) && Math.abs(value) <= 180) {
                            setRotation(value);
                        }
                    }} onBlur={() => {
                        if (!invalidRotation) {
                            setRotationText(null);
                        }
                    }}/>
                <Button disabled={disabled} onClick={() => updateRotation(normalizeDockRotation(rotation - 90))}>↶ 90°</Button>
                <Button disabled={disabled} onClick={() => updateRotation(normalizeDockRotation(rotation + 90))}>↷ 90°</Button>
            </Stack>
            <Box sx={{px: 2}}><Slider aria-label="Dock rotation in degrees clockwise" min={-180} max={180} step={1}
                value={rotation} valueLabelDisplay="auto" disabled={disabled}
                marks={[-180, -90, 0, 90, 180].map(value => ({value: value, label: `${value}°`}))}
                onChange={(_, value) => updateRotation(value as number)}/></Box>
            <Stack direction="row" spacing={2}>
                <Button disabled={mutation.isPending} onClick={() => {
                    setEditor(null);
                }}>Cancel</Button>
                <Button disabled={mutation.isPending} onClick={() => {
                    setDelta({x: 0, y: 0}); updateRotation(0); setPreviewKey(key => key + 1);
                }}>Reset</Button>
                <Button variant="contained" disabled={disabled || invalidRotation ||
                    (Math.round(delta.x * 10) === 0 && Math.round(delta.y * 10) === 0 && rotation === 0)}
                onClick={() => request({action: "move_dock", token: editor.dock.token, mapId: editor.dock.mapId,
                    dx: delta.x, dy: delta.y, rotation: rotation},
                `Apply this dock position and ${rotation.toFixed(1)}° rotation, then reboot? Place the physical dock at the chosen position with its front facing the arrow before using return-to-dock.`)}>Apply and reboot</Button>
            </Stack>
        </>}
        <ConfirmationDialog open={!!confirmation} title="S7 map change" text={confirmation?.text}
            onClose={() => setConfirmation(null)} onAccept={() => {
                if (confirmation) {
                    void submit(confirmation.action);
                }
            }}/>
    </Stack></PaperContainer>;
};

export default S7MapTools;
