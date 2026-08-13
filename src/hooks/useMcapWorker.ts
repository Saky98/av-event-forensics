import { useCallback } from 'react';

/**
 * Client for the MCAP decoding worker (src/workers/mcap.worker.ts).
 *
 * Lazily creates one worker and exposes a typed request/response protocol.
 * `init` receives the File (structured-cloneable); `readImage` returns an
 * ImageBitmap that was transferred across (zero-copy).
 */

type WorkerRequest = {
  id: number;
  type: string;
  payload: unknown;
};

type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();

function getWorker(): Worker {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL('../workers/mcap.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) {
      return;
    }
    pending.delete(response.id);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(new Error(response.error));
    }
  };
  worker.onerror = (event) => {
    // Reject everything still pending so the UI does not hang on a dead worker.
    for (const [, entry] of pending) {
      entry.reject(new Error(event.message || 'MCAP worker error'));
    }
    pending.clear();
  };
  return worker;
}

function request(type: string, payload: unknown, transfer?: Transferable[]): Promise<unknown> {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const message: WorkerRequest = { id, type, payload };
    if (transfer && transfer.length > 0) {
      w.postMessage(message, transfer);
    } else {
      w.postMessage(message);
    }
  });
}

export interface ReadImageResult {
  bitmap: ImageBitmap | null;
  actualLogTime: bigint | null;
}

export interface ExtractedPoints {
  /** Interleaved xyz (3 floats per point). */
  positions: Float32Array;
  /** Interleaved rgb (3 floats per point, 0..1), or null when no intensity field. */
  colors: Float32Array | null;
  /** Points actually kept (after decimation). */
  count: number;
  /** Points present in the source message. */
  total: number;
}

export interface SceneEntity {
  timestampNanos: bigint;
  frameId: string;
  id: string;
  cubes: Array<{
    pose: { position: number[]; orientation: number[] };
    size: number[];
    color: number[] | null;
  }>;
}

export interface ReadLidarPointsResult {
  actualLogTime: bigint | null;
  points: ExtractedPoints;
}

export interface ReadSceneEntitiesResult {
  actualLogTime: bigint | null;
  entities: SceneEntity[];
}

export interface ReadPoseResult {
  actualLogTime: bigint | null;
  pose: { position: number[]; orientation: number[] } | null;
}

export interface TelemetrySeries {
  t: Float64Array;
  v: Float64Array;
}

export interface TelemetryResult {
  velocity: TelemetrySeries | null;
  acceleration: TelemetrySeries | null;
  pose: { t: Float64Array; x: Float64Array; y: Float64Array; yaw: Float64Array } | null;
}

export function useMcapWorker() {
  const initWorker = useCallback(async (file: File): Promise<void> => {
    await request('init', { file });
  }, []);

  const readImage = useCallback(
    async (
      topic: string,
      logTime: bigint,
      maxWidth?: number,
      maxHeight?: number,
    ): Promise<ReadImageResult> => {
      const result = await request('readImage', { topic, logTime, maxWidth, maxHeight });
      return result as ReadImageResult;
    },
    [],
  );

  const closeWorker = useCallback(async (): Promise<void> => {
    try {
      await request('close', undefined);
    } catch {
      // worker may already be gone
    } finally {
      worker?.terminate();
      worker = null;
      for (const [, entry] of pending) {
        entry.reject(new Error('worker closed'));
      }
      pending.clear();
    }
  }, []);

  const readLidarPoints = useCallback(
    async (topic: string, logTime: bigint, decimation?: number): Promise<ReadLidarPointsResult> => {
      const result = await request('readLidarPoints', { topic, logTime, decimation });
      return result as ReadLidarPointsResult;
    },
    [],
  );

  const readSceneEntities = useCallback(
    async (topic: string, logTime: bigint): Promise<ReadSceneEntitiesResult> => {
      const result = await request('readSceneEntities', { topic, logTime });
      return result as ReadSceneEntitiesResult;
    },
    [],
  );

  const readPose = useCallback(
    async (topic: string, logTime: bigint): Promise<ReadPoseResult> => {
      const result = await request('readPose', { topic, logTime });
      return result as ReadPoseResult;
    },
    [],
  );

  const readTelemetry = useCallback(
    async (payload: {
      velocityTopic?: string | null;
      accelerationTopic?: string | null;
      poseTopic?: string | null;
      originNs: bigint;
    }): Promise<TelemetryResult> => {
      const result = await request('readTelemetry', payload);
      return result as TelemetryResult;
    },
    [],
  );

  return { initWorker, readImage, readLidarPoints, readSceneEntities, readPose, readTelemetry, closeWorker };
}
