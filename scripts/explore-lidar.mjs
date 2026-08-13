// Explore the real MCAP file: dump schemas + first-message info for lidar topics.
// Usage: node scripts/explore-lidar.mjs [storage/Town02_with_map.mcap]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';

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

// ---- decompress handlers (inline copy of src/utils/decompress.ts logic) ----
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

  const relevant = ['lidar', 'annotat', 'ego', 'pose', 'box', 'point', 'tf', 'transform'];
  console.log('\n=== TOPICS ===');
  for (const ch of reader.channelsById.values()) {
    const schema = reader.schemasById.get(ch.schemaId);
    const count = Number(reader.statistics?.channelMessageCounts.get(ch.id) ?? 0n);
    const isRelevant = relevant.some((r) => ch.topic.toLowerCase().includes(r));
    if (isRelevant) {
      console.log(`\n--- ${ch.topic}`);
      console.log(`    schema: ${schema?.name} | encoding: ${ch.messageEncoding} | messages: ${count}`);
      if (schema) {
        const text = schema.data?.toString() ?? '';
        console.log('    schema.data (first 2000 chars):');
        console.log(text.slice(0, 2000));
      }
    }
  }

  const st = reader.statistics;
  const topics = [
    '/lidar/points',
    '/lidar/background_map',
    '/annotations/objects',
    '/ego/pose',
    '/ego/vehicle_info',
  ];
  for (const topic of topics) {
    const ch = [...reader.channelsById.values()].find((c) => c.topic === topic);
    if (!ch) { console.log(`\n=== ${topic}: NOT FOUND`); continue; }
    const schema = reader.schemasById.get(ch.schemaId);
    console.log(`\n=== ${topic} | schema=${schema?.name} | encoding=${ch.messageEncoding}`);
    let first = null, count = 0;
    for await (const m of reader.readMessages({ topics: [topic], startTime: st.messageStartTime, endTime: st.messageEndTime })) {
      if (count === 0) first = m;
      count++;
      if (count >= 2) break;
    }
    if (first) {
      console.log(`first logTime: ${first.logTime.toString()} | payload ${first.data.byteLength} bytes`);
      console.log('payload hex (first 96 bytes):', Buffer.from(first.data.slice(0, 96)).toString('hex'));
    }
    console.log('read:', count, 'messages (capped at 2)');
  }
}

main().catch((e) => { console.error('ERROR:', e?.message ?? e); nodeProcess.exit(1); })
  .finally(() => { server.closeAllConnections?.(); server.close(); nodeProcess.exit(0); });
