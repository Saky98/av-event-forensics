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

**Status:** ⏳ Not started

---

### 🎥 Phase 3: Multi-channel Video Player (Cameras)
- Create a panel for each topic of type `sensor_msgs/Image`.
- Decode images (JPEG, PNG) from MCAP messages.
- Render to Canvas using `ImageBitmap` for speed.
- Synchronize the display via the global timestamp (Redux).
- Implement the timeline: scrubber, play/pause buttons, current time display.
- Let the user choose which cameras to show (e.g. 2×3 grid).

**Status:** ⏳ Not started

---

### 🗺️ Phase 4: 3D LiDAR Point Cloud Visualization
- Parse `sensor_msgs/PointCloud2` messages (decode the binary buffer).
- Extract x, y, z, intensity (per the defined schema).
- Render with Three.js `BufferGeometry` + `Points`.
- Add a decimation option (e.g. every 10th point).
- Load annotations (bounding boxes) from the corresponding topics and draw them as `BoxHelper` or `Box3`.
- Sync the 3D scene with the timeline.

**Status:** ⏳ Not started

---

### 📈 Phase 5: Telemetry & Charts
- Identify topics with numeric data (e.g. speed, acceleration, angles).
- Extract time series from the MCAP.
- Display on a uPlot chart with zoom support.
- Add a vertical cursor that follows the current timestamp (synced with the timeline).
- Allow clicking the chart to move the timeline.

**Status:** ⏳ Not started

---

### 🔐 Phase 6: Forensic Validation & Hashing
- Add an option to compute the SHA-256 hash of the original raw file before conversion.
- Compare against the expected hash (if available).
- Read the `provenance` topic from the MCAP (if present) and show conversion metadata.
- Build a "hash chain": for each frame (or significant event) compute a hash and write it to a dedicated topic (simulation).
- Add an integrity UI (green/red) and a warning if the hash does not match.

**Status:** ⏳ Not started

---

## Current Phase
**Phase 2: File Manager & MCAP Loading**
*(Update this line as we progress)*

---

## How to Continue Work

1. Open a new chat with this handoff MD file.
2. In the first prompt, name the **phase number** you want to work on (e.g. "Let's work on phase 2").
3. The assistant will help with concrete steps, code, and tips for that phase.
4. When a phase is finished, update its status in this MD file and move to the next one.

---

## Additional Resources & Notes

- **MCAP docs:** [https://mcap.dev/](https://mcap.dev/)
- **Foxglove Studio (open source):** reference for how the UI looks.
- **PointCloud2 parsing examples:** check `@mcap/ros` or decode manually.
- **Offline work:** All assets (libraries) must be bundled locally (no CDN) so the tool works without internet.
- **Performance:** Always use Web Workers for parsing and decoding — the UI must stay responsive.
- **Testing:** Use `Town02_truck_collision.mcap` from the DeepAccident mini set as the reference file.

---

*This file is the single source of truth for continuing development. Good luck!*
