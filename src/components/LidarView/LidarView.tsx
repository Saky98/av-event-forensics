import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RootState } from '../../store';
import { useMcapWorker, type SceneEntity } from '../../hooks/useMcapWorker';
import { rosQuatToThree, rosToThree, transformPositions, yawFromQuaternion } from '../../utils/coordinates';
import './LidarView.css';

/**
 * 3D LiDAR view (Phase 4).
 *
 * Renders per-frame point cloud sweeps (e.g. /lidar/points), an optional
 * static background map (e.g. /lidar/background_map), annotation bounding
 * boxes (/annotations/objects, foxglove.SceneUpdate) and the ego vehicle
 * marker (/ego/pose) — all synced to the global timeline timestamp.
 *
 * Coordinate convention: source data is ROS (x forward, y left, z up). Three.js
 * is y-up, so we map (x, y, z) -> (x, z, -y) and quaternions similarly.
 */

interface SceneData {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sweepGroup: THREE.Group;
  mapGroup: THREE.Group;
  boxesGroup: THREE.Group;
  egoGroup: THREE.Group;
  rafId: number;
  resizeObserver: ResizeObserver;
}

const DEFAULT_DECIMATION = 2;
const MAP_DECIMATION = 8;
const DEFAULT_POINT_SIZE = 1.6;

function buildSweepMesh(
  positions: Float32Array,
  colors: Float32Array | null,
  pointSize: number,
): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) {
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const material = new THREE.PointsMaterial({
    size: pointSize,
    sizeAttenuation: true,
    vertexColors: Boolean(colors),
    color: colors ? 0xffffff : 0x9fb4c8,
  });
  return new THREE.Points(geometry, material);
}

function buildMapMesh(positions: Float32Array, colors: Float32Array | null): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) {
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const material = new THREE.PointsMaterial({
    size: 1.1,
    sizeAttenuation: true,
    vertexColors: Boolean(colors),
    color: colors ? 0xffffff : 0x5a6a7a,
    transparent: true,
    opacity: 0.9,
  });
  return new THREE.Points(geometry, material);
}

function buildBox(center: number[], size: number[], quat: number[], color: THREE.ColorRepresentation, alpha: number): THREE.Group {
  const box = new THREE.BoxGeometry(1, 1, 1);
  // Solid translucent fill (visible even from far away).
  const fill = new THREE.Mesh(
    box,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: Math.min(1, alpha) * 0.28,
      depthWrite: false,
    }),
  );
  // Crisp outline.
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(box),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, alpha) * 0.95 }),
  );
  const group = new THREE.Group();
  group.add(fill, outline);
  const [px, py, pz] = rosToThree(center[0], center[1], center[2]);
  group.position.set(px, py, pz);
  const q = rosQuatToThree(quat as [number, number, number, number]);
  group.quaternion.set(q[0], q[1], q[2], q[3]);
  // Size maps the same as position axes.
  group.scale.set(size[0], size[2], size[1]);
  return group;
}

function buildEgoMarker(): THREE.Group {
  const group = new THREE.Group();
  // Vehicle body outline (approximate sedan).
  const body = new THREE.EdgesGeometry(new THREE.BoxGeometry(4.6, 1.7, 1.9));
  const bodyMesh = new THREE.LineSegments(body, new THREE.LineBasicMaterial({ color: 0x00e5ff }));
  group.add(bodyMesh);
  // Heading arrow along +x (ROS forward).
  const arrowPoints = [new THREE.Vector3(2.4, 0, 0), new THREE.Vector3(3.6, 0, 0)];
  const arrow = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(arrowPoints),
    new THREE.LineBasicMaterial({ color: 0x00e5ff }),
  );
  group.add(arrow);
  return group;
}

/** Disposes geometry/material of an object and its children (keeps it in the scene). */
function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Points;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const material = (mesh as THREE.Points).material as THREE.Material | THREE.Material[] | undefined;
    if (material) {
      if (Array.isArray(material)) {
        material.forEach((m) => m.dispose());
      } else {
        material.dispose();
      }
    }
  });
}

/** Disposes and removes every child of a group (the group itself stays in the scene). */
function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    disposeObject(child);
    group.remove(child);
  }
}

