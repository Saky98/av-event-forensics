# Handoff: Forensic Tool for Autonomous Vehicles (DeepAccident + MCAP)

## Context
The project builds on previous work that used Foxglove for visualizing MCAP files from the DeepAccident dataset. The goal is to build a self-hosted web tool that enables:

- Raw file browsing (file manager)
- Loading and displaying MCAP files (no upload to a server, fully local)
- Synchronized multi-camera display (up to 6) with a timeline
- 3D visualization of LiDAR point clouds with bounding boxes (annotations)
- Telemetry charts (speed, acceleration)
- Forensic validation (hashing, provenance, chain of trust)

The goal is not to outperform Foxglove, but to build a functional tool that demonstrates an understanding of the data and forensic principles.

---

## Technology Stack (chosen)

| Component        | Technology / Library                             |
|------------------|--------------------------------------------------|
| Language         | TypeScript                                       |
| Frontend         | React + Vite                                     |
| State management | **Redux Toolkit** (chosen; instead of Zustand)   |
| MCAP parsing     | `@mcap/browser`, `@mcap/core`, `@mcap/support`   |
| 3D rendering     | Three.js                                         |
| Charts           | uPlot (fast, lightweight)                        |
| File system      | File System Access API (or `<input>` with `webkitdirectory`) |
| Image handling   | `createImageBitmap` + Canvas                     |
| Web Workers      | For parsing and decoding (keep the UI responsive) |

> **Note:** The project code already uses Redux Toolkit (`src/store/`), so Zustand from the earlier proposal is **not used**.

---

## Work Phases

### ✅ Phase 1: Architecture & Project Setup
- Set up the TypeScript + React/Vite project. ✅
- Define the folder structure (components, hooks, utils, store). ✅
- Configure the Redux store for: current timestamp, topic list, selected file, player state (play/pause). ✅
- Implement the base UI layout: file sidebar, central panel area, timeline at the bottom. ✅

**Status:** ✅ **Done** (layout, Redux store, types, and placeholder components are in place)

---

### 📁 Phase 2: File Manager & MCAP Loading
- Allow browsing a local folder (File System Access API).
- Load an MCAP file and extract the topic list, message types, and schemas.
- Show the topic hierarchy in the sidebar.
- Implement `McapIndexedReader` for timestamp-based message reading (lazy loading).
- Optionally support opening multiple MCAP files.

