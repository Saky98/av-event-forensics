// Smoke test: Phase 4 LiDAR data path — parses the REAL file using the actual
// src parsers + coordinate transforms (same code paths as the worker/UI).
// Run: node --experimental-strip-types scripts/smoke-lidar.mjs [storage/Town02_with_map.mcap]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';
import { parsePointCloud, extractPoints } from '../src/utils/foxglove/pointCloud.ts';
import { parseSceneUpdate } from '../src/utils/foxglove/sceneUpdate.ts';
import { parsePose } from '../src/utils/foxglove/pose.ts';
import { transformPositions, rosToThree } from '../src/utils/coordinates.ts';

const ARGV = process.argv;
const FILE = ARGV[2] ?? 'storage/Town02_with_map.mcap';

// ---- http server + browser sim (same as scripts/validate-parsers.ts) ----
const ROOTS = { '/vendor/wasm/': path.resolve('public/vendor/wasm'), '/storage/': path.resolve('storage') };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  for (const [prefix, dir] of Object.entries(ROOTS)) {
    if (url.startsWith(prefix)) {
      const file = path.join(dir, path.basename(url));
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/vendor/wasm/`;
const nodeProcess = process;
delete globalThis.process;
globalThis.window = {}; globalThis.self = globalThis; globalThis.document = { currentScript: undefined };
globalThis.location = { href: BASE + 'x.js' };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const abs = url.startsWith('/') ? `http://127.0.0.1:${PORT}${url}` : url;
  return nativeFetch(abs, init);
};
const GLUE_ASSET_DIR = `${import.meta.env?.BASE_URL ?? '/'}vendor/wasm/`;
function assetUrl(assetName) { const base = globalThis.location?.href ?? 'http://localhost/'; return new URL(`${GLUE_ASSET_DIR}${assetName}`, base).href; }
async function loadGlueFactory(assetName) {
  const glueUrl = assetUrl(assetName);
  const code = await (await fetch(glueUrl)).text();
  const requireShim = (p) => { if (p.endsWith('.wasm')) return new URL(p.replace(/^\.\//, ''), glueUrl).href; throw new Error('no shim'); };
  const evaluate = new Function('require', `${code}\n;return Module;`);
  return evaluate(requireShim);
}
const toUint8Array = (heap, ptr, length) => new Uint8Array(heap.buffer.slice(ptr, ptr + length));
async function loadDecompressHandlers() {
  const [zstdFac, lz4Fac, bz2Fac] = await Promise.all([loadGlueFactory('wasm-zstd.js'), loadGlueFactory('wasm-lz4.js'), loadGlueFactory('module.js')]);
  const [zstd, lz4, bz2] = await Promise.all([zstdFac(), lz4Fac(), bz2Fac()]);
  return {
    zstd: (buffer, d) => { const n = Number(d), sp = zstd._malloc(buffer.byteLength), dp = zstd._malloc(n); zstd.HEAPU8.set(buffer, sp); try { const r = zstd._decompress(dp, n, sp, buffer.byteLength); if (r === -1) throw new Error('zstd'); return toUint8Array(zstd.HEAPU8, dp, r); } finally { zstd._free(sp); zstd._free(dp); } },
    lz4: (buffer, d) => { const n = Number(d), sp = lz4._malloc(buffer.byteLength), dp = lz4._malloc(n); lz4.HEAPU8.set(buffer, sp); try { lz4.__ctx = lz4.__ctx ?? lz4._createDecompressionContext(); const r = lz4._decompressFrame(lz4.__ctx, dp, n, sp, buffer.byteLength); if (r === -1) throw new Error('lz4'); return toUint8Array(lz4.HEAPU8, dp, r); } finally { lz4._free(sp); lz4._free(dp); } },
    bz2: (buffer, d) => { const n = Number(d), sp = bz2._malloc(buffer.byteLength), dp = bz2._malloc(n); bz2.HEAPU8.set(buffer, sp); try { const { code, error, buffer: out } = bz2.decompress(dp, n, sp, buffer.byteLength, 0); if (code !== 0 || out === undefined) throw new Error(`bz2 ${code} ${error}`); return new Uint8Array(out); } finally { bz2._free(sp); bz2._free(dp); } },
  };
}

function lastIndexLE(messages, target) {
  let lo = 0, hi = messages.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (messages[mid].logTime <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; } }
  return ans;
}

let failures = 0;
function check(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); } else { failures++; console.log(`  ✗ FAIL: ${label}`); }
}

async function main() {
  const mcapUrl = `http://127.0.0.1:${PORT}/storage/${path.basename(FILE)}`;
  const file = new Blob([await (await nativeFetch(mcapUrl)).arrayBuffer()]);
  const reader = await McapIndexedReader.Initialize({
    readable: new BlobReadable(file),
    decompressHandlers: await loadDecompressHandlers(),
    messageIndexCacheSizeBytes: 16 * 1024 * 1024,
  });
  const st = reader.statistics;

  // rawCache per topic (same as worker)
  const rawCache = new Map();
  async function getTopicMessages(topic) {
    if (rawCache.has(topic)) return rawCache.get(topic);
    const msgs = [];
    for await (const m of reader.readMessages({ topics: [topic] })) msgs.push(m);
    msgs.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : a.sequence - b.sequence));
    rawCache.set(topic, msgs);
    return msgs;
  }

  // ---- readLidarPoints equivalent ----
  async function readLidarPoints(topic, logTime, decimation = 1) {
    const messages = await getTopicMessages(topic);
    let index = lastIndexLE(messages, logTime);
    if (index < 0 && messages.length > 0) index = 0; // worker fallback: first frame
    if (index < 0) return { actualLogTime: null, points: null };
    const pc = parsePointCloud(messages[index].data);
    return { actualLogTime: messages[index].logTime, points: extractPoints(pc, decimation) };
  }
  // replicate the worker's seek (with fallback) for pose/annotations reads
  const seekIndex = (messages, logTime) => {
    let i = lastIndexLE(messages, logTime);
    return i < 0 && messages.length > 0 ? 0 : i;
  };

  console.log('\n=== lidar sweeps (/lidar/points) across the timeline ===');
  const sweepMsgs = await getTopicMessages('/lidar/points');
  check(sweepMsgs.length >= 40, `${sweepMsgs.length} sweep messages`);
  const samples = [st.messageStartTime, st.messageStartTime + 1_000_000_000n, st.messageStartTime + 2_000_000_000n];
  let lastTotal = 0;
  for (const t of samples) {
    const { actualLogTime, points } = await readLidarPoints('/lidar/points', t, 2);
    check(actualLogTime !== null, `sample at ${t}: found frame`);
    if (!points) continue;
    const expected = Math.ceil(points.total / 2);
    check(points.count === expected, `dec=2 count ${points.count} == ceil(${points.total}/2)=${expected}`);
    check(points.colors !== null, 'intensity colors present');
    if (points.colors) {
      let inRange = true;
      for (let i = 0; i < points.colors.length && i < 3000 * 3; i += 3) {
        if (points.colors[i] < 0 || points.colors[i] > 1) { inRange = false; break; }
      }
      check(inRange, 'colors within [0,1]');
    }
    let finite = true, nonFinite = 0;
    for (let i = 0; i < points.positions.length; i += 3) {
      if (!Number.isFinite(points.positions[i]) || !Number.isFinite(points.positions[i + 1]) || !Number.isFinite(points.positions[i + 2])) nonFinite++;
    }
    finite = nonFinite === 0;
    check(finite, `all positions finite (${nonFinite} bad)`);
    lastTotal = points.total;
  }
  check(lastTotal > 30000, `sweep size ~${lastTotal.toLocaleString()} points`);

  // ---- coordinate transform ----
  console.log('\n=== coordinate transform (ROS -> Three) ===');
  const probe = new Float32Array([1, 2, 3, -4, 5, -6]);
  transformPositions(probe);
  check(probe[0] === 1 && probe[1] === 3 && probe[2] === -2, 'x->x, y->z, z->-y (point 1)');
  check(probe[3] === -4 && probe[4] === -6 && probe[5] === -5, 'x->x, y->z, z->-y (point 2)');
  const r = rosToThree(0, 0, 0);
  check(r[0] === 0 && r[1] === 0 && r[2] === 0, 'origin maps to origin');

  // ---- background map ----
  console.log('\n=== background map (/lidar/background_map) ===');
  const map = await readLidarPoints('/lidar/background_map', st.messageStartTime, 8);
  check(map.actualLogTime !== null && map.points !== null, 'map readable');
  if (map.points) {
    check(map.points.total > 1_000_000, `map total ${map.points.total.toLocaleString()} > 1M`);
    check(map.points.count === Math.ceil(map.points.total / 8), `dec=8 count ${map.points.count.toLocaleString()}`);
  }

  // ---- annotations ----
  console.log('\n=== annotations (/annotations/objects) ===');
  const annMsgs = await getTopicMessages('/annotations/objects');
  const annIndex = seekIndex(annMsgs, st.messageStartTime);
  const update = parseSceneUpdate(annMsgs[annIndex].data);
  check(update.entities.length >= 1, `${update.entities.length} entities`);
  const objects = update.entities.find((e) => e.id === 'objects');
  check(objects !== undefined, 'entity "objects" present');
  if (objects) {
    check(objects.cubes.length >= 10, `${objects.cubes.length} bounding boxes`);
    const colors = new Set(objects.cubes.map((c) => (c.color ? c.color.map((n) => n.toFixed(2)).join(',') : 'none')));
    check(colors.size >= 2, `${colors.size} distinct colors (${[...colors].join(' | ')})`);
  }
  // annotations change over time (objects move)
  const annIndex2 = seekIndex(annMsgs, st.messageStartTime + 1_000_000_000n);
  const update2 = parseSceneUpdate(annMsgs[annIndex2].data);
  const objs2 = update2.entities.find((e) => e.id === 'objects');
  if (objects && objs2 && objs2.cubes.length > 0 && objects.cubes.length > 0) {
    const moved = Math.abs(objects.cubes[0].pose.position[0] - objs2.cubes[0].pose.position[0]) > 0.1;
    check(moved, 'first box moved between frames (+1s)');
  }

  // ---- ego pose ----
  console.log('\n=== ego pose (/ego/pose) ===');
  const poseMsgs = await getTopicMessages('/ego/pose');
  const poseAt = (t) => { const i = seekIndex(poseMsgs, t); if (i < 0) return null; return parsePose(poseMsgs[i].data); };
  const p0 = poseAt(st.messageStartTime);
  const p1 = poseAt(st.messageStartTime + 1_000_000_000n);
  check(p0 !== null && p0.position.every(Number.isFinite), 'pose finite at start');
  if (p0 && p1) {
    const moved = Math.hypot(p1.position[0] - p0.position[0], p1.position[1] - p0.position[1]) > 0.05;
    check(moved, `ego moved between frames (${p0.position.map((n) => n.toFixed(2)).join(',')} -> ${p1.position.map((n) => n.toFixed(2)).join(',')})`);
  }

  console.log(failures === 0 ? '\nSMOKE TEST PASSED ✅' : `\nSMOKE TEST FAILED (${failures} checks) ❌`);
  nodeProcess.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('SMOKE TEST ERROR:', e?.message ?? e, e?.stack); nodeProcess.exit(1); })
  .finally(() => { server.closeAllConnections?.(); server.close(); });
