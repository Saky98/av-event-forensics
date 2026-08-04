# Design of a Custom Forensic Visualization Tool for Temporal-Spatial Reconstruction of Autonomous Vehicle Events

A self-hosted web forensic tool for analyzing MCAP recordings from autonomous driving datasets — fully local, nothing is uploaded to a server.

> ⚠️ **Work in progress** — Phase 1 (project skeleton, Redux store, UI layout) is complete. Next up: Phase 2 — file manager & MCAP loading. See [HANDOFF.md](./HANDOFF.md) for the full roadmap.

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
