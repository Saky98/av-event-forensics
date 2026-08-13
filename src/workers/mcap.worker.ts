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
import { extractPoints, parsePointCloud, type ExtractedPoints } from '../utils/foxglove/pointCloud';
import { parsePose, type Pose } from '../utils/foxglove/pose';
import { parseSceneUpdate, type SceneEntity } from '../utils/foxglove/sceneUpdate';
import { yawFromQuaternion } from '../utils/coordinates';

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
  | {
      id: number;
      type: 'readLidarPoints';
      payload: { topic: string; logTime: bigint; decimation?: number };
    }
  | { id: number; type: 'readSceneEntities'; payload: { topic: string; logTime: bigint } }
  | { id: number; type: 'readPose'; payload: { topic: string; logTime: bigint } }
  | {
      id: number;
      type: 'readTelemetry';
      payload: {
        velocityTopic?: string | null;
        accelerationTopic?: string | null;
        poseTopic?: string | null;
        /** Recording start (ns) — x axis values are returned relative to it, in seconds. */
        originNs: bigint;
      };
    }
  | {
      id: number;
      type: 'readEvents';
      payload: {
        collisionTopic?: string | null;
        brakingTopic?: string | null;
        originNs: bigint;
      };
    }
  | { id: number; type: 'hashFile'; payload?: undefined }
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
/** The loaded File, kept for hashing. */
let activeFile: File | null = null;

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
  activeFile = file;
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

async function readLidarPoints(payload: {
  topic: string;
  logTime: bigint;
  decimation?: number;
}): Promise<{
  actualLogTime: bigint | null;
  points: ExtractedPoints;
}> {
  const messages = await getTopicMessages(payload.topic);
  let index = lastIndexLE(messages, payload.logTime);
  // Seek before the first recorded frame: fall back to the first available one
  // so the view is never empty right at the start of the recording.
  if (index < 0 && messages.length > 0) {
    index = 0;
  }
  if (index < 0) {
    return {
      actualLogTime: null,
      points: { positions: new Float32Array(0), colors: null, count: 0, total: 0 },
    };
  }
  const message = messages[index];
  const pc = parsePointCloud(message.data);
  const points = extractPoints(pc, payload.decimation ?? 1);
  return { actualLogTime: message.logTime, points };
}

async function readSceneEntities(payload: {
  topic: string;
  logTime: bigint;
}): Promise<{ actualLogTime: bigint | null; entities: SceneEntity[] }> {
  const messages = await getTopicMessages(payload.topic);
  let index = lastIndexLE(messages, payload.logTime);
  if (index < 0 && messages.length > 0) {
    index = 0;
  }
  if (index < 0) {
    return { actualLogTime: null, entities: [] };
  }
  const update = parseSceneUpdate(messages[index].data);
  return { actualLogTime: messages[index].logTime, entities: update.entities };
}

async function readPose(payload: {
  topic: string;
  logTime: bigint;
}): Promise<{ actualLogTime: bigint | null; pose: Pose | null }> {
  const messages = await getTopicMessages(payload.topic);
  let index = lastIndexLE(messages, payload.logTime);
  if (index < 0 && messages.length > 0) {
    index = 0;
  }
  if (index < 0) {
    return { actualLogTime: null, pose: null };
  }
  return { actualLogTime: messages[index].logTime, pose: parsePose(messages[index].data) };
}

/** Reads a std_msgs/Float64 JSON topic into a relative-seconds time series. */
async function readFloat64Series(
  topic: string | null | undefined,
  toSeconds: (logTime: bigint) => number,
): Promise<{ t: Float64Array; v: Float64Array } | null> {
  if (!topic) {
    return null;
  }
  const messages = await getTopicMessages(topic);
  if (messages.length === 0) {
    return null;
  }
  const t = new Float64Array(messages.length);
  const v = new Float64Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    let value = NaN;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(messages[i].data)) as { data?: number };
      if (typeof parsed.data === 'number') {
        value = parsed.data;
      }
    } catch {
      // malformed payload -> NaN, kept in the series for a visible gap
    }
    t[i] = toSeconds(messages[i].logTime);
    v[i] = value;
  }
  return { t, v };
}

