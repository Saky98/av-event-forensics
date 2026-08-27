/**
 * Snapshot helpers: capture a camera frame and a LiDAR scene as PNG data
 * URLs for the exported HTML report, at the current timeline timestamp.
 */

import * as THREE from 'three';
import type { SceneEntity } from '../hooks/useMcapWorker';
import { transformPositions } from './coordinates';
import { buildMapMesh, buildSweepMesh, rebuildBoxes, updateEgoMarker } from './lidarScene';

export interface SnapshotWorker {
  readImage: (
    topic: string,
    logTime: bigint,
    maxW?: number,
    maxH?: number,
  ) => Promise<{ bitmap: ImageBitmap | null; actualLogTime: bigint | null }>;
  readLidarPoints: (
    topic: string,
    logTime: bigint,
    decimation?: number,
  ) => Promise<{ actualLogTime: bigint | null; points: { positions: Float32Array; colors: Float32Array | null; count: number } }>;
  readSceneEntities: (topic: string, logTime: bigint) => Promise<{ actualLogTime: bigint | null; entities: SceneEntity[] }>;
  readPose: (topic: string, logTime: bigint) => Promise<{
    actualLogTime: bigint | null;
    pose: { position: number[]; orientation: number[] } | null;
  }>;
}

export interface LidarSnapshotConfig {
  seekTime: bigint;
  lidarPointTopics: string[];
  lidarMapTopics: string[];
  annotationTopics: string[];
  egoPoseTopic: string | null;
  decimation?: number;
  pointSize?: number;
  width?: number;
  height?: number;
}

const SNAP_DECIMATION = 2;
const MAP_DECIMATION = 8;
const SNAP_POINT_SIZE = 1.6;
const SNAP_WIDTH = 960;
const SNAP_HEIGHT = 540;

/** Draws one camera frame to a canvas and returns a PNG data URL. */
export async function captureCamera(
  worker: SnapshotWorker,
  topic: string,
  seekTime: bigint,
  maxW = 640,
  maxH = 360,
): Promise<string | null> {
  const result = await worker.readImage(topic, seekTime, maxW, maxH);
  if (!result.bitmap) {
    return null;
  }
  const bitmap = result.bitmap;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

/** Renders an offscreen LiDAR scene and returns a PNG data URL. */
export async function captureLidar(
  worker: SnapshotWorker,
  cfg: LidarSnapshotConfig,
): Promise<string | null> {
  const width = cfg.width ?? SNAP_WIDTH;
  const height = cfg.height ?? SNAP_HEIGHT;
  const decimation = cfg.decimation ?? SNAP_DECIMATION;
  const pointSize = cfg.pointSize ?? SNAP_POINT_SIZE;
  const seek = cfg.seekTime;

  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.top = '-9999px';
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);

  let renderer: THREE.WebGLRenderer | null = null;
  try {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 2000);
    camera.position.set(45, 42, 65);

    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    // Ground grid + axes, mirroring the live LiDAR view.
    scene.add(new THREE.GridHelper(200, 40, 0x2a3b4d, 0x1a2733));
    scene.add(new THREE.AxesHelper(6));

    const sweepGroup = new THREE.Group();
    const mapGroup = new THREE.Group();
    const boxesGroup = new THREE.Group();
    const egoGroup = new THREE.Group();
    scene.add(sweepGroup, mapGroup, boxesGroup, egoGroup);

    const jobs: Promise<void>[] = [];

    for (const topic of cfg.lidarMapTopics) {
      jobs.push(
        worker.readLidarPoints(topic, seek, MAP_DECIMATION).then((r) => {
          const positions = r.points.positions;
          transformPositions(positions);
          mapGroup.add(buildMapMesh(positions, r.points.colors));
        }),
      );
    }
    for (const topic of cfg.lidarPointTopics) {
      jobs.push(
        worker.readLidarPoints(topic, seek, decimation).then((r) => {
          const positions = r.points.positions;
          transformPositions(positions);
          sweepGroup.add(buildSweepMesh(positions, r.points.colors, pointSize));
        }),
      );
    }
    const allEntities: SceneEntity[] = [];
    for (const topic of cfg.annotationTopics) {
      jobs.push(
        worker.readSceneEntities(topic, seek).then((r) => {
          allEntities.push(...r.entities);
        }),
      );
    }
    if (cfg.egoPoseTopic) {
      jobs.push(
        worker.readPose(cfg.egoPoseTopic, seek).then((r) => {
          updateEgoMarker(egoGroup, r.pose);
        }),
      );
    }

    await Promise.all(jobs);
    rebuildBoxes(boxesGroup, allEntities);

    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    return dataUrl;
  } finally {
    if (renderer) {
      renderer.dispose();
      const parent = renderer.domElement.parentElement;
      if (parent) {
        parent.removeChild(renderer.domElement);
      }
    }
    container.remove();
  }
}