**Status:** 🚧 In progress — core done:
- ✅ File picker: File System Access API (`showOpenFilePicker`) with `<input type="file">` fallback (Sidebar "Open MCAP" / "Close").
- ✅ `src/utils/mcap.ts` — `McapIndexedReader` loading via `BlobReadable`, topic list + schemas + statistics extraction, lazy `readMessages({topics, startTime, endTime})`, active session (reader + File) kept outside Redux (state stays serializable).
- ✅ Redux state extended: `topics: McapTopic[]`, `fileInfo`, `loadStatus`/`loadError` (appStore.ts + types).
- ✅ Sidebar: file card (size, duration, message count, compression, library) + topics grouped by schema; Viewer shows a file summary grid.
- ✅ Decompression: `src/utils/decompress.ts` — vendored `@foxglove/wasm-*` glue + wasm under `public/vendor/wasm/`, loaded at runtime with a `require` shim (Vite 8/rolldown can't bundle the CJS `require("./x.wasm")`; the packages also use Node `Buffer`). Handlers: zstd (raw), lz4 (LZ4 frame — matches `@mcap/support`/wasm-lz4), bz2. No Node polyfills.
- ✅ Smoke tests: `scripts/smoke-mcap.mjs` (write→read round trip: topics, stats, time-range lazy reads, payload integrity, zstd chunks) and `scripts/smoke-decompress-browser.mjs` (browser-sim glue loading + zstd/lz4/bz2 decompression). Run with `node scripts/smoke-*.mjs`.

**Remaining in Phase 2:**
- ⏳ Verify with the real `Town02_truck_collision.mcap` (DeepAccident mini set) — not in the repo.
- ⏳ Move message reading/decoding to a Web Worker (deferred: heavy work starts in Phase 3).
- ⏳ Optional: multiple open MCAP files.

---

### 🎥 Phase 3: Multi-channel Video Player (Cameras)
- Create a panel for each topic of type `sensor_msgs/Image`.
- Decode images (JPEG, PNG) from MCAP messages.
- Render to Canvas using `ImageBitmap` for speed.
- Synchronize the display via the global timestamp (Redux).
- Implement the timeline: scrubber, play/pause buttons, current time display.
- Let the user choose which cameras to show (e.g. 2×3 grid).

**Status:** ✅ Done — verified live in browser (play + scrub + 6-camera grid); see Session Log items 11–14. Details:
- ✅ Flatbuffer parser for `foxglove.CompressedImage` (`src/utils/foxglove/compressedImage.ts`) — field order timestamp, frame_id, data, format (verified vs python, sha256 match).
- ✅ Decoding Web Worker (`src/workers/mcap.worker.ts`) — owns the reader, lazily reads+decompresses camera topics, JPEG → ImageBitmap (resized 640×360, LRU 12), transferable response. Client: `src/hooks/useMcapWorker.ts`.
- ✅ Redux player state: `timeRange`, `cameraTopics`, `visibleCameras`, `gridLayout` (1/4/6), `playerReady`, `frameStepMs`.
- ✅ `CameraGrid` — canvas panels, nearest-frame seek, stale-request guard, overlay (camera name + time + frame #).
- ✅ `Timeline` — frame-accurate scrubber (frame = 100 ms), play/pause, speed 0.1–3×, relative time display.
- ✅ Tests: `scripts/smoke-compressedimage.mjs` (parser + nearest-frame + python sha256 cross-check); all 6 cameras verified (jpeg magic).
- ✅ Live playback confirmed (grid 6 cams, play, scrub, frame counter, relative time).

---

### 🗺️ Phase 4: 3D LiDAR Point Cloud Visualization
- Parse `sensor_msgs/PointCloud2` messages (decode the binary buffer).
- Extract x, y, z, intensity (per the defined schema).
- Render with Three.js `BufferGeometry` + `Points`.
- Add a decimation option (e.g. every 10th point).
- Load annotations (bounding boxes) from the corresponding topics and draw them as `BoxHelper` or `Box3`.
- Sync the 3D scene with the timeline.

**Status:** ✅ Done — verified live in headless Chromium (WebGL renders, sweep + map + boxes + ego synced, play/scrub works). Details:
- Flatbuffer parsers (hand-written, no flatbuffers dep): `src/utils/foxglove/flatbuffer.ts` (generic Fb reader), `pointCloud.ts` (`foxglove.PointCloud` + `extractPoints`), `sceneUpdate.ts` (`foxglove.SceneUpdate` → entity cubes), `pose.ts` (`foxglove.Pose`).
- **Schema gotcha:** these MCAPs use the older foxglove layout where `Vector3`/`Quaternion`/`Color` are **tables** (uoffset refs), not structs; `Color` fields are **float64** with defaults `(r=1, g=0, b=1, a=1)`; flatbuffers omits fields equal to their default, so absent offset ⇒ 0, absent blue ⇒ 1. `Fb.field()` guards ids beyond the vtable size (empty tables are common for identity poses).
- Worker: `readLidarPoints` (parse + decimate + extract, transfers Float32Arrays), `readSceneEntities`, `readPose`; nearest-frame seek falls back to the first frame when seeking before the start.
- `src/components/LidarView/LidarView.tsx` + CSS: Three.js scene (Points, OrbitControls, grid/axes), decimation 1–16, point-size slider, toggles (Map/Boxes/Ego), live stats; ROS→Three axis mapping in `src/utils/coordinates.ts` (x,y,z → x,z,−y).
- Viewer: **Cameras | 3D LiDAR** tabs (only when relevant topics exist).
- Store: `lidarPointTopics`, `lidarMapTopics`, `annotationTopics`, `egoPoseTopic` (detected in `useMcapReader` by schema: `foxglove.PointCloud` / `SceneUpdate` / `Pose`).
- Tests: `scripts/validate-parsers.ts` (parse the real file: 39 408 pts/sweep, 1 776 183 map pts, 23 boxes with 3 colors, ego pose), `scripts/smoke-lidar.mjs` (data-path checks incl. decimation math + coordinate transform), `scripts/verify-lidar.mjs` (headless Chromium E2E; needs playwright@1.48.2 on macOS 13).
- Three.js (`three` + `@types/three`) added as dependencies; bundle ~776 KB (lazy-loading the lidar view is a later polish item).

---

### 📈 Phase 5: Telemetry & Charts
- Identify topics with numeric data (e.g. speed, acceleration, angles).
- Extract time series from the MCAP.
- Display on a uPlot chart with zoom support.
- Add a vertical cursor that follows the current timestamp (synced with the timeline).
- Allow clicking the chart to move the timeline.

**Status:** ✅ Done — verified live in headless Chromium (4 series, cursor follows play, click-to-seek works). Details:
- Worker `readTelemetry`: reads `/ego/velocity` + `/ego/acceleration` (std_msgs/Float64 JSON) and `/ego/pose` (flatbuffer → x/y/yaw) once, returns relative-seconds Float64Array series.
- Store: `velocityTopic`/`accelerationTopic` detection (schema `std_msgs/Float64` + topic name), `telemetry` data (plain number[]); loaded in `useMcapReader` after worker init.
- `src/components/TelemetryPanel/TelemetryPanel.tsx` + CSS: uPlot (velocity + acceleration on left scale, heading ° on right scale), vertical timeline cursor (overlay div — uPlot's own `valToPos` is NaN until first draw, so position is computed from data/scale bounds + `bbox.width`), click-to-seek (`posToVal` → `setCurrentTimestamp`), drag-to-zoom + double-click reset, ResizeObserver.
- Viewer: third tab **Telemetry** (shown when velocity/acceleration/pose topics exist).
- Layout fix: `.viewer-area` got `min-height: 0; overflow: hidden` — uPlot's explicit px height previously inflated the grid row to ~3000px and destabilized the Play button.
- uPlot 1.6.32 gotchas: `series.value` must be a function (format strings crash with "s.value is not a function"); `scales.x.range: [0, null]` does not auto-resolve the max; `select`/`cursor` styling via CSS.
- Data facts (`Town02_with_map.mcap`): velocity 0–17.4 m/s, acceleration −61.4…+11.1 m/s² (collision spike), ego x −3.6 → −17.0 m (last sample jumps back — data quirk), yaw ≈ 0 (straight driving); `Town02_truck_collision.mcap` additionally has `/collision/detected` (bool) and `/events/sudden_braking` (JSON event).
- Tests: `scripts/smoke-telemetry.mjs` (JSON parse, ranges, yaw, excursion, event topics, both files), `scripts/verify-telemetry.mjs` (headless Chromium E2E).

---

### 🔐 Phase 6: Forensic Validation & Hashing
- Add an option to compute the SHA-256 hash of the original raw file before conversion.
- Compare against the expected hash (if available).
- Read the `provenance` topic from the MCAP (if present) and show conversion metadata.
- Build a "hash chain": for each frame (or significant event) compute a hash and write it to a dedicated topic (simulation).
- Add an integrity UI (green/red) and a warning if the hash does not match.

**Status:** ✅ Done — verified live in headless Chromium. Details:
- Worker `hashFile`: SHA-256 of the raw file bytes (crypto.subtle in the worker; `activeFile` kept for hashing). Matches `shasum -a 256` (`Town02_with_map.mcap` = `3d9abdd8…`, truck_collision = `6816edf0…`).
- Worker `readEvents`: `/collision/detected` (std_msgs/Bool → 0/1 series) + `/events/sudden_braking` (std_msgs/String wrapping JSON → parsed events).
- `src/utils/forensics.ts` (pure, Node-testable): `sha256Hex`, `buildChainRecords` (45 per-frame records from telemetry + event flags matched by nearest time), `computeChain` (hash[i] = SHA-256(seed|hash[i-1]|canonical[i])), `checkChain` (first divergence), `shortHash`.
- Store: `collisionTopic`/`brakingTopic`/`events`/`fileHash`/`expectedHash`; detection + loading in `useMcapReader`.
- `src/components/ForensicPanel/` — 3 cards: ① File Integrity (computed SHA-256 + copy, expected-hash input → INTACT/MISMATCH green/red badge) ② Provenance & Conversion Metadata (library `python mcap 1.3.1`, profile empty, counts; honest note: no MCAP metadata/provenance records written by the converter) ③ Frame Hash Chain (45 links table with t/v/a/flags + per-link hash, Verify / Simulate tamper (frame 22) / Reset; tamper marks links from that frame red and the badge shows `broke at link N`).
- Viewer: 4th tab **Forensic**.
- Tests: `scripts/smoke-forensics.mjs` (SHA-256 vs node crypto + known vector, chain determinism, tamper detected exactly at the tampered frame), `scripts/verify-forensics.mjs` (headless Chromium E2E). All prior smoke tests still pass.

---

## Current Phase
**All 6 phases are DONE** (scaffold, file manager & MCAP loading, multi-camera player, LiDAR 3D, telemetry, forensic validation) — verified live in headless Chromium and via smoke tests on the real files. Forensic polish now includes a **local integrity snapshot/registry** (IndexedDB) that records file hash + per-frame chain on first open and detects modified copies, and a **self-contained HTML report export** (file integrity + hash chain + live sensor snapshot: cameras, LiDAR, telemetry/time/frame/events). Open polish backlog: Phase 3 (full-res on click, per-camera toggles), Phase 4 (lazy-load three.js chunk, camera-follow ego, ego trajectory, vehicle_info topic if re-converted), Phase 5 (event markers for collision/braking on the chart, better axes), Phase 6 (embed provenance/metadata + per-frame chain directly into a re-converted MCAP via the python converter), and report ideas (JSON export besides HTML, persist LiDAR framing across reloads).
*(Update this line as we progress)*

## Git Workflow (from Phase 4 onward)

- Phases 1–3 were built on `main` directly and snapshotted in commit `6d40afd` (tag **`phases-1-3-baseline`**), pushed to GitHub `origin/main`.
- Each phase from now on gets its own branch `phase/<n>-<short-name>` (names in README table), developed there, merged to `main` via a merge request named after the phase.
- At the end of each phase, create a tag `phase-<n>-<name>` so every stage stays recoverable.
- Large data (`storage/`) and build artifacts stay gitignored.

---

## Session Log — 13.08.2026 (polish: camera grid layout)

- 6-camera grid now uses a spatial surround layout (was alphabetical):
  `[Front Left | Front | Front Right]` / `[Back Left | Back | Back Right]`
  (front center top, back center bottom, left/right cameras on their sides).
- `CameraGrid.orderedCameras()`: 6-grid = spatial order; 4-grid = the four
  surround corners (front/back left+right); 1-grid = front camera.
- Labels improved: `/camera_front_left/...` -> "Front Left" (no underscore).
- Verified headless: all three layouts in the expected DOM order.

## Session Log — 13.08.2026 (polish: modern timeline bar)

- Timeline track redesigned to a modern full-width progress bar: thin 5px bar
  spanning the whole footer edge-to-edge (`.timeline-area` padding removed),
  accent fill up to the current position (CSS var `--pct`), thumb dot on
  hover/drag/focus. The native range input is an invisible overlay driving
  interaction — avoids cross-browser `::-webkit-slider-*` inconsistencies
  (headless Chromium ignored those pseudo-element rules entirely).
- Root cause of earlier sizing bug: `src/index.css` had a generic
  `input[type="range"] { width: 100px; margin: 0 10px }` that out-specified the
  component class; removed it, sliders size themselves now.
- Verified headless: bar edge-to-edge, fill grows during play, click-middle
  seeks to ~50%, blue fill + grey base visible in pixels.

## Session Log — 13.08.2026 (final merge — all phases closed)

- Merged Phase 6 into `main` (fast-forward), tagged `phase-6-forensic-validation` → **all 6 phases merged and tagged**.
- Forensic polish (per user feedback): emoji flags → text chips (`col` / `brk`) with legend + header row; "Verify chain" now re-checks the displayed chain against the authentic chain (recomputed from source data) and always shows a result message (intact / divergence at link N).
- Tags on main: `phases-1-3-baseline`, `phase-4-lidar-3d`, `phase-5-telemetry-charts`, `phase-6-forensic-validation`.
- Next work will be improvements/polish (see backlog under "Current Phase"); per the git workflow, each goes on its own branch (`phase/<n>-<name>-polish`, `fix/…`, `chore/…`) merged via MR.

## Session Log — 13.08.2026 (Phase 6)

### Phase 6 — Forensic Validation & Hashing (done, verified)
1. Merged Phase 5 into `main` (fast-forward), tagged `phase-5-telemetry-charts`, created `phase/6-forensic-validation`.
2. Confirmed the real files have NO MCAP metadata/provenance records and no .sha256 sidecars — hash + chain UI is built on the raw file + per-frame data instead.
3. Worker: `hashFile` (SHA-256, matches `shasum`) + `readEvents` (collision bool series, braking JSON events).
4. `src/utils/forensics.ts`: hash + chain-of-custody logic (pure, Node-testable).
5. `ForensicPanel` (3 cards) + 4th tab; store: events/fileHash/expectedHash + detection.
6. Browser verification: hash matches reference, INTACT/MISMATCH badges, 45-link chain, tamper breaks at link 22, reset restores.
7. Tests: `smoke-forensics.mjs` (both real files, hash + chain determinism + tamper), `verify-forensics.mjs` (headless Chromium); all prior smoke tests + views unaffected.

## Session Log — 13.08.2026 (Phase 5)

### Phase 5 — Telemetry & Charts (done, verified)
1. Merged Phase 4 into `main` (fast-forward), tagged `phase-4-lidar-3d`, created `phase/5-telemetry-charts`.
2. Installed `uplot`; confirmed `/ego/velocity` + `/ego/acceleration` are `std_msgs/Float64` JSON (`{"data": n}`, 45 msgs).
3. Worker `readTelemetry` + hook client + store (`velocityTopic`/`accelerationTopic`/`telemetry`) + detection in `useMcapReader`.
4. `TelemetryPanel` (uPlot, 3 series, timeline cursor overlay, click-to-seek, drag-zoom, dblclick reset) + Telemetry tab in Viewer.
5. Fixed during browser verification: `.viewer-area` min-height (layout explosion to ~3000px), uPlot `series.value` format-string crash, `range:[0,null]` auto-scale, cursor `valToPos` NaN before first draw.
6. Tests: `smoke-telemetry.mjs` (both real files), `verify-telemetry.mjs` (headless Chromium: chart, cursor move, click-to-seek); all prior smoke tests still pass; LiDAR view unaffected.

## Session Log — 13.08.2026 (Phase 4)

### Phase 4 — LiDAR 3D Visualization (done, verified)
1. Git housekeeping: pushed Phases 1–3 snapshot (`4dc622d` + cleanup `6d40afd` + handoff note `57cfc69`), tag `phases-1-3-baseline`, named phases in README with per-phase branch/MR convention, created `phase/4-lidar-3d`.
2. Explored the real file: `/lidar/points` (foxglove.PointCloud, flatbuffer, 45 msgs, 39 408 pts @ 16 B stride, x/y/z/intensity float32), `/lidar/background_map` (1 776 183 pts), `/annotations/objects` (foxglove.SceneUpdate, 23 cubes, colors: blue vehicles / orange truck / red collision), `/ego/pose` (foxglove.Pose).
3. Wrote generic flatbuffer reader + domain parsers (`pointCloud.ts`, `sceneUpdate.ts`, `pose.ts`); discovered the legacy table-based Vector3/Quaternion/Color layout (validated via `scripts/python/deepaccident_to_mcap.py` + `.bfbs`).
4. Extended worker (`readLidarPoints`/`readSceneEntities`/`readPose`, first-frame fallback) + hook client.
5. Added lidar topic detection to store + `useMcapReader`.
6. Built `LidarView` (Three.js): points, decimation, OrbitControls, translucent boxes, ego marker, toggles, stats; ROS→Three coordinate utils; Viewer tabs.
7. Tests: `validate-parsers.ts`, `smoke-lidar.mjs`, headless-Chromium `verify-lidar.mjs` (WebGL ok, 19 704 pts @ dec 2, 23 boxes, map 1776k, play works; screenshot pixel analysis confirms boxes visible).

## Session Log — 05.08.2026 (today's work, all steps done)

> This session covered Phase 1 verification + the core of Phase 2, storage setup, real-file validation and one bug fix. **Work on Phase 2 continues next session with the "Remaining" items below.**

### 1. Read handoff & confirmed Phase 1 (done)
- Layout (Sidebar / Viewer / Timeline), Redux store (`appStore.ts`), types, placeholder components — all in place and building.

### 2. Phase 2 — File Manager & MCAP Loading (core implemented)
- **Types** (`src/types/index.ts`): `McapTopic`, `McapFileInfo`, `McapFileSummary`, `McapLoadStatus`; `AppState` extended (`topics`, `fileInfo`, `loadStatus`, `loadError`).
- **`src/utils/mcap.ts`**: `loadMcapFile(file)` via `McapIndexedReader.Initialize` + `BlobReadable`; topic/schema/statistics extraction (`buildTopics`, `buildFileInfo`); lazy `readMessages({topics, startTime, endTime})`; session (reader + File) kept outside Redux; `formatBytes` / `formatDuration`.
- **`src/store/appStore.ts`**: new reducers `setTopics`, `setFileInfo`, `setLoadStatus`, `setLoadError`, `clearFile`.
- **`src/hooks/useMcapReader.ts`**: `loadFile(file)` / `closeFile()` flow with status/error handling.
- **`src/components/Sidebar/Sidebar.tsx` + `.css`**: "Open MCAP" (File System Access API `showOpenFilePicker`) with `<input type="file">` fallback; file card (size, duration, messages, channels, compression, library); topics grouped by schema with per-topic message counts; Close button; loading/error states.
- **`src/components/Viewer/Viewer.tsx` + `.css`**: file summary grid + status views (loading / error / empty / loaded).

### 3. Decompression — Vite 8 problem + vendored wasm solution
- `@mcap/support`'s `loadDecompressHandlers()` **cannot bundle** under Vite 8/rolldown: CJS `require("./*.wasm")` in the emscripten glue → `[REQUIRE_TLA]` build error; the packages also use Node `Buffer`.
- Solution: **`src/utils/decompress.ts`** + vendored assets in **`public/vendor/wasm/`** (wasm-zstd, wasm-lz4, bz2 module — glue JS + wasm). Glue is fetched at runtime and run with a small `require` shim that resolves `.wasm` to the served asset; no Node polyfills (pure `Uint8Array`). Lazy-loaded on first compressed chunk. Handlers: `zstd`, `lz4` (LZ4 frame — matches `@mcap/support`/wasm-lz4), `bz2`.
- Confirmed wasm modules import only `emscripten_memcpy_big` + `emscripten_resize_heap`; bz2 uses embind + wasi shims provided by its glue.

### 4. Storage folder + dataset (moved, not copied)
- **`storage/`** created in the repo and added to **`.gitignore`** (line `storage/` — verified with `git check-ignore`).
- `Desktop/Digitalna forenzika/Projekat1/DeepAccident_mini` (9.4 GB raw dataset: jpg/npz/pkl) → `storage/DeepAccident_mini` via `mv` (instant rename, same volume, no duplication).
- `Desktop/Digitalna forenzika/Projekat1/Town02_with_map.mcap` (70 MB — **most recently modified** MCAP in Projekat1, i.e. the one that works) → `storage/Town02_with_map.mcap`.

### 5. Real-file validation (`scripts/repro-full.mjs`)
- Full browser-path repro in Node (http-served file + runtime glue loading + exact `decompress.ts` logic + `McapIndexedReader` + `readMessages`).
- **`storage/Town02_with_map.mcap`** → 66.8 MB, `python mcap 1.3.1`, 548 messages, **14 channels / 9 schemas / 46 zstd chunks**, 4.5 s, compression `zstd`.
- Contents: 6× `/camera_*/image/compressed` (foxglove.CompressedImage, flatbuffer), `/lidar/points` + `/lidar/background_map` (foxglove.PointCloud), `/annotations/objects` (foxglove.SceneUpdate), `/ego/pose`, `/ego/velocity` + `/ego/acceleration` (json), `/collision/detected`, `/events/sudden_braking`.
- Verified: 45 lidar messages read (28.4 MB payload) through real zstd chunk decompression.

### 6. Bug fix — `TypeError: Invalid URL`
- Symptom: app failed to load the MCAP in the browser.
- Cause: `new URL(rel, base)` with **relative** `base` (`'/vendor/wasm/…'` from `import.meta.env.BASE_URL`) throws in both browser and Node.
- Fix: `assetUrl()` in `decompress.ts` anchors to `globalThis.location?.href` first. Browser-sim smoke test updated to use the relative-base path so this class of bug is caught.

### 7. Tests & checks (all green at end of session)
- `node scripts/smoke-mcap.mjs` — MCAP write→read round trip: topics, stats, time-range lazy reads (inclusive), payload integrity, zstd chunks. ✅
- `node scripts/smoke-decompress-browser.mjs` — browser-sim: runtime glue loading + zstd/lz4/bz2 decompression (relative-base path). ✅
- `node scripts/repro-full.mjs` — real file, full browser path. ✅
- `npm run lint` ✅ (0 errors) · `npm run build` ✅ · dev server serves `.wasm` with `application/wasm` MIME ✅

### 8. What remains (Phase 2)
- ⏳ Manual browser test of `storage/Town02_with_map.mcap` (dev server on :5173 → Open MCAP).
- ⏳ Move message reading/decoding to a Web Worker (heavy work starts in Phase 3).
- ⏳ Optional: multiple open MCAP files.

---

### 9. Python tooling — duplicates + adapted paths (`scripts/python/`)
- **Duplicates** (from `Desktop/Digitalna forenzika/Projekat1/`): `deepaccident_to_mcap.py` (full converter) and `make_accumulated_mcap.py` (standalone PCD→MCAP), both adapted to work from this repo.
- `deepaccident_to_mcap.py`: `--dataset` default → `storage/DeepAccident_mini` (absolute via `__file__`), `--output` default → `storage/output.mcap`.
- `make_accumulated_mcap.py`: `--input` / `--output` args (defaults `storage/deepaccident_accumulated.pcd` / `storage/deepaccident_accumulated.mcap`); fixed broken `sys.path` (now uses `res.files('foxglove_schemas_flatbuffer')` like the main script).
- Dependencies: pip packages `mcap` + `foxglove_schemas_flatbuffer` (installed on this machine).

### 10. Accumulated point cloud added to `deepaccident_to_mcap.py` (single-script pipeline)
- **New channel `/lidar/background_map`** (foxglove.PointCloud, n=1) — all lidar frames transformed to world frame via `ego_to_world` (4×4 from calib `.pkl`) and merged into ONE accumulated cloud; intensity preserved.
- On by default; disable with `--no-accumulate`.
- Verified: 3-frame test run → 118,297 accumulated points (1.89 MB payload), MCAP readable via `McapIndexedReader` (14 channels incl. background_map, zstd chunks).
- Note: `deepaccident_accumulated.pcd` (49.7 MB in Projekat1) was NOT produced by any script in Projekat1 (one-off code; confirmed by grep of all `.py`/`.ipynb`). `make_accumulated_mcap.py` only wraps an existing PCD. The new `--accumulate` in `deepaccident_to_mcap.py` makes the PCD concept available directly in the MCAP.
- ✅ **Generated full reference file:** `storage/Town02_truck_collision.mcap` (71.9 MB, 45 frames, zstd, 548 msgs, 14 channels incl. `/lidar/background_map` n=1 with 1,776,183 accumulated world-frame points (28.4 MB); 7 sudden-braking events — matches original). Command: `python3 scripts/python/deepaccident_to_mcap.py --scenario type1_subtype1_accident --town Town02_type001_subtype0001_scenario00013 --output storage/Town02_truck_collision.mcap`

### 11. Phase 3 — Multi-channel Video Player (core)
- **Data verified:** 6× `/camera_*/image/compressed`, `foxglove.CompressedImage` (flatbuffer), format `jpeg`, ~78–104 KB/frame, 45 frames @10 fps, log_time epoch ns (`1700000000100000000`).
- **Flatbuffer parser** (`src/utils/foxglove/compressedImage.ts`): minimal manual reader — field order is **timestamp(0), frame_id(1), data(2), format(3)** (found by byte-level debug; python generated class confirmed). `scripts/smoke-compressedimage.mjs` cross-checks sha256 of extracted JPEG vs python parser (PASS).
- **Decoding worker** (`src/workers/mcap.worker.ts`, bundled separately by Vite): `init(file)` → own `McapIndexedReader`; `readImage(topic, logTime, maxW?, maxH?)` → nearest frame ≤ logTime (binary search), lazy raw-message cache per topic, JPEG decode via `createImageBitmap` at 640×360, LRU 12 bitmaps, transferred back. Client `src/hooks/useMcapWorker.ts` (request/response ids, terminate on close).
- **Redux:** `timeRange`, `cameraTopics`, `visibleCameras`, `gridLayout` ('1'|'4'|'6'), `playerReady`, `frameStepMs` (100).
- **CameraGrid:** canvas panels (2×3 default; 1/4/6 switcher), nearest-frame display, stale-response guard, overlay with camera name + relative time + frame #.
- **Timeline:** frame-accurate scrubber (`range` in frames), play/pause loop stepping one frame per tick (interval = frameStepMs/speed), speed 0.1–3×, relative time readout; loops at end.
- **Verified:** all 6 cameras decode (JPEG magic + frame_id); build ✅, lint ✅ (react-hooks set-state-in-effect fixed), dev server serves worker module ✅.

### 12. What remains (Phase 3)
- ⏳ Manual browser test: dev server :5173 → Open `storage/Town02_truck_collision.mcap` → 6-camera grid + timeline scrub/play.
- ⏳ (Later polish) full-res decode for a fullscreen view; per-camera visibility toggles; exact fps from data instead of nominal 100 ms.

### 13. Phase 3 bugfixes (playback)
- **Negative start / no frames:** on load `currentTimestamp` stayed `0n` while recording starts at `1700000000100000000` ns → timeline showed ~−1.7e9 s and `readImage(topic, 0)` found no frame. Fix: on load `setCurrentTimestamp(info.startTime)`; CameraGrid also clamps seeks to `>= timeRange.start`.
- **Scrubber range bug:** `Number(end - start) / frameStepMs` divided ns by ms (44M steps instead of 44). Fixed to use `frameNs = frameStepMs * 1e6` in both Timeline (totalFrames/currentFrame) and CameraGrid (frameIndex). Verified: totalFrames 44 → frames 1..45.

### 14. Phase 3 bugfixes (blank cameras)
- **Blank/empty camera panels:** the height chain was broken — `.viewer-container` had no height, so `.camera-grid`/`.camera-grid-panels` (flex:1, min-height:0) collapsed to 0 px and the canvases were invisible. Fixed: `.viewer-container { height:100% }`, `.camera-grid { flex:1 1 0 }`. Data path was verified OK independently (scripts/worker-sim.mjs: all 6 cameras, frames 0/1/2/10 → valid JPEG).
- **Detached cached bitmap:** worker's LRU `ImageBitmap` cache stored bitmaps that were then transferred — transfer detaches them on the worker side, so later reuse returned dead bitmaps (blank on scrubbing back). Fixed: no bitmap cache; raw message bytes stay cached per topic and each `readImage` decodes fresh (fast at 640×360).

---

## How to Continue Work

1. Open a new chat with this handoff MD file.
2. Read the **Session Log** at the bottom for exactly where the last session stopped.
3. In the first prompt, name the **phase number** you want to work on (e.g. "Let's work on phase 2") or the remaining item.
4. The assistant will help with concrete steps, code, and tips for that phase.
5. When a phase is finished, update its status in this MD file and move to the next one.

---

## Additional Resources & Notes

- **MCAP docs:** [https://mcap.dev/](https://mcap.dev/)
- **Foxglove Studio (open source):** reference for how the UI looks.
- **PointCloud2 parsing examples:** check `@mcap/ros` or decode manually.
- **Offline work:** All assets (libraries) must be bundled locally (no CDN) so the tool works without internet. Wasm decompression assets are vendored in `public/vendor/wasm/`.
- **Performance:** Always use Web Workers for parsing and decoding — the UI must stay responsive.
- **Testing:** Reference file is `storage/Town02_with_map.mcap` (moved from `Desktop/Digitalna forenzika/Projekat1/` on 05.08.2026; gitignored). `Town02_truck_collision.mcap` is still in Projekat1 if needed.
- **Vite 8 note:** `@mcap/support`'s `loadDecompressHandlers()` does not bundle under Vite 8/rolldown (CJS `require("./*.wasm")` + Node `Buffer`). Use `src/utils/decompress.ts` instead — it loads the vendored glue at runtime.
- **URL gotcha (fixed):** `new URL(rel, base)` throws `TypeError: Invalid URL` when `base` is relative (e.g. `'/vendor/wasm/…'` from `import.meta.env.BASE_URL`). `decompress.ts` anchors asset URLs to `location.href` first. The browser-sim smoke test now uses the same relative-base path so this class of bug is caught.
- **Real-file test:** `scripts/repro-full.mjs` loads `storage/Town02_with_map.mcap` through the exact browser path (http-served file + runtime glue loading + zstd chunk decompression). Works: 14 channels / 46 zstd chunks / 45 lidar msgs (~28 MB payload). Note: DeepAccident log times are huge (epoch ns, e.g. `1700000000100000000`) — the timeline must use file start/end, not 0.

---

## Session Log — 27.08.2026 (telemetry polish, forensic integrity snapshot & HTML report export)

### Telemetry panel polish
- Added a **persistent legend** (inline color chips) in the Telemetry header so each line's color/unit is always visible (not hover-dependent). Legend is dynamic — only series actually present are shown.
- **Removed the Heading (yaw)** series from the Telemetry chart (not relevant to the investigation; DeepAccident flags all frames as collision anyway, so flags were dropped too).
- **Timeline cursor fix:** the vertical cursor is now mapped against the **full recording range** (`timeRange.start..end`) instead of the telemetry series bounds, so the marker reaches the right edge at the true end of the file. Also re-positions via the uPlot `draw` hook so it stays correct after the panel re-mounts on tab switch.
- Custom tamper frame: hash-chain **Simulate tamper** now accepts a **user-editable frame** (number input, 1-based, default middle) instead of a fixed midpoint.
- Frame Hash Chain table: frame numbers are now **1-based**; columns were slimmed (velocity, flags/col-brk, full per-frame sha-256 shown; status dot moved to far-left column).

### Forensic tab decluttering
- Provenance card reduced from 8 fields to **3 essentials** (Producer/library, Content ch·schemas·msgs, Size·Compression). Removed duplicate session-file footer; shortened verbosity everywhere.
- Hash chain rows: dropped the per-row hash to an extra column (full hash) and moved the status dot left; the "Verify chain" result now turns **all dots green** when intact (tamper still marks red from the point of change).

### Integrity snapshot & registry (chain of custody) — NEW
- New `src/utils/integrity.ts`: on **first open** of a given MCAP it records a **snapshot** (SHA-256 of the whole file + per-frame hash chain) in **IndexedDB** keyed by the snapshot hash (file-name = hash idea), plus a **registry** mapping filename → snapshot hashes. On every later open it compares the current file/chain against the stored baselines and reports **INTACT / MODIFIED**. The registry keeps **all** snapshot hashes per filename so a compromised copy (same name) is detected as modified instead of overwriting the baseline.
- File Integrity card now reads **Expected hash from the baseline/registry** (read-only) instead of a free-text field; status text still shown.
- Frame Hash Chain now shows, per frame, the **expected (baseline) hash vs current** — green when identical, two stacked hashes (green expected / red current) when they diverge. Badge shows global status incl. first divergent frame.
- Demo asset: `scripts/make_compromised.mjs` re-encodes a copy through `@mcap/core` with a single altered telegram value on frame 20 (args `[src] [dst] [frame]`). Note: browser File objects give no path, so the registry keys on filename — a same-named compromised copy is caught only if the clean original was opened first, or vice versa.

### HTML report export — NEW
- `src/utils/report.ts`: **Download HTML report** button on the Forensic tab generates a self-contained, presentable HTML document (dark themed) with, in order: **File**, **File Integrity — SHA-256**, **Frame Hash Chain** (scrollable table), then **Live Snapshot** (relative time, frame, velocity, acceleration, events) and **Cameras** (3-column surround grid matching the in-app layout) and **LiDAR** (framed card, capped width).
- Sensor screen taps are captured at export time from the worker (`captureCamera`, `captureLidar` in `src/utils/snapshot.ts`) — no need for the camera/LiDAR tabs to be open. LiDAR re-frames using the **operator's camera pose** shared via `src/utils/lidarViewState.ts` when they framed the view on the LiDAR tab.
- Shared LiDAR scene builders moved to `src/utils/lidarScene.ts` so the live view and snapshot use identical code.
- Backlog idea (not done): JSON export alongside HTML; persist LiDAR framing across page reloads.

---

*This file is the single source of truth for continuing development. Good luck!*
