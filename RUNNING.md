# How to run

Development server (only Node.js 18+ is required):

```bash
git clone https://github.com/Saky98/av-event-forensics.git
cd av-event-forensics
npm install
npm run dev
```

Open: **http://localhost:5173/**

Load the demo recording: `storage/Town02_truck_collision.mcap` (and `storage/compromised/...` to demonstrate the hash/chain).

Production (optional): `npm run build` then `npm run preview`.
