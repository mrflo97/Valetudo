# Private S7 map tools

This fork adds **Map Management → S7 saved maps and dock**. The capability is registered only for an embedded `RoborockS7ValetudoRobot`. It shares the upstream authentication and request validation middleware.

## Behavior

- Two named slots hold fixed restore points. Saving overwrites only the chosen slot.
- A snapshot copies `/mnt/data/rockrobo` recursively, excluding its top-level `rrlog` directory. It includes vendor settings, databases and history along with map state, matching the owner's established terminal workflow.
- Restore copies the selected snapshot to a new staged directory, checks its contents, renames the current directory into recovery storage, puts the staged directory at `/mnt/data/rockrobo`, then invokes `sync` and normal `reboot`.
- The original directory is retained as a recovery copy, including its logs. The preceding recovery copy is removed only after the new replacement is installed. The two named slots are not consumed by recovery.
- A persistent journal records the operation. After a different boot, verification compares map-related file hashes, active map selection and the dock record in runtime `SharedMapInfo`. Verification runs even without an open browser. It waits for startup before declaring a failure.
- While an operation is active or failed, commands routed through the S7's Valetudo command path are blocked except read requests, pause and stop. This does not control physical buttons or autonomous vendor actions.
- Dock dragging makes a local draft. The blue marker moves the position; the orange handle rotates the outward-facing arrow. Degree entry, a slider, and 90° buttons also control rotation. Apply uses the original exact pose plus displacement and rotation, rejects stale source hashes/map IDs, stores recovery, and reboots. Reset clears both changes. An unchanged resulting pose writes no files and does not reboot.
- Rotation is relative to the original orientation, in clockwise map degrees from −180 to 180. The backend subtracts that rotation from the saved Y-up angle, wraps it to ±π, and writes float32 at SharedMapInfo offset `0x14`. It preserves all four original angle bytes when rotation is zero or omitted. Position-only clients remain supported. The existing post-reboot runtime check includes the exact resulting float32 angle as well as X/Y.
- Download exports a saved slot as a tar.gz file with a manifest and preview. There is no arbitrary path, shell-command or uploaded-archive endpoint.

## Compatibility established on 2026-10-02

Robot inspection was read-only. `/mnt/data/restore.sh` contained `rm -rf rockrobo`, `cp -R rockrobo_bak rockrobo`, and `reboot`. Neither that script nor any robot movement/reboot operation was executed during development.

- Robot firmware: `4.3.5_1612`.
- Installed Valetudo: `2026.05.0`, commit `4a56bfe876c1f9b298fc5a1b3c8b213ad749ffa1`.
- Persistence library: `/opt/rockrobo/cleaner/lib/librobopersist.so`, MD5 `5089e838b7bf55ffefe4e872c42982a0` (compatibility identifier, not authentication).
- Fork source base: upstream `31bbc50c8dc34d02d4ed1a24d2febe0444344c64`, package version `2026.08.0`.
- Current captured dock: `(5441, 4072, -1.5370830297470093)`; published marker `[3104,2153]`, consistent with normalized exact position `(3104.1,2152.8)`.

The firmware/library profile is checked before operations; saved manifests also bind backups to the robot identity. Other firmware builds need their own validation.

The persistence codec accepts the six captured chunk sizes, identifies SharedMapInfo by chunk ID 5 and size 1,306,912, and preserves unknown fields and all unmodified chunks. Compression length fields are rebuilt; stream offsets are never hard-coded.

## Current limits

- Persistence coordinate signedness is unresolved for negative values. The editor permits only existing and target X/Y values in the common positive range 0–25,600.
- X edits have a demonstrated firmware/reboot experiment; Y editing follows the inferred map transform and is covered offline, but needs hardware validation. Rotation follows the observed dock-to-start-position geometry. Angle-only persistence/reboot changes and physical docking at a changed position or orientation remain untested.
- Snapshots require idle/docked state and stable complete-file comparisons before and after copying. This follows the manual backup method; it is not a vendor-provided transactional database checkpoint.
- The two directory renames are not one atomic filesystem transaction. Normal rename failures restore the original directory when possible. A power cut in that window can require terminal recovery. There is no pre-loader boot hook.
- The operation journal's verification covers restored files and loaded dock state, not successful physical navigation. The owner's Map A restore/reboot reported `verified` before the rotation update on 2026-10-02. Room names/restrictions and physical navigation still need device acceptance checks.
- The full directory restore also rolls back its vendor settings/history. Valetudo's separate configuration and timers are not restored. Room-based timers must be reviewed when restoring maps with different room IDs.
- Keep an off-device backup. Saved slots, the recovery directory and the running robot share the same flash storage. The implementation preserves the original `rockrobo_bak` directory.

