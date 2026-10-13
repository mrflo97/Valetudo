import {Route} from "react-router";
import {Navigate, Routes} from "react-router-dom";
import MapManagement from "./MapManagement";
import EditMapPage from "../map/EditMapPage";
import {useCapabilitiesSupported} from "../CapabilitiesProvider";
import {Capability, useDuststreamingConfigurationQuery} from "../api";
import React from "react";
import RobotCoverageMapPage from "../map/RobotCoverageMapPage";
import SpectatorMapPage from "../map/SpectatorMapPage";
import S7MapTools from "./S7MapTools";

const OptionsRouter = (): React.ReactElement => {
    const [s7MapToolsSupported] = useCapabilitiesSupported(Capability.S7MapTools);
    const [
        combinedVirtualRestrictionsCapabilitySupported,

        mapSegmentEditCapabilitySupported,
        mapSegmentRenameCapabilitySupported,

        mapAnnotationsCapabilitySupported,

        duststreamingSupported,
    ] = useCapabilitiesSupported(
        Capability.CombinedVirtualRestrictions,

        Capability.MapSegmentEdit,
        Capability.MapSegmentRename,

        Capability.MapAnnotations,

        Capability.Duststreaming
    );

    const {data: duststreamingConfiguration} = useDuststreamingConfigurationQuery({
        enabled: duststreamingSupported
    });
    const duststreamingPossible = duststreamingSupported && duststreamingConfiguration?.enabled !== false;

    return (
        <Routes>
            <Route path={""} element={<MapManagement />}/>
            {s7MapToolsSupported && <Route path="s7_maps" element={<S7MapTools/>}/>}

            {
                (mapSegmentEditCapabilitySupported || mapSegmentRenameCapabilitySupported) &&
                <Route
                    path={"segments"}
                    element={
                        <EditMapPage
                            mode={"segments"}
                        />
                    }
                />
            }
            {
                combinedVirtualRestrictionsCapabilitySupported &&
                <Route
                    path={"virtual_restrictions"}
                    element={
                        <EditMapPage
                            mode={"virtual_restrictions"}
                        />
                    }
                />
            }
            {
                mapAnnotationsCapabilitySupported &&
                <Route
                    path={"annotations"}
                    element={
                        <EditMapPage
                            mode={"annotations"}
                        />
                    }
                />
            }

            <Route path={"robot_coverage"} element={<RobotCoverageMapPage/>}/>

            <Route path={"spectator"} element={duststreamingPossible ? <SpectatorMapPage/> : <Navigate to="/" />}/>

            <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    );
};

export default OptionsRouter;
