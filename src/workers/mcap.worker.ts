/**
 * MCAP decoding worker.
 *
 * Owns a single `McapIndexedReader` for the loaded file and serves:
 *  - `init`      : create the reader (File is structured-cloneable, no copy)
 *  - `readImage` : nearest frame <= logTime for a camera topic, JPEG decoded
 *                  to an ImageBitmap (transferred back)
 *  - `close`     : drop the reader + caches
 *
 * Heavy work (chunk decompression, flatbuffer parsing, image decode) stays off
 * the UI thread; only small bitmaps cross the boundary.
 *
 * Note: decoded bitmaps are NOT cached here — a transferred ImageBitmap is
 * detached on the worker side, so a cached entry would hold a dead bitmap.
 * Raw message bytes are cached per topic instead, and each request decodes
 * fresh (fast at preview resolution).
 */

import { BlobReadable } from '@mcap/browser';
import { McapIndexedReader, type Message } from '@mcap/core';
import { loadDecompressHandlers } from '../utils/decompress';
import { mimeForFormat, parseCompressedImage } from '../utils/foxglove/compressedImage';

const MESSAGE_INDEX_CACHE_BYTES = 16 * 1024 * 1024;
/** Preview decode size (grid panels are small; full-res can come later). */
const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 360;

type WorkerRequest =
  | { id: number; type: 'init'; payload: { file: File } }
  | {
      id: number;
      type: 'readImage';
      payload: { topic: string; logTime: bigint; maxWidth?: number; maxHeight?: number };
    }
  | { id: number; type: 'close'; payload?: undefined };

/** Minimal worker scope (DedicatedWorkerGlobalScope is not in the DOM lib). */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

let reader: McapIndexedReader | null = null;
/** Raw messages per topic (lazily read once, then reused for seeks). */
const rawCache = new Map<string, Message[]>();

function post(message: unknown, transfer?: Transferable[]): void {
  if (transfer !== undefined && transfer.length > 0) {
    ctx.postMessage(message, transfer);
  } else {
    ctx.postMessage(message);
  }
}

function lastIndexLE(messages: Message[], target: bigint): number {
  let lo = 0;
  let hi = messages.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].logTime <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

async function init(file: File): Promise<{ channels: number; chunks: number }> {
  const decompressHandlers = await loadDecompressHandlers();
  reader = await McapIndexedReader.Initialize({
    readable: new BlobReadable(file),
    decompressHandlers,
    messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
  });
  rawCache.clear();
  return { channels: reader.channelsById.size, chunks: reader.chunkIndexes.length };
}

function getTopicMessages(topic: string): Promise<Message[]> {
  const cached = rawCache.get(topic);
  if (cached) {
    return Promise.resolve(cached);
  }
  return (async () => {
    const messages: Message[] = [];
    if (reader) {
      for await (const message of reader.readMessages({ topics: [topic] })) {
        messages.push(message);
      }
      messages.sort((a, b) =>
        a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : a.sequence - b.sequence,
      );
    }
    rawCache.set(topic, messages);
    return messages;
  })();
}

async function readImage(payload: {
  topic: string;
  logTime: bigint;
  maxWidth?: number;
  maxHeight?: number;
}): Promise<{ bitmap: ImageBitmap | null; actualLogTime: bigint | null }> {
  const messages = await getTopicMessages(payload.topic);
  const index = lastIndexLE(messages, payload.logTime);
  if (index < 0) {
    return { bitmap: null, actualLogTime: null };
  }
  const message = messages[index];
  const image = parseCompressedImage(message.data);
  const blob = new Blob([image.data as BlobPart], { type: mimeForFormat(image.format) });
  const width = payload.maxWidth ?? PREVIEW_WIDTH;
  const height = payload.maxHeight ?? PREVIEW_HEIGHT;
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: Math.max(1, Math.round(width)),
    resizeHeight: Math.max(1, Math.round(height)),
    resizeQuality: 'medium',
  });
  return { bitmap, actualLogTime: message.logTime };
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = event.data;
  void (async () => {
    try {
      if (type === 'init') {
        post({ id, ok: true, result: await init(payload.file) });
      } else if (type === 'readImage') {
        const result = await readImage(payload);
        const transfer = result.bitmap ? [result.bitmap] : [];
        post({ id, ok: true, result }, transfer);
      } else if (type === 'close') {
        reader = null;
        rawCache.clear();
        post({ id, ok: true, result: undefined });
      } else {
        post({ id, ok: false, error: `unknown request type: ${String(type)}` });
      }
    } catch (error) {
      post({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
};

export {};
