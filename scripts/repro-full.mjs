// Full browser-path repro: serve storage + vendor wasm over http, browser-sim env,
// exact decompress.ts logic, then load the REAL mcap + read messages (forces decompression).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';

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

// ---- exact copy of src/utils/decompress.ts ----
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

// ---- load the REAL file exactly like the app ----
try {
  const mcapUrl = `http://127.0.0.1:${PORT}/storage/Town02_with_map.mcap`;
  const mcapRes = await nativeFetch(mcapUrl);
  const file = new Blob([await mcapRes.arrayBuffer()]); // simulates the picked File
  console.log('file size:', file.size);

  const decompressHandlers = await loadDecompressHandlers();
  console.log('decompress handlers loaded OK');

  const reader = await McapIndexedReader.Initialize({
    readable: new BlobReadable(file),
    decompressHandlers,
    messageIndexCacheSizeBytes: 16 * 1024 * 1024,
  });
  console.log('Initialize OK | channels:', reader.channelsById.size, '| chunks:', reader.chunkIndexes.length);

  const topics = [];
  for (const ch of reader.channelsById.values()) {
    const schema = reader.schemasById.get(ch.schemaId);
    topics.push({ topic: ch.topic, schemaName: schema?.name, messageCount: Number(reader.statistics?.channelMessageCounts.get(ch.id)) });
  }
  console.log('buildTopics OK:', topics.length, 'topics');

  // force real chunk decompression + message reading with the file's actual time range
  const st = reader.statistics;
  let n = 0, bytes = 0;
  for await (const m of reader.readMessages({ topics: ['/lidar/points'], startTime: st.messageStartTime, endTime: st.messageEndTime })) {
    n++; bytes += m.data.byteLength; if (n === 1) console.log('first logTime:', m.logTime.toString(), '| payload bytes:', m.data.byteLength);
  }
  console.log('readMessages OK:', n, 'lidar messages |', bytes, 'payload bytes (real zstd chunk decompression)');
  console.log('\nFULL BROWSER-PATH REPRO: SUCCESS');
} catch (e) {
  console.error('\nREPRODUCED ERROR:', e?.message ?? String(e));
  console.error(e?.stack?.split('\n').slice(0, 8).join('\n'));
}
server.closeAllConnections?.();
server.close();
nodeProcess.exit(0);