## Development and build

After `npm ci`, run:

```sh
node --test backend/test/lib/robots/roborock/S7MapTools_test.js
node --test backend/test/lib/robots/roborock/S7MapToolsRouter_test.js
npm run ts-check_all
npm run build:s7
```

To include the historical binary captures in regression tests:

```sh
S7_FIXTURE_DIRECTORY=/path/to/docktest/persist-analysis node --test backend/test/lib/robots/roborock/S7MapTools_test.js
```

The private captures remain outside this repository under the parent project's `evidence/2026-10-02`. Synthetic fixtures make the tests usable without those files.

Initial `s7.1` validation on 2026-10-02: 108 backend tests and the five API/command-guard test cases passed; backend/frontend type checking and changed-source linting passed; the frontend production build and ARMv7 executable build completed. A separate offline run saved/restored both real captured directories (767 and 682 inventory entries), switched between them, and recovered the previous copy. The offline run stubbed runtime verification and never changed or rebooted the robot. Browser interaction testing could not be performed because no browser connection was available.

The build produces `build/s7/valetudo-s7`, its SHA-256 checksum and `build-info.json`. It embeds the frontend and API schema and uses upstream's ARMv7 low-memory runtime options. The rotation revision has an `-s7.2` suffix and a unique timestamp in its commit identifier. The initial installation updated the upstream base from the May release to the inspected August source base. Do not use the standard upstream updater to maintain these private modifications.

## Deployment on 2026-10-02

Installed `2026.08.0-s7.1` on `robs` with the ARMv7 low-memory build and performed a normal reboot. SCP failed because the robot has no SFTP server; a temporary LAN HTTP server and `wget` transferred the binary successfully. The server was stopped after transfer. The uploaded and installed binary matched SHA-256 `d6cc17e8fa02bb3fcc48de157b21f8280609e79f591506a7bcdfb06525dec6a2`.

The previous executable, configuration and startup files are retained off-device in `../evidence/2026-10-02/deployment/pre-install.tar`. Deployment details and read-only API checks are saved in the same evidence directory. The original map loaded after vendor startup, the dock pose remained `(5441, 4072, -1.5370830297470093)`, and the robot reported docked. The S7 capability reported available with no dock error or command block, both slots were empty, and the served frontend contained the S7 route. No map save/restore, dock edit or movement command was performed during deployment. Interactive browser and physical-operation checks remain outstanding.

Open `http://192.168.0.100/#/options/map_management/s7_maps` to use the new page.

### Rotation update

Installed `2026.08.0-s7.2` after waiting over five minutes and confirming that the owner's restore had completed with status `verified`. Legacy SCP (`scp -O`) worked. The installed binary SHA-256 is `ca41faff6e6a3b45ebe280c6010227baff4c7a1e5c401728e488a8757144b01f`. Both source trees passed type checking and changed-source linting; the frontend and ARMv7 low-memory build completed. The automated test suites were not run for this revision.

After reboot, read-only API and served-asset checks confirmed the new release and rotation controls, an available/unblocked S7 capability, a docked robot, unchanged dock pose, and the original saved Map A ID. No rotation or movement command was sent. The previous `s7.1` build is retained in `build/s7-1`; the pre-update configuration, saved slots and recovery data are backed up off-device in `../evidence/2026-10-02/rotation-deployment/pre-update-config-and-slots.tar`. Deployment evidence is in that same directory. Rotation persistence/reboot behavior and physical docking still require hardware validation when a rotation is applied.

## Storage and recovery

Storage is under `/mnt/data/valetudo-s7-maps`, outside the directory being restored. `slots.json` maps `a` and `b` to immutable UUID directories containing `rockrobo/`, `manifest.json` and `preview.json`. `operation.json` records the latest operation and its `recoveryId`.

If the UI is reachable, use **Restore previous state**. If directory replacement was interrupted and the robot is not usable through the UI, inspect `operation.json` over SSH and locate the retained UUID recovery directory. Preserve the present `rockrobo` directory under a different name before copying the recovery directory back as `rockrobo` and performing a normal reboot. Recovery directories contain the actual `rockrobo` contents directly; saved-slot directories have a nested `rockrobo/` child.

Reboots and real directory restoration are intentional actions in the UI. They require a confirmation that names the affected operation. The development tests only use temporary directories.
