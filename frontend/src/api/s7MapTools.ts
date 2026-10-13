import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {valetudoAPI} from "./client";
import {RawMapData} from "./RawMapData";
import {preprocessMap} from "./mapUtils";

export const s7MapToolsPath = "/robot/capabilities/S7MapToolsCapability";

export interface S7DockPreview {
    mapId: number;
    token: string;
    pose: {x: number; y: number; angle: number};
    mapPosition: {x: number; y: number};
}

export interface S7SavedSlot {
    slot: "a" | "b";
    saved: {id: string; name: string; createdAt: string; bytes: number; mapId: number} | null;
}

export interface S7MapToolsState {
    available: boolean;
    error?: string;
    dockError?: string;
    dock?: S7DockPreview;
    blocked?: boolean;
    recoveryAvailable?: boolean;
    slots: S7SavedSlot[];
    operation?: {id: string; status: string; name: string; error?: string};
}

export type S7MapAction =
    {action: "save"; slot: string; name: string} |
    {action: "restore"; slot: string; id: string} |
    {action: "recover" | "retry_reboot"} |
    {action: "move_dock"; token: string; mapId: number; dx: number; dy: number; rotation: number};

export const useS7MapTools = () => useQuery({
    queryKey: ["s7_map_tools"],
    queryFn: async () => (await valetudoAPI.get<S7MapToolsState>(s7MapToolsPath)).data,
    refetchInterval: 5000,
    retry: false
});

export const useS7MapAction = () => {
    const client = useQueryClient();
    return useMutation({
        mutationFn: async (action: S7MapAction) => (await valetudoAPI.put(s7MapToolsPath, action)).data,
        onSuccess: () => client.invalidateQueries({queryKey: ["s7_map_tools"]})
    });
};

export const fetchS7Preview = async (slot: string): Promise<RawMapData> =>
    preprocessMap((await valetudoAPI.get<RawMapData>(`${s7MapToolsPath}/slots/${slot}/preview`)).data);
