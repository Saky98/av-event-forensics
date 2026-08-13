# Design of a Custom Forensic Visualization Tool for Temporal-Spatial Reconstruction of Autonomous Vehicle Events

A self-hosted web forensic tool for analyzing MCAP recordings from autonomous driving datasets — fully local, nothing is uploaded to a server.

> ⚠️ **Work in progress** — Phases 1–5 are complete (scaffold & architecture, file manager & MCAP loading, multi-camera player, LiDAR 3D visualization, telemetry charts). Next up: **Phase 6 — Forensic Validation & Hashing**. See [HANDOFF.md](./HANDOFF.md) for the detailed roadmap and session log.

## What it does

Fully local, browser-based analysis of MCAP files — nothing is uploaded to a server:

- Raw file browsing (file manager)
- MCAP loading with topic/schema extraction
- Synchronized multi-camera playback (up to 6 cameras) with a timeline
- 3D LiDAR point cloud visualization with bounding boxes
- Telemetry charts (speed, acceleration)
- Forensic validation: hashing, provenance, chain of trust

## Tech stack

| Component        | Technology                                        |
|------------------|---------------------------------------------------|
| Language         | TypeScript                                        |
| Frontend         | React + Vite                                      |
| State management | Redux Toolkit                                     |
| MCAP parsing     | `@mcap/browser`, `@mcap/core`, `@mcap/support`    |
| 3D rendering     | Three.js                                          |
| Charts           | uPlot                                             |

## Project phases

Each phase is developed on its own git branch and merged into `main` via a **merge request named after the phase** (e.g. `Phase 4 — LiDAR 3D Visualization`). At the end of every phase we create a git **tag**, so each stage stays recoverable for later changes or polish.

| # | Phase name | Branch | Status |
|---|------------|--------|--------|
| 1 | Scaffold & Architecture | `phase/1-scaffold-architecture` | ✅ Done |
| 2 | File Manager & MCAP Loading | `phase/2-file-manager-mcap` | ✅ Done |
| 3 | Multi-Camera Player | `phase/3-multi-camera-player` | ✅ Done |
| 4 | LiDAR 3D Visualization | `phase/4-lidar-3d` | ✅ Done |
| 5 | Telemetry Charts | `phase/5-telemetry-charts` | ✅ Done |
| 6 | Forensic Validation & Hashing | `phase/6-forensic-validation` | 🚧 Next |

> **Note:** Phases 1–3 were built directly on `main` and snapshotted together in a single commit (tag `phases-1-3-baseline`). From Phase 4 onward, work happens on a dedicated phase branch.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed URL (usually `http://localhost:5173/`).

### Scripts

```bash
npm run dev      # start the Vite dev server
npm run build    # production build (tsc -b && vite build)
npm run lint     # ESLint check
npm run preview  # preview the production build locally
```

## Roadmap

See [HANDOFF.md](./HANDOFF.md) — the single source of truth for the project plan and progress.

## License

To be decided.