function initScene(container: HTMLDivElement): SceneData {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 2000);
  camera.position.set(45, 42, 65);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.minDistance = 1;
  controls.maxDistance = 800;

  // Ground grid + axes for orientation.
  const grid = new THREE.GridHelper(200, 40, 0x2a3b4d, 0x1a2733);
  scene.add(grid);
  const axes = new THREE.AxesHelper(6);
  scene.add(axes);

  const sweepGroup = new THREE.Group();
  const mapGroup = new THREE.Group();
  const boxesGroup = new THREE.Group();
  const egoGroup = new THREE.Group();
  scene.add(sweepGroup, mapGroup, boxesGroup, egoGroup);

  const resizeObserver = new ResizeObserver(() => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
  resizeObserver.observe(container);

  function render(): void {
    controls.update();
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(render);
  }
  let rafId = requestAnimationFrame(render);

  return { renderer, scene, camera, controls, sweepGroup, mapGroup, boxesGroup, egoGroup, rafId, resizeObserver };
}

const LidarView: React.FC = () => {
  const { currentTimestamp, timeRange, playerReady, lidarPointTopics, lidarMapTopics, annotationTopics, egoPoseTopic } =
    useSelector((state: RootState) => state.app);
  const { readLidarPoints, readSceneEntities, readPose } = useMcapWorker();

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneData | null>(null);
  const latestSeq = useRef(0);
  const loadedMaps = useRef<Set<string>>(new Set());
  /** Map point count (total, before decimation) — kept in a ref for stats. */
  const mapPointCount = useRef(0);

  const [decimation, setDecimation] = useState(DEFAULT_DECIMATION);
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [showMap, setShowMap] = useState(true);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [showEgo, setShowEgo] = useState(true);
  const [stats, setStats] = useState<{ sweep: number; boxes: number; map: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- scene lifecycle ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const sceneData = initScene(container);
    sceneRef.current = sceneData;
    return () => {
      cancelAnimationFrame(sceneData.rafId);
      sceneData.resizeObserver.disconnect();
      clearGroup(sceneData.sweepGroup);
      clearGroup(sceneData.mapGroup);
      clearGroup(sceneData.boxesGroup);
      clearGroup(sceneData.egoGroup);
      sceneData.controls.dispose();
      sceneData.renderer.dispose();
      if (sceneData.renderer.domElement.parentElement === container) {
        container.removeChild(sceneData.renderer.domElement);
      }
      sceneRef.current = null;
    };
  }, []);

  // ---- point size effect ----
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    scene.sweepGroup.traverse((child) => {
      const points = child as THREE.Points;
      const material = points.material as THREE.PointsMaterial | undefined;
      if (material) {
        material.size = pointSize;
      }
    });
  }, [pointSize]);

  // ---- visibility toggles ----
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) {
      scene.mapGroup.visible = showMap;
    }
  }, [showMap]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) {
      scene.boxesGroup.visible = showAnnotations;
    }
  }, [showAnnotations]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) {
      scene.egoGroup.visible = showEgo;
    }
  }, [showEgo]);

  // ---- background map: load once per topic ----
  const loadMap = useCallback(
    async (topic: string) => {
      const scene = sceneRef.current;
      if (!scene || loadedMaps.current.has(topic)) {
        return;
      }
      loadedMaps.current.add(topic);
      try {
        // The map is a single static message; read at the recording start.
        const result = await readLidarPoints(topic, timeRange?.start ?? 0n, MAP_DECIMATION);
        if (!result.actualLogTime || result.points.count === 0) {
          loadedMaps.current.delete(topic);
          return;
        }
        const positions = result.points.positions;
        transformPositions(positions);
        const mesh = buildMapMesh(positions, result.points.colors);
        mesh.userData.pointCount = result.points.total;
        scene.mapGroup.add(mesh);
        mapPointCount.current = result.points.total;
      } catch (e) {
        loadedMaps.current.delete(topic);
        console.warn('background map load failed:', topic, e);
      }
    },
    [readLidarPoints, timeRange],
  );

  useEffect(() => {
    if (!playerReady) {
      return;
    }
    for (const topic of lidarMapTopics) {
      void loadMap(topic);
    }
  }, [playerReady, lidarMapTopics, loadMap]);

  // ---- timeline sync: sweeps + boxes + ego ----
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !playerReady || !timeRange) {
      return;
    }
    const seq = ++latestSeq.current;
    const seekTime = currentTimestamp < timeRange.start ? timeRange.start : currentTimestamp;

    const requests: Promise<unknown>[] = [];

    for (const topic of lidarPointTopics) {
      requests.push(
        readLidarPoints(topic, seekTime, decimation).then((result) => {
          if (latestSeq.current !== seq) {
            return;
          }
          // Replace previous sweep mesh for this topic.
          const previous = scene.sweepGroup.getObjectByName(`sweep:${topic}`);
          if (previous) {
            disposeObject(previous);
            scene.sweepGroup.remove(previous);
          }
          const positions = result.points.positions;
          transformPositions(positions);
          const mesh = buildSweepMesh(positions, result.points.colors, pointSize);
          mesh.name = `sweep:${topic}`;
          mesh.userData.pointCount = result.points.count;
          scene.sweepGroup.add(mesh);
        }),
      );
    }

    for (const topic of annotationTopics) {
      requests.push(
        readSceneEntities(topic, seekTime).then((result) => {
          if (latestSeq.current !== seq) {
            return;
          }
          rebuildBoxes(scene, result.entities);
        }),
      );
    }

    if (egoPoseTopic) {
      requests.push(
        readPose(egoPoseTopic, seekTime).then((result) => {
          if (latestSeq.current !== seq) {
            return;
          }
          updateEgoMarker(scene, result.pose);
        }),
      );
    }

    void Promise.all(requests)
      .then(() => {
        if (latestSeq.current !== seq) {
          return;
        }
        const sweepCount = scene.sweepGroup.children.reduce(
          (sum, child) => sum + ((child.userData.pointCount as number) ?? 0),
          0,
        );
        setStats({
          sweep: sweepCount,
          boxes: scene.boxesGroup.children.length,
          map: mapPointCount.current,
        });
      })
      .catch((e) => {
        if (latestSeq.current === seq) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
  }, [currentTimestamp, decimation, playerReady, timeRange, lidarPointTopics, annotationTopics, egoPoseTopic, readLidarPoints, readSceneEntities, readPose, pointSize]);

  return (
    <div className="lidar-view">
      <div className="lidar-toolbar">
        <span className="lidar-title">3D LiDAR</span>
        <label className="lidar-control">
          Decimate
          <select
            value={decimation}
            onChange={(e) => setDecimation(Number(e.target.value))}
            title="Keep every Nth point"
          >
            {[1, 2, 3, 4, 8, 16].map((d) => (
              <option key={d} value={d}>
                {d === 1 ? 'off' : `1/${d}`}
              </option>
            ))}
          </select>
        </label>
        <label className="lidar-control">
          Point size
          <input
            type="range"
            min="0.5"
            max="4"
            step="0.1"
            value={pointSize}
            onChange={(e) => setPointSize(parseFloat(e.target.value))}
          />
        </label>
        <label className="lidar-control checkbox">
          <input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} />
          Map
        </label>
        <label className="lidar-control checkbox">
          <input
            type="checkbox"
            checked={showAnnotations}
            onChange={(e) => setShowAnnotations(e.target.checked)}
          />
          Boxes
        </label>
        <label className="lidar-control checkbox">
          <input type="checkbox" checked={showEgo} onChange={(e) => setShowEgo(e.target.checked)} />
          Ego
        </label>
        {stats && (
          <span className="lidar-stats">
            {stats.sweep.toLocaleString()} pts · {stats.boxes} boxes
            {stats.map > 0 ? ` · map ${(stats.map / 1000).toFixed(0)}k` : ''}
          </span>
        )}
      </div>
      {error && <div className="lidar-error">⚠ {error}</div>}
      <div className="lidar-canvas" ref={containerRef} />
    </div>
  );
};

/** Replaces the annotation box group from a parsed SceneUpdate. */
function rebuildBoxes(scene: SceneData, entities: SceneEntity[]): void {
  clearGroup(scene.boxesGroup);
  const palette = [0x4da6ff, 0xffd34d, 0xff704d, 0x4dffb8, 0xc94dff];
  entities.forEach((entity, entityIndex) => {
    const baseColor = palette[entityIndex % palette.length];
    entity.cubes.forEach((cube) => {
      const color = cube.color ? new THREE.Color(cube.color[0], cube.color[1], cube.color[2]).getHex() : baseColor;
      const alpha = cube.color ? cube.color[3] : 1;
      scene.boxesGroup.add(buildBox(cube.pose.position, cube.size, cube.pose.orientation, color, alpha));
    });
  });
}

/** Updates the ego vehicle marker from a parsed pose (or hides it). */
function updateEgoMarker(scene: SceneData, pose: { position: number[]; orientation: number[] } | null): void {
  clearGroup(scene.egoGroup);
  if (!pose) {
    return;
  }
  const marker = buildEgoMarker();
  marker.rotation.y = -yawFromQuaternion(pose.orientation as [number, number, number, number]);
  scene.egoGroup.add(marker);
}

export default LidarView;
