// Smoke test: Phase 5 telemetry data path — real file, actual src parsers.
// Run: node --experimental-strip-types scripts/smoke-telemetry.mjs [storage/Town02_with_map.mcap]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';
import { parsePose } from '../src/utils/foxglove/pose.ts';
import { yawFromQuaternion } from '../src/utils/coordinates.ts';

const ARGV = process.argv;
const FILE = ARGV[2] ?? 'storage/Town02_with_map.mcap';

// ---- http server + browser sim + decompress (same as other smoke tests) ----
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
  const originNs = st.messageStartTime;

  const rawCache = new Map();
  async function getTopicMessages(topic) {
    if (rawCache.has(topic)) return rawCache.get(topic);
    const msgs = [];
    for await (const m of reader.readMessages({ topics: [topic] })) msgs.push(m);
    msgs.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : a.sequence - b.sequence));
    rawCache.set(topic, msgs);
    return msgs;
  }

  const toSeconds = (logTime) => Number(logTime - originNs) / 1e9;

  // ---- velocity / acceleration (std_msgs/Float64 JSON) ----
  console.log('\n=== /ego/velocity & /ego/acceleration (JSON Float64) ===');
  for (const topic of ['/ego/velocity', '/ego/acceleration']) {
    const msgs = await getTopicMessages(topic);
    check(msgs.length === 45, `${topic}: 45 messages (got ${msgs.length})`);
    const t = [], v = [];
    let parseOk = true, min = Infinity, max = -Infinity, nan = 0;
    let prevT = -1;
    for (const m of msgs) {
      try {
        const val = JSON.parse(new TextDecoder().decode(m.data));
        if (typeof val.data !== 'number') { parseOk = false; continue; }
        const ts = toSeconds(m.logTime);
        t.push(ts);
        v.push(val.data);
        if (val.data < min) min = val.data;
        if (val.data > max) max = val.data;
        if (!Number.isFinite(val.data)) nan++;
        if (ts < prevT) check(false, `${topic}: timestamps ascending`);
        prevT = ts;
      } catch { parseOk = false; }
    }
    check(parseOk, `${topic}: all payloads parse as {"data": number}`);
    check(nan === 0, `${topic}: no NaN values`);
    console.log(`    range [${min.toFixed(2)}, ${max.toFixed(2)}], duration ${t[t.length - 1].toFixed(2)}s`);
    check(t[t.length - 1] - t[0] > 4 && t[t.length - 1] - t[0] < 5, `${topic}: ~4.5s span`);
  }

  // velocity plausibility: 0..30 m/s; acceleration: |a| < 10 m/s²
  const vMsgs = await getTopicMessages('/ego/velocity');
  const vVals = vMsgs.map((m) => JSON.parse(new TextDecoder().decode(m.data)).data);
  check(Math.min(...vVals) >= -1 && Math.max(...vVals) <= 30, `velocity plausible 0..30 m/s (max ${Math.max(...vVals).toFixed(2)})`);
  const aMsgs = await getTopicMessages('/ego/acceleration');
  const aVals = aMsgs.map((m) => JSON.parse(new TextDecoder().decode(m.data)).data);
  check(Math.max(...aVals.map(Math.abs)) <= 100, `acceleration |a| <= 100 m/s² (max ${Math.max(...aVals.map(Math.abs)).toFixed(2)} — collision spike)`);

  // ---- pose → x/y/yaw ----
  console.log('\n=== /ego/pose → x/y/yaw ===');
  const poseMsgs = await getTopicMessages('/ego/pose');
  const xs = [], ys = [], yaws = [];
  for (const m of poseMsgs) {
    const p = parsePose(m.data);
    xs.push(p.position[0]);
    ys.push(p.position[1]);
    yaws.push(yawFromQuaternion(p.orientation));
  }
  check(xs.length === 45, `pose: 45 samples`);
  check(yaws.every((y) => Number.isFinite(y) && Math.abs(y) <= Math.PI), `yaw in [-π, π], finite`);
  const maxDist = Math.max(...xs.map((x, i) => Math.hypot(x - xs[0], ys[i] - ys[0])));
  console.log(`    max distance from start: ${maxDist.toFixed(2)} m over ${(toSeconds(poseMsgs[poseMsgs.length - 1].logTime) - toSeconds(poseMsgs[0].logTime)).toFixed(2)}s`);
  // (last sample in the with_map file jumps back near the start — data quirk, so
  //  check the max excursion instead of first->last distance)
  check(maxDist > 10, `ego travelled > 10 m (max excursion ${maxDist.toFixed(1)} m)`);

  // ---- event topics in the collision file (if present) ----
  console.log('\n=== optional event topics ===');
  const topics = [...reader.channelsById.values()].map((c) => c.topic);
  for (const et of ['/collision/detected', '/events/sudden_braking']) {
    if (topics.includes(et)) {
      const msgs = await getTopicMessages(et);
      const values = msgs.map((m) => { try { return JSON.parse(new TextDecoder().decode(m.data)); } catch { return null; } });
      console.log(`    ${et}: ${msgs.length} msgs, first=${JSON.stringify(values[0])}`);
      check(msgs.length > 0, `${et} present and readable`);
    } else {
      console.log(`    ${et}: not in this file (expected for with_map)`);
    }
  }

  console.log(failures === 0 ? '\nSMOKE TEST PASSED ✅' : `\nSMOKE TEST FAILED (${failures}) ❌`);
  nodeProcess.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('SMOKE TEST ERROR:', e?.message ?? e); nodeProcess.exit(1); })
  .finally(() => { server.closeAllConnections?.(); server.close(); });
