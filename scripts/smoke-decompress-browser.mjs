// Validates the browser decompression path: vendored emscripten glue loaded at
// runtime with a `require` shim (same code as src/utils/decompress.ts), in a
// browser-like environment (no `process`, fetch over http).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const WASM_DIR = path.resolve('public/vendor/wasm');

// ---- 1) prepare compressed payloads using Node-native packages FIRST ----
const zstd = require('@foxglove/wasm-zstd');
await zstd.isLoaded;
const expectedZstd = new TextEncoder().encode('hello zstd world '.repeat(50));
const zstdData = new Uint8Array(zstd.compress(expectedZstd, 5));

const expectedLz4 = new TextEncoder().encode('hello hello'); // 11 bytes
// MCAP lz4 chunks use LZ4 *frame* format (matches @mcap/support, which feeds
// chunk bytes to wasm-lz4's LZ4F_decompress). Generate a real frame with python.
const lz4Data = execFileSync('python3', ['-c', 'import lz4.frame,sys; sys.stdout.buffer.write(lz4.frame.compress(sys.stdin.buffer.read()))'], { input: expectedLz4 });

const expectedBz2 = new TextEncoder().encode('bzip2 payload '.repeat(40));
const bz2Data = execFileSync('python3', ['-c', 'import bz2,sys; sys.stdout.buffer.write(bz2.compress(sys.stdin.buffer.read()))'], { input: expectedBz2 });

// ---- 2) start a tiny static http server for the vendored assets ----
const server = http.createServer((req, res) => {
  const rel = req.url.split('?')[0].replace(/^\/vendor\/wasm\//, '').replace(/^\/+/, '');
  const file = path.join(WASM_DIR, path.basename(rel));
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const GLUE_ASSET_DIR = '/vendor/wasm/'; // relative, like import.meta.env.BASE_URL in the app

// ---- 3) browser-like environment ----
const nodeProcess = process;
delete globalThis.process;
globalThis.window = {};
globalThis.self = globalThis;
globalThis.document = { currentScript: undefined };
globalThis.location = { href: 'http://127.0.0.1:' + PORT + '/vendor/wasm/x.js' };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const abs = url.startsWith('/') ? `http://127.0.0.1:${PORT}${url}` : url;
  return nativeFetch(abs, init);
};

// ---- 4) replicate src/utils/decompress.ts exactly ----
function assetUrl(assetName) {
  const base = globalThis.location?.href ?? 'http://localhost/';
  return new URL(`${GLUE_ASSET_DIR}${assetName}`, base).href;
}
async function loadGlueFactory(assetName) {
  const glueUrl = assetUrl(assetName);
  const code = await (await nativeFetch(glueUrl)).text();
  const requireShim = (p) => {
    if (p.endsWith('.wasm')) return new URL(p.replace(/^\.\//, ''), glueUrl).href;
    throw new Error(`No require shim for non-wasm asset: ${p}`);
  };
  const evaluate = new Function('require', `${code}\n;return Module;`);
  return evaluate(requireShim);
}
const toUint8Array = (heap, ptr, length) => new Uint8Array(heap.buffer.slice(ptr, ptr + length));

const [zstdFac, lz4Fac, bz2Fac] = await Promise.all([
  loadGlueFactory('wasm-zstd.js'),
  loadGlueFactory('wasm-lz4.js'),
  loadGlueFactory('module.js'),
]);
const [zm, lm, bm] = await Promise.all([zstdFac(), lz4Fac(), bz2Fac()]);

function zstdDecompress(src, destSize) {
  const sp = zm._malloc(src.byteLength), dp = zm._malloc(destSize);
  zm.HEAPU8.set(src, sp);
  try {
    const n = zm._decompress(dp, destSize, sp, src.byteLength);
    if (n === -1) throw new Error('zstd failed');
    return toUint8Array(zm.HEAPU8, dp, n);
  } finally { zm._free(sp); zm._free(dp); }
}
function lz4Decompress(src, destSize) {
  const sp = lm._malloc(src.byteLength), dp = lm._malloc(destSize);
  lm.HEAPU8.set(src, sp);
  try {
    lm.__ctx = lm.__ctx ?? lm._createDecompressionContext();
    const n = lm._decompressFrame(lm.__ctx, dp, destSize, sp, src.byteLength);
    if (n === -1) throw new Error('lz4 failed');
    return toUint8Array(lm.HEAPU8, dp, n);
  } finally { lm._free(sp); lm._free(dp); }
}
function bz2Decompress(src, destSize) {
  const sp = bm._malloc(src.byteLength), dp = bm._malloc(destSize);
  bm.HEAPU8.set(src, sp);
  try {
    const { code, error, buffer } = bm.decompress(dp, destSize, sp, src.byteLength, 0);
    if (code !== 0 || buffer === undefined) throw new Error(`bz2 failed: ${code} (${error})`);
    return new Uint8Array(buffer);
  } finally { bm._free(sp); bm._free(dp); }
}

// ---- 5) decompress & compare ----
const assert = (cond, label) => { if (!cond) { console.error('FAIL:', label); process.exit(1); } console.log('PASS:', label); };

const zOut = zstdDecompress(zstdData, expectedZstd.length);
assert(zOut.length === expectedZstd.length && zOut.every((b, i) => b === expectedZstd[i]), 'zstd glue decompresses real payload (browser-sim)');

const lOut = lz4Decompress(lz4Data, expectedLz4.length);
assert(lOut.length === expectedLz4.length && lOut.every((b, i) => b === expectedLz4[i]), `lz4 glue decompresses LZ4 frame ("${new TextDecoder().decode(lOut)}")`);

const bOut = bz2Decompress(bz2Data, expectedBz2.length);
assert(bOut.length === expectedBz2.length && bOut.every((b, i) => b === expectedBz2[i]), 'bz2 glue decompresses bzip2 stream (browser-sim)');

server.closeAllConnections?.();
server.close();
console.log('\nBROWSER-SIM DECOMPRESSION OK');
nodeProcess.exit(0);
