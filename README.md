# Autonomous-Vehicle Event Forensics Tool

A **local, self-hosted web tool** that reconstructs and *proves* autonomous-vehicle
events (e.g. a frontal collision) from **MCAP** recordings. Built from the ground up —
nothing is uploaded to a server; all parsing, rendering and forensic hashing runs
in the browser (with a Web Worker for the heavy work).

Stack: TypeScript · React · Redux Toolkit · Vite · Three.js (3D) · uPlot (charts).

## Running

Requires **Node.js 18+**. Start the development server:

```bash
git clone https://github.com/Saky98/av-event-forensics.git
cd av-event-forensics
npm install
npm run dev
```

Open **http://localhost:5173/** and load an `.mcap` from the file manager
(`storage/Town02_truck_collision.mcap` for the demo, or
`storage/compromised/Town02_truck_collision.mcap` to see the tamper detection).

For a production build:

```bash
npm run build
npm run preview
```

## The four tabs

Once a recording is loaded, the main viewer shows these tabs:

- **Cameras** — up to 6 synchronized cameras (front/back/left/right grid), all locked
  to the same global timestamp via the shared timeline scrubber.
- **3D LiDAR** — Three.js point cloud plus detected-object bounding boxes and the ego
  vehicle marker, overlaid on a static background map.
- **Telemetry** — speed / acceleration chart (uPlot). Clicking the chart seeks the
  whole tool to that instant; a red cursor tracks the current timeline position.
- **Forensic** — integrity & chain of custody: SHA-256 of the raw file, per-frame
  hash chain, "Simulate tamper" / "Verify", and **Export HTML report** (a self-contained
  report with hashes, the chain table, and live camera/LiDAR snapshots).

A shared **Timeline** at the bottom drives playback and scrubbing across every tab.

## Demo recordings

Recordings live in `storage/`:

- `storage/Town02_truck_collision.mcap` — the **clean** recording (~72&nbsp;MB, zstd):
  a synthetic frontal car–truck collision, 6 cameras + LiDAR + ego pose, speed /
  acceleration telemetry, a collision flag and sudden-braking events.
- `storage/compromised/Town02_truck_collision.mcap` — a **tampered** copy of the same
  scenario (one ego-velocity frame altered). Uses the same file name so the Forensic
  tab demonstrates that the stored **hash-chain baseline** detects the modification
  and reports exactly where the chain diverges.

> The `.mcap` binaries are generated locally and are **not** committed to the repo.

## Data source

The demo scenario was synthesised from the **DeepAccident** dataset
(synthetic **CARLA** simulation — Town02, ego vehicle vs. truck). The raw DeepAccident
records are converted to MCAP (Foxglove FlatBuffer schemas) by the scripts in
`scripts/python/` (see `scripts/python/deepaccident_to_mcap.py`).

## License & attribution

- The **tool source code** is released under the **MIT License** — you may use it,
  modify it, and redistribute it however you like (including commercially), provided
  you retain the copyright notice.
- The demo data derives from **DeepAccident**. If you use or redistribute it, please
  check the official DeepAccident repository for its current terms and cite the
  dataset accordingly. Foxglove schemas are used purely as the MCAP wire format.
