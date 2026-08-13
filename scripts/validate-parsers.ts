// Validate the foxglove flatbuffer parsers against the REAL file.
// Run: node --experimental-strip-types scripts/validate-parsers.ts [storage/Town02_with_map.mcap]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';
import { parsePointCloud, extractPoints } from '../src/utils/foxglove/pointCloud.ts';
import { parseSceneUpdate } from '../src/utils/foxglove/sceneUpdate.ts';
import { parsePose } from '../src/utils/foxglove/pose.ts';

const ARGV = process.argv;
const FILE = ARGV[2] ?? 'storage/Town02_with_map.mcap';

// ---- http server (same pattern as scripts/repro-full.mjs) ----
const ROOTS = {
  '/vendor/wasm/': path.resolve('public/vendor/wasm'),
  '/storage/': path.resolve('storage'),
};
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
globalThis.window = {};
globalThis.self = globalThis;
globalThis.document = { currentScript: undefined };
globalThis.location = { href: BASE + 'x.js' };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const abs = url.startsWith('/') ? `http://127.0.0.1:${PORT}${url}` : url;
  return nativeFetch(abs, init);
};

// ---- decompress handlers (same as repro-full.mjs) ----
const GLUE_ASSET_DIR = `${import.meta.env?.BASE_URL ?? '/'}vendor/wasm/`;
function assetUrl(assetName) {
  const base = globalThis.location?.href ?? 'http://localhost/';
  return new URL(`${GLUE_ASSET_DIR}${assetName}`, base).href;
}
async function loadGlueFactory(assetName) {
  const glueUrl = assetUrl(assetName);
  const code = await (await fetch(glueUrl)).text();
  const requireShim = (p) => {
    if (p.endsWith('.wasm')) return new URL(p.replace(/^\.\//, ''), glueUrl).href;
    throw new Error(`No require shim for non-wasm asset: ${p}`);
  };
  const evaluate = new Function('require', `${code}\n;return Module;`);
  return evaluate(requireShim);
}
const toUint8Array = (heap, ptr, length) => new Uint8Array(heap.buffer.slice(ptr, ptr + length));
async function loadDecompressHandlers() {
  const [zstdFac, lz4Fac, bz2Fac] = await Promise.all([
    loadGlueFactory('wasm-zstd.js'), loadGlueFactory('wasm-lz4.js'), loadGlueFactory('module.js'),
  ]);
  const [zstd, lz4, bz2] = await Promise.all([zstdFac(), lz4Fac(), bz2Fac()]);
  return {
    zstd: (buffer, decompressedSize) => {
      const destSize = Number(decompressedSize);
      const sp = zstd._malloc(buffer.byteLength), dp = zstd._malloc(destSize);
      zstd.HEAPU8.set(buffer, sp);
      try { const n = zstd._decompress(dp, destSize, sp, buffer.byteLength); if (n === -1) throw new Error('zstd failed'); return toUint8Array(zstd.HEAPU8, dp, n); }
      finally { zstd._free(sp); zstd._free(dp); }
    },
    lz4: (buffer, decompressedSize) => {
      const destSize = Number(decompressedSize);
      const sp = lz4._malloc(buffer.byteLength), dp = lz4._malloc(destSize);
      lz4.HEAPU8.set(buffer, sp);
      try { lz4.__ctx = lz4.__ctx ?? lz4._createDecompressionContext(); const n = lz4._decompressFrame(lz4.__ctx, dp, destSize, sp, buffer.byteLength); if (n === -1) throw new Error('lz4 failed'); return toUint8Array(lz4.HEAPU8, dp, n); }
      finally { lz4._free(sp); lz4._free(dp); }
    },
    bz2: (buffer, decompressedSize) => {
      const destSize = Number(decompressedSize);
      const sp = bz2._malloc(buffer.byteLength), dp = bz2._malloc(destSize);
      bz2.HEAPU8.set(buffer, sp);
      try { const { code, error, buffer: out } = bz2.decompress(dp, destSize, sp, buffer.byteLength, 0); if (code !== 0 || out === undefined) throw new Error(`bz2 failed: ${code} (${error})`); return new Uint8Array(out); }
      finally { bz2._free(sp); bz2._free(dp); }
    },
  };
}

async function readFirst(reader, topic, max = 1) {
  const st = reader.statistics;
  const out = [];
  for await (const m of reader.readMessages({ topics: [topic], startTime: st.messageStartTime, endTime: st.messageEndTime })) {
    out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

async function main() {
  const mcapUrl = `http://127.0.0.1:${PORT}/storage/${path.basename(FILE)}`;
  const mcapRes = await nativeFetch(mcapUrl);
  const file = new Blob([await mcapRes.arrayBuffer()]);
  console.log('file:', FILE, '| size:', file.size);

  const decompressHandlers = await loadDecompressHandlers();
  const reader = await McapIndexedReader.Initialize({
    readable: new BlobReadable(file),
    decompressHandlers,
    messageIndexCacheSizeBytes: 16 * 1024 * 1024,
  });
  console.log('Initialize OK | channels:', reader.channelsById.size, '| chunks:', reader.chunkIndexes.length);

  // ---- /lidar/points ----
  const [pcMsg] = await readFirst(reader, '/lidar/points', 1);
  console.log('\n=== /lidar/points (first message, payload', pcMsg.data.byteLength, 'bytes) ===');
  console.log('HEAD:', Buffer.from(pcMsg.data.slice(0, 100)).toString('hex'));
  console.log('TAIL:', Buffer.from(pcMsg.data.slice(pcMsg.data.byteLength - 160)).toString('hex'));
  const pc = parsePointCloud(pcMsg.data);
  console.log('timestampNanos:', pc.timestampNanos.toString());
  console.log('frameId:', JSON.stringify(pc.frameId));
  console.log('pose:', JSON.stringify(pc.pose));
  console.log('pointStride:', pc.pointStride);
  console.log('fields:', pc.fields.map((f) => `${f.name}@${f.offset}:${f.type}`).join(', '));
  console.log('pointCount:', pc.pointCount);
  console.log('expected bytes:', pc.pointCount * pc.pointStride, '(payload', pcMsg.data.byteLength + ')');
  if (pc.pointCount * pc.pointStride > pcMsg.data.byteLength) {
    throw new Error('pointCount*stride exceeds payload — parser is wrong');
  }
  const pts = extractPoints(pc, 1);
  console.log('extracted count:', pts.count, '| colors:', pts.colors ? `yes (${pts.colors.length / 3} pts)` : 'no');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity, bad = 0;
  for (let i = 0; i < pts.count; i++) {
    const x = pts.positions[i * 3], y = pts.positions[i * 3 + 1], z = pts.positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { bad++; continue; }
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  console.log(`extent x:[${fmt(minX)}, ${fmt(maxX)}] y:[${fmt(minY)}, ${fmt(maxY)}] z:[${fmt(minZ)}, ${fmt(maxZ)}] | non-finite: ${bad}`);
  console.log('sample first 3 points:', Array.from(pts.positions.slice(0, 9)).map((n) => n.toFixed(4)).join(' '));
  if (pts.count === 0 || bad / pts.count > 0.01) {
    throw new Error(`point extraction invalid (count=${pts.count}, bad=${bad})`);
  }
  // plausibility: coordinates within a few hundred meters of origin
  if (Math.abs(minX) > 500 || Math.abs(maxX) > 500 || Math.abs(minY) > 500 || Math.abs(maxY) > 500) {
    throw new Error(`point extent implausible: x[${minX},${maxX}] y[${minY},${maxY}]`);
  }

  // ---- /lidar/background_map (decimated parse) ----
  const [mapMsg] = await readFirst(reader, '/lidar/background_map', 1);
  console.log('\n=== /lidar/background_map (payload', mapMsg.data.byteLength, 'bytes) ===');
  const map = parsePointCloud(mapMsg.data);
  console.log('frameId:', JSON.stringify(map.frameId), '| stride:', map.pointStride, '| fields:', map.fields.map((f) => f.name).join(', '), '| pointCount:', map.pointCount);
  const mapPts = extractPoints(map, 8);
  console.log('extracted (dec=8):', mapPts.count, 'points | colors:', mapPts.colors ? 'yes' : 'no');
  if (mapPts.count === 0) throw new Error('background map extracted 0 points');

  // ---- /annotations/objects ----
  const [annMsg] = await readFirst(reader, '/annotations/objects', 1);
  console.log('\n=== /annotations/objects (payload', annMsg.data.byteLength, 'bytes) ===');
  const update = parseSceneUpdate(annMsg.data);
  for (const ent of update.entities) {
    console.log(`entity: id=${JSON.stringify(ent.id)} frame=${JSON.stringify(ent.frameId)} cubes=${ent.cubes.length} t=${ent.timestampNanos.toString()}`);
    const colors = new Set<string>();
    for (const c of ent.cubes) {
      colors.add(c.color ? c.color.map((n) => n.toFixed(2)).join(',') : 'none');
    }
    console.log('  distinct cube colors:', [...colors].join(' | '));
    for (const c of ent.cubes.slice(0, 3)) {
      console.log(`  cube pos=[${c.pose.position.map(fmt).join(', ')}] size=[${c.size.map(fmt).join(', ')}] color=${c.color ? c.color.map((n) => n.toFixed(2)).join(',') : 'none'}`);
    }
  }
  if (update.entities.length === 0) throw new Error('no entities parsed');
  const totalCubes = update.entities.reduce((s, e) => s + e.cubes.length, 0);
  if (totalCubes === 0) throw new Error('no cubes parsed');

  // ---- /ego/pose ----
  const [poseMsg] = await readFirst(reader, '/ego/pose', 1);
  console.log('\n=== /ego/pose (payload', poseMsg.data.byteLength, 'bytes) ===');
  const ego = parsePose(poseMsg.data);
  console.log('position:', ego.position.map(fmt).join(', '), '| orientation:', ego.orientation.map(fmt).join(', '));
  if (!ego.position.every((n) => Number.isFinite(n))) throw new Error('ego pose has non-finite values');

  console.log('\nALL PARSER VALIDATIONS PASSED');
}

main().catch((e) => { console.error('VALIDATION FAILED:', e?.message ?? e); console.error(e?.stack); nodeProcess.exit(1); })
  .finally(() => { server.closeAllConnections?.(); server.close(); nodeProcess.exit(0); });