async function readTelemetry(payload: {
  velocityTopic?: string | null;
  accelerationTopic?: string | null;
  poseTopic?: string | null;
  originNs: bigint;
}): Promise<{
  velocity: { t: Float64Array; v: Float64Array } | null;
  acceleration: { t: Float64Array; v: Float64Array } | null;
  pose: { t: Float64Array; x: Float64Array; y: Float64Array; yaw: Float64Array } | null;
}> {
  const toSeconds = (logTime: bigint): number => Number(logTime - payload.originNs) / 1e9;
  const velocity = await readFloat64Series(payload.velocityTopic, toSeconds);
  const acceleration = await readFloat64Series(payload.accelerationTopic, toSeconds);

  let pose: {
    t: Float64Array;
    x: Float64Array;
    y: Float64Array;
    yaw: Float64Array;
  } | null = null;
  if (payload.poseTopic) {
    const messages = await getTopicMessages(payload.poseTopic);
    if (messages.length > 0) {
      const t = new Float64Array(messages.length);
      const x = new Float64Array(messages.length);
      const y = new Float64Array(messages.length);
      const yaw = new Float64Array(messages.length);
      for (let i = 0; i < messages.length; i++) {
        const p = parsePose(messages[i].data);
        t[i] = toSeconds(messages[i].logTime);
        x[i] = p.position[0];
        y[i] = p.position[1];
        yaw[i] = yawFromQuaternion(p.orientation);
      }
      pose = { t, x, y, yaw };
    }
  }
  return { velocity, acceleration, pose };
}

/** Reads a std_msgs/Bool JSON topic into a 0/1 series (collision flag). */
async function readBoolSeries(
  topic: string | null | undefined,
  toSeconds: (logTime: bigint) => number,
): Promise<{ t: Float64Array; v: Int8Array } | null> {
  if (!topic) {
    return null;
  }
  const messages = await getTopicMessages(topic);
  if (messages.length === 0) {
    return null;
  }
  const t = new Float64Array(messages.length);
  const v = new Int8Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    let value: number;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(messages[i].data)) as { data?: boolean };
      value = parsed.data === true ? 1 : 0;
    } catch {
      value = 0; // malformed payload -> not a collision
    }
    t[i] = toSeconds(messages[i].logTime);
    v[i] = value;
  }
  return { t, v };
}

/** Reads /events/sudden_braking (std_msgs/String wrapping JSON) into parsed events. */
async function readBrakingEvents(
  topic: string | null | undefined,
  toSeconds: (logTime: bigint) => number,
): Promise<Array<{ t: number; event: Record<string, unknown> | null }>> {
  if (!topic) {
    return [];
  }
  const messages = await getTopicMessages(topic);
  const out: Array<{ t: number; event: Record<string, unknown> | null }> = [];
  for (const m of messages) {
    let event: Record<string, unknown> | null = null;
    try {
      const outer = JSON.parse(new TextDecoder().decode(m.data)) as {
        data?: string | Record<string, unknown>;
      };
      if (typeof outer.data === 'string') {
        event = JSON.parse(outer.data) as Record<string, unknown>;
      } else if (outer.data && typeof outer.data === 'object') {
        event = outer.data as Record<string, unknown>;
      }
    } catch {
      event = null;
    }
    out.push({ t: toSeconds(m.logTime), event });
  }
  return out;
}

async function readEvents(payload: {
  collisionTopic?: string | null;
  brakingTopic?: string | null;
  originNs: bigint;
}): Promise<{
  collision: { t: Float64Array; v: Int8Array } | null;
  braking: Array<{ t: number; event: Record<string, unknown> | null }>;
}> {
  const toSeconds = (logTime: bigint): number => Number(logTime - payload.originNs) / 1e9;
  const collision = await readBoolSeries(payload.collisionTopic, toSeconds);
  const braking = await readBrakingEvents(payload.brakingTopic, toSeconds);
  return { collision, braking };
}

/** SHA-256 of the loaded file (hex). */
async function hashFile(): Promise<string> {
  if (!activeFile) {
    throw new Error('no file loaded');
  }
  const buf = await activeFile.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
      } else if (type === 'readLidarPoints') {
        const result = await readLidarPoints(payload);
        const transfer: Transferable[] = [result.points.positions.buffer];
        if (result.points.colors) {
          transfer.push(result.points.colors.buffer);
        }
        post({ id, ok: true, result }, transfer);
      } else if (type === 'readSceneEntities') {
        post({ id, ok: true, result: await readSceneEntities(payload) });
      } else if (type === 'readPose') {
        post({ id, ok: true, result: await readPose(payload) });
      } else if (type === 'readTelemetry') {
        post({ id, ok: true, result: await readTelemetry(payload) });
      } else if (type === 'readEvents') {
        post({ id, ok: true, result: await readEvents(payload) });
      } else if (type === 'hashFile') {
        post({ id, ok: true, result: await hashFile() });
      } else if (type === 'close') {
        reader = null;
        rawCache.clear();
        activeFile = null;
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
