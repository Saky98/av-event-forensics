// make_compromised.mjs
// Creates storage/compromised/Town02_with_map.mcap — a copy of the original
// with ONE atomic alteration on frame 20 of /ego/velocity (an extra 0.1 m/s).
// Re-encodes through @mcap/core so the output is a valid, loadable MCAP whose
// file hash differs and whose frame chain diverges from the original — useful
// for demoing the integrity snapshot comparison.
//
// Run: node --experimental-strip-types scripts/make_compromised.mjs

import fs from 'node:fs';
import path from 'node:path';
import { McapIndexedReader, McapWriter, TempBuffer } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';

// Usage: node --experimental-strip-types scripts/make_compromised.mjs [src] [dst] [frame]
const SRC = process.argv[2] ?? 'storage/Town02_with_map.mcap';
const DST = process.argv[3] ?? SRC.replace(/\.mcap$/, '-compromised.mcap');
const TAMPER_TOPIC = '/ego/velocity';
const TAMPER_FRAME = Number(process.argv[4] ?? 20); // 0-based

// ---- decompress glue (browser-sim, mirroring the smoke tests) ----
const PORT_SERVER = await (async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/vendor/wasm/')) {
      const file = path.resolve('public/vendor/wasm', path.basename(url));
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'application/javascript' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
})();
const BASE = `http://127.0.0.1:${PORT_SERVER}/vendor/wasm/`;
const nodeProcess = process;
delete globalThis.process;
globalThis.window = {}; globalThis.self = globalThis; globalThis.document = { currentScript: undefined };
globalThis.location = { href: BASE + 'x.js' };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const abs = url.startsWith('/') ? `http://127.0.0.1:${PORT_SERVER}${url}` : url;
  return nativeFetch(abs, init);
};
const GLUE_ASSET_DIR = '/vendor/wasm/';
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

// ---- load original ----
const buf = fs.readFileSync(SRC);
const reader = await McapIndexedReader.Initialize({
  readable: new BlobReadable(new Blob([buf])),
  decompressHandlers: await loadDecompressHandlers(),
  messageIndexCacheSizeBytes: 16 * 1024 * 1024,
});

// Collect all messages in a single pass, altering the tamper topic's frame 20.
const messages = [];
let tampered = 0;
const all = [];
for await (const m of reader.readMessages({})) {
  all.push(m);
}
// Assign a stable order by logTime + sequence.
all.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : a.sequence - b.sequence));

// Per-topic collection of the tamper topic (sorted) so frame 20 is well-defined.
const tamperMsgs = all.filter((m) => reader.channelsById.get(m.channelId)?.topic === TAMPER_TOPIC);
tamperMsgs.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : a.sequence - b.sequence));
const target = tamperMsgs[TAMPER_FRAME];
if (target) {
  const plain = JSON.parse(new TextDecoder().decode(target.data));
  if (typeof plain.data === 'number') {
    plain.data = Math.round((plain.data + 0.1) * 100) / 100; // keep deterministic
    target.data = new TextEncoder().encode(JSON.stringify({ data: plain.data }));
    tampered++;
    console.log(`  → tampered ${TAMPER_TOPIC}, frame ${TAMPER_FRAME}: data = ${plain.data}`);
  }
}
for (const m of all) messages.push(m);

// ---- re-encode ----
const tmp = new TempBuffer();
const writer = new McapWriter({
  writable: tmp,
  useChunks: true,
  useStatistics: true,
  useSummaryOffsets: true,
  useMessageIndex: true,
  useChunkIndex: true,
});
await writer.start({ profile: reader.header.profile ?? '', library: reader.header.library ?? '' });
// register schemas -> map original id to new id
const schemaMap = new Map();
for (const [id, schema] of reader.schemasById) {
  const nid = await writer.registerSchema({ name: schema.name, encoding: schema.encoding, data: schema.data });
  schemaMap.set(id, nid);
}
// register channels -> map original id to new id
const channelMap = new Map();
for (const [id, ch] of reader.channelsById) {
  const nid = await writer.registerChannel({ schemaId: schemaMap.get(ch.schemaId), topic: ch.topic, messageEncoding: ch.messageEncoding, metadata: ch.metadata });
  channelMap.set(id, nid);
}
for (const m of messages) {
  await writer.addMessage({
    channelId: channelMap.get(m.channelId),
    sequence: m.sequence,
    logTime: m.logTime,
    publishTime: m.publishTime,
    data: m.data,
  });
}
await writer.end();
const out = tmp.get();

fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.writeFileSync(DST, out);
console.log(`\nWrote ${DST} (${out.length} bytes, ${tampered} frame tampered).`);
// Original Node process (saved before the browser-sim `delete globalThis.process`).
nodeProcess.exit(0);
