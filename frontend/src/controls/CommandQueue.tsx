import {Box, Chip, CircularProgress, IconButton, List, ListItem, Tooltip, Typography} from "@mui/material";
import {
    ArrowDownward as MoveDownIcon,
    ArrowUpward as MoveUpIcon,
    Close as RemoveIcon,
    DeleteSweep as ClearIcon,
    DragIndicator as DragIcon,
    PlaylistPlay as QueueIcon,
} from "@mui/icons-material";
import React from "react";
import ControlsCard from "./ControlsCard";
import {CommandQueueAction, useCommandQueueMutation, useCommandQueueQuery} from "../api";

const describeAction = (action: CommandQueueAction): string => {
    switch (action.type) {
        case "go_to":
            return `Go to (${action.params.x}, ${action.params.y})`;
        case "segment_clean":
            return `Clean ${action.params.segmentIds?.length ?? 0} segment(s)`;
        case "zone_clean":
            return `Clean ${action.params.zones?.length ?? 0} zone(s)`;
        case "full_clean":
            return "Full clean";
        case "home":
            return "Dock";
        default:
            return action.type;
    }
};

const CommandQueue = (): React.ReactElement | null => {
    const {data} = useCommandQueueQuery();
    const {mutate} = useCommandQueueMutation();
    const [draggingId, setDraggingId] = React.useState<string>();

    const actions = data?.actions ?? [];
    const runningAction = actions.find(action => {
        return action.id === data?.runningId;
    });
    const pendingActions = actions.filter(action => {
        return action.state === "pending";
    });

    if (!runningAction && pendingActions.length === 0) {
        return null;
    }

    const reorderPending = (ids: string[]) => {
        mutate({action: "reorder", ids: ids});
    };

    const move = (index: number, delta: number) => {
        const ids = pendingActions.map(action => action.id);
        const target = index + delta;

        if (target < 0 || target >= ids.length) {
            return;
        }

        [ids[index], ids[target]] = [ids[target], ids[index]];
        reorderPending(ids);
    };

    const handleDrop = (targetId: string) => {
        if (!draggingId || draggingId === targetId) {
            setDraggingId(undefined);

            return;
        }

        const ids = pendingActions.map(action => action.id);
        const from = ids.indexOf(draggingId);
        const to = ids.indexOf(targetId);

        setDraggingId(undefined);

        if (from < 0 || to < 0) {
            return;
        }

        ids.splice(from, 1);
        ids.splice(to, 0, draggingId);
        reorderPending(ids);
    };

    return (
        <ControlsCard icon={QueueIcon} title="Command queue">
            <List dense disablePadding>
                {
                    runningAction &&
                    <ListItem disableGutters>
                        <CircularProgress size={16} style={{marginRight: "0.5rem"}}/>
                        <Typography variant="body2" sx={{flexGrow: 1}}>
                            {describeAction(runningAction)}
                        </Typography>
                        <Chip size="small" label="Running"/>
                    </ListItem>
                }
                {
                    pendingActions.map((action, index) => {
                        return (
                            <ListItem
                                key={action.id}
                                disableGutters
                                draggable
                                onDragStart={() => {
                                    setDraggingId(action.id);
                                }}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                }}
                                onDrop={() => {
                                    handleDrop(action.id);
                                }}
                                onDragEnd={() => {
                                    setDraggingId(undefined);
                                }}
                                sx={{
                                    opacity: draggingId === action.id ? 0.4 : 1,
                                    cursor: "grab"
                                }}
                            >
                                <DragIcon fontSize="small" sx={{mr: 0.5, color: "text.disabled"}}/>
                                <Typography variant="body2" sx={{flexGrow: 1}}>
                                    {describeAction(action)}
                                </Typography>
                                <Tooltip title="Move up">
                                    <span>
                                        <IconButton
                                            size="small"
                                            disabled={index === 0}
                                            onClick={() => {
                                                move(index, -1);
                                            }}
                                        >
                                            <MoveUpIcon fontSize="small"/>
                                        </IconButton>
                                    </span>
                                </Tooltip>
                                <Tooltip title="Move down">
                                    <span>
                                        <IconButton
                                            size="small"
                                            disabled={index === pendingActions.length - 1}
                                            onClick={() => {
                                                move(index, 1);
                                            }}
                                        >
                                            <MoveDownIcon fontSize="small"/>
                                        </IconButton>
                                    </span>
                                </Tooltip>
                                <Tooltip title="Remove">
                                    <IconButton
                                        size="small"
                                        onClick={() => {
                                            mutate({action: "remove", id: action.id});
                                        }}
                                    >
                                        <RemoveIcon fontSize="small"/>
                                    </IconButton>
                                </Tooltip>
                            </ListItem>
                        );
                    })
                }
            </List>
            {
                pendingActions.length > 0 &&
                <Box sx={{display: "flex", justifyContent: "flex-end", mt: 0.5}}>
                    <Tooltip title="Clear queue">
                        <IconButton
                            size="small"
                            onClick={() => {
                                mutate({action: "clear"});
                            }}
                        >
                            <ClearIcon fontSize="small"/>
                        </IconButton>
                    </Tooltip>
                </Box>
            }
        </ControlsCard>
    );
};

export default CommandQueue;
