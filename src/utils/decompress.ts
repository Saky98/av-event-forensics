import type { DecompressHandlers } from '@mcap/core';

/**
 * Self-contained MCAP chunk decompression for browsers.
 *
 * The @foxglove/wasm-* packages ship emscripten glue that calls
 * `require("./*.wasm")` and uses Node's `Buffer` — which breaks Vite/rolldown
 * bundling and does not run in browsers. Instead of fighting the bundler, we
 * vendor the glue + wasm binaries as static assets under `public/vendor/wasm/`
 * and load them at runtime with a tiny `require` shim. All buffer handling here
 * uses plain `Uint8Array`/`ArrayBuffer`, so no Node polyfills are needed.
 *
 * The wasm binaries are only fetched when the first compressed chunk is read
 * (lazy), and are cached in a module-level promise.
 */

const GLUE_ASSET_DIR = `${import.meta.env?.BASE_URL ?? '/'}vendor/wasm/`;

type EmscriptenModule = {
  ready: Promise<unknown>;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
};

/** zstd: _decompress(destPtr, destSize, srcPtr, srcSize) -> number (or -1) */
type ZstdModule = EmscriptenModule & { _decompress(...args: number[]): number };
/** lz4: _createDecompressionContext() and _decompressFrame(context, ...) */
type Lz4Module = EmscriptenModule & {
  _createDecompressionContext(): number;
  _decompressFrame(context: number, destPtr: number, destSize: number, srcPtr: number, srcSize: number): number;
};
/** bz2: decompress(destPtr, destSize, srcPtr, srcSize, small) -> {code, error?, buffer?} */
type Bz2Module = EmscriptenModule & {
  decompress(
    destPtr: number,
    destSize: number,
    srcPtr: number,
    srcSize: number,
    small: number,
  ): { code: number; error?: string; buffer?: Uint8Array };
};

/**
 * Resolves a vendored asset to an absolute URL. `new URL(relative, base)`
 * throws when the base is relative, so we always anchor to `location` (or a
 * fallback origin outside the browser, e.g. in tests).
 */
function assetUrl(assetName: string): string {
  const base = globalThis.location?.href ?? 'http://localhost/';
  return new URL(`${GLUE_ASSET_DIR}${assetName}`, base).href;
}

/**
 * Fetches an emscripten glue script and runs it with a `require` shim that
 * resolves `.wasm` references to the vendored asset next to the glue. Returns
 * the module factory (MODULARIZE style); the caller invokes it and awaits the
 * resulting module promise.
 */
async function loadGlueFactory(assetName: string): Promise<() => Promise<EmscriptenModule>> {
  const glueUrl = assetUrl(assetName);
  const code = await (await fetch(glueUrl)).text();
  const requireShim = (path: string): string => {
    if (path.endsWith('.wasm')) {
      return new URL(path.replace(/^\.\//, ''), glueUrl).href;
    }
    throw new Error(`No require shim for non-wasm asset: ${path}`);
  };
  // The glue declares `var Module = (...)()` where Module is the MODULARIZE
  // factory. Evaluate it in a function scope so it stays isolated.
  const evaluate = new Function('require', `${code}\n;return Module;`);
  return evaluate(requireShim) as () => Promise<EmscriptenModule>;
}

function toUint8Array(heap: Uint8Array, ptr: number, length: number): Uint8Array {
  // Copy out of the wasm heap before freeing it.
  return new Uint8Array(heap.buffer.slice(ptr, ptr + length));
}

function zstdDecompress(mod: ZstdModule, src: Uint8Array, destSize: number): Uint8Array {
  const srcPtr = mod._malloc(src.byteLength);
  const destPtr = mod._malloc(destSize);
  mod.HEAPU8.set(src, srcPtr);
  try {
    const resultSize = mod._decompress(destPtr, destSize, srcPtr, src.byteLength);
    if (resultSize === -1) {
      throw new Error('zstd decompression failed');
    }
    return toUint8Array(mod.HEAPU8, destPtr, resultSize);
  } finally {
    mod._free(srcPtr);
    mod._free(destPtr);
  }
}

function lz4Decompress(mod: Lz4Module, src: Uint8Array, destSize: number): Uint8Array {
  const srcPtr = mod._malloc(src.byteLength);
  const destPtr = mod._malloc(destSize);
  mod.HEAPU8.set(src, srcPtr);
  try {
    // The lz4 decompression context is reusable; cache it on the module.
    if (mod._createDecompressionContext && (mod as { __lz4Context?: number }).__lz4Context === undefined) {
      (mod as { __lz4Context?: number }).__lz4Context = mod._createDecompressionContext();
    }
    const context = (mod as { __lz4Context?: number }).__lz4Context as number;
    const resultSize = mod._decompressFrame(context, destPtr, destSize, srcPtr, src.byteLength);
    if (resultSize === -1) {
      throw new Error('lz4 decompression failed');
    }
    return toUint8Array(mod.HEAPU8, destPtr, resultSize);
  } finally {
    mod._free(srcPtr);
    mod._free(destPtr);
  }
}

function bz2Decompress(mod: Bz2Module, src: Uint8Array, destSize: number): Uint8Array {
  const srcPtr = mod._malloc(src.byteLength);
  const destPtr = mod._malloc(destSize);
  mod.HEAPU8.set(src, srcPtr);
  try {
    const { code, error, buffer } = mod.decompress(destPtr, destSize, srcPtr, src.byteLength, 0);
    if (code !== 0 || buffer === undefined) {
      throw new Error(`bz2 decompression failed: ${code} (${error ?? 'unknown'})`);
    }
    return new Uint8Array(buffer);
  } finally {
    mod._free(srcPtr);
    mod._free(destPtr);
  }
}

let handlersPromise: Promise<DecompressHandlers> | undefined;

export function loadDecompressHandlers(): Promise<DecompressHandlers> {
  handlersPromise ??= loadHandlers();
  return handlersPromise;
}

async function loadHandlers(): Promise<DecompressHandlers> {
  const [zstdFactory, lz4Factory, bz2Factory] = await Promise.all([
    loadGlueFactory('wasm-zstd.js'),
    loadGlueFactory('wasm-lz4.js'),
    loadGlueFactory('module.js'),
  ]);
  const [zstd, lz4, bz2] = await Promise.all([
    zstdFactory(),
    lz4Factory(),
    bz2Factory(),
  ]);
  return {
    zstd: (buffer, decompressedSize) => zstdDecompress(zstd as ZstdModule, buffer, Number(decompressedSize)),
    lz4: (buffer, decompressedSize) => lz4Decompress(lz4 as Lz4Module, buffer, Number(decompressedSize)),
    bz2: (buffer, decompressedSize) => bz2Decompress(bz2 as Bz2Module, buffer, Number(decompressedSize)),
  };
}
