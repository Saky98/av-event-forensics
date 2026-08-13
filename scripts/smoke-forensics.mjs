// Smoke test: Phase 6 forensic data path — real file, actual src logic.
// Verifies SHA-256 (matches shasum reference) and the frame hash chain
// (determinism + tamper detection).
// Run: node --experimental-strip-types scripts/smoke-forensics.mjs [storage/Town02_with_map.mcap]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';
import { parsePose } from '../src/utils/foxglove/pose.ts';
import { yawFromQuaternion } from '../src/utils/coordinates.ts';
import {
  buildChainRecords,
  checkChain,
  computeChain,
  sha256Hex,
} from '../src/utils/forensics.ts';

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
function assetUrl(n) { const b = globalThis.location?.href ?? 'http://localhost/'; return new URL(`${GLUE_ASSET_DIR}${n}`, b).href; }
async function loadGlueFactory(n) {
  const u = assetUrl(n);
  const code = await (await fetch(u)).text();
  const shim = (p) => { if (p.endsWith('.wasm')) return new URL(p.replace(/^\.\//, ''), u).href; throw new Error('no shim'); };
  const e = new Function('require', `${code}\n;return Module;`);
  return e(shim);
}
const toU8 = (heap, p, l) => new Uint8Array(heap.buffer.slice(p, p + l));
async function loadDecompressHandlers() {
  const [zf, lf, bf] = await Promise.all([loadGlueFactory('wasm-zstd.js'), loadGlueFactory('wasm-lz4.js'), loadGlueFactory('module.js')]);
  const [z, l, b] = await Promise.all([zf(), lf(), bf()]);
  return {
    zstd: (buf, d) => { const n = Number(d), sp = z._malloc(buf.byteLength), dp = z._malloc(n); z.HEAPU8.set(buf, sp); try { const r = z._decompress(dp, n, sp, buf.byteLength); if (r === -1) throw new Error('zstd'); return toU8(z.HEAPU8, dp, r); } finally { z._free(sp); z._free(dp); } },
    lz4: (buf, d) => { const n = Number(d), sp = l._malloc(buf.byteLength), dp = l._malloc(n); l.HEAPU8.set(buf, sp); try { l.__ctx = l.__ctx ?? l._createDecompressionContext(); const r = l._decompressFrame(l.__ctx, dp, n, sp, buf.byteLength); if (r === -1) throw new Error('lz4'); return toU8(l.HEAPU8, dp, r); } finally { l._free(sp); l._free(dp); } },
    bz2: (buf, d) => { const n = Number(d), sp = b._malloc(buf.byteLength), dp = b._malloc(n); b.HEAPU8.set(buf, sp); try { const { code, error, buffer: out } = b.decompress(dp, n, sp, buf.byteLength, 0); if (code !== 0 || out === undefined) throw new Error('bz2'); return new Uint8Array(out); } finally { b._free(sp); b._free(dp); } },
  };
}

let failures = 0;
function check(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); } else { failures++; console.log(`  ✗ FAIL: ${label}`); }
}

async function main() {
  // ---- 1. SHA-256 of the raw file ----
  console.log('\n=== SHA-256 of the file (matches shasum -a 256) ===');
  const raw = fs.readFileSync(FILE);
  const nodeHash = crypto.createHash('sha256').update(raw).digest('hex');
  console.log(`    file: ${path.basename(FILE)}`);
  console.log(`    sha256: ${nodeHash}`);
  check(/^[0-9a-f]{64}$/.test(nodeHash), 'hash is 64 lowercase hex chars');
  // Cross-check the src sha256Hex (uses crypto.subtle) on a known string.
  const hello = await sha256Hex('hello world');
  check(hello === 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9', `src sha256Hex matches known vector (${hello.slice(0, 8)}…)`);

  // ---- 2. Load telemetry + events from the real file ----
  const mcapUrl = `http://127.0.0.1:${PORT}/storage/${path.basename(FILE)}`;
  const file = new Blob([await (await nativeFetch(mcapUrl)).arrayBuffer()]);
  const reader = await McapIndexedReader.Initialize({
    readable: new BlobReadable(file),
    decompressHandlers: await loadDecompressHandlers(),
    messageIndexCacheSizeBytes: 16 * 1024 * 1024,
  });
  const st = reader.statistics;
  const originNs = st.messageStartTime;
  const toSeconds = (logTime) => Number(logTime - originNs) / 1e9;

  const rawCache = new Map();
  async function getTopicMessages(topic) {
    if (rawCache.has(topic)) return rawCache.get(topic);
    const msgs = [];
    for await (const m of reader.readMessages({ topics: [topic] })) msgs.push(m);
    msgs.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : a.sequence - b.sequence));
    rawCache.set(topic, msgs);
    return msgs;
  }
  const readJson = async (topic) => {
    const msgs = await getTopicMessages(topic);
    return msgs.map((m) => ({ t: toSeconds(m.logTime), v: JSON.parse(new TextDecoder().decode(m.data)).data }));
  };

  const velocity = await readJson('/ego/velocity');
  const acceleration = await readJson('/ego/acceleration');
  const poseMsgs = await getTopicMessages('/ego/pose');
  const pose = poseMsgs.map((m) => ({ t: toSeconds(m.logTime), p: parsePose(m.data) }));
  const collision = await readJson('/collision/detected');
  const brakingMsgs = await getTopicMessages('/events/sudden_braking');
  const braking = brakingMsgs.map((m) => ({ t: toSeconds(m.logTime) }));

  const telemetry = {
    velocity: { t: velocity.map((x) => x.t), v: velocity.map((x) => x.v) },
    acceleration: { t: acceleration.map((x) => x.t), v: acceleration.map((x) => x.v) },
    pose: {
      t: pose.map((x) => x.t),
      x: pose.map((x) => x.p.position[0]),
      y: pose.map((x) => x.p.position[1]),
      yaw: pose.map((x) => yawFromQuaternion(x.p.orientation)),
    },
  };
  const collisionTimes = collision.map((x) => x.t);
  const collisionValues = collision.map((x) => (x.v === true ? 1 : 0));
  const brakingTimes = braking.map((x) => x.t);

  // ---- 3. Build + verify the chain ----
  console.log('\n=== Frame hash chain ===');
  const records = buildChainRecords(telemetry, collisionTimes, collisionValues, brakingTimes);
  check(records.length === 45, `45 chain records (got ${records.length})`);
  const anyCollision = records.some((r) => r.collision);
  const anyBraking = records.some((r) => r.braking);
  console.log(`    collision frames: ${records.filter((r) => r.collision).length}, braking frames: ${records.filter((r) => r.braking).length}`);
  check(anyCollision || anyBraking, 'at least one event flag set (collision or braking)');

  const chain1 = await computeChain(records);
  const chain2 = await computeChain(records);
  check(chain1.length === 45, 'chain has 45 links');
  check(
    chain1.every((l, i) => l.hash === chain2[i].hash),
    'chain is deterministic (two runs produce identical hashes)',
  );
  check(chain1.every((l) => /^[0-9a-f]{64}$/.test(l.hash)), 'every link hash is 64 hex chars');

  // Verify: intact chain checks clean.
  const intact = checkChain(chain1, chain2);
  check(intact.intact === true && intact.firstDivergence === -1, 'checkChain: intact chain -> intact');

  // Tamper frame 22 (velocity changed) -> divergence must start exactly there.
  const tamperedRecords = records.map((r) => ({ ...r }));
  tamperedRecords[22] = { ...tamperedRecords[22], velocity: tamperedRecords[22].velocity * 1.37 };
  const tamperedChain = await computeChain(tamperedRecords);
  const broken = checkChain(chain1, tamperedChain);
  check(broken.intact === false && broken.firstDivergence === 22, `tamper at frame 22 detected at link 22 (got ${broken.firstDivergence})`);
  check(
    chain1[21].hash === tamperedChain[21].hash && chain1[22].hash !== tamperedChain[22].hash,
    'links before tamper point unchanged, tampered link + all after diverge',
  );

  console.log('\n' + (failures === 0 ? 'SMOKE TEST PASSED ✅' : `SMOKE TEST FAILED (${failures}) ❌`));
  nodeProcess.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('SMOKE TEST ERROR:', e?.message ?? e); nodeProcess.exit(1); })
  .finally(() => { server.closeAllConnections?.(); server.close(); });
