/**
 * Shared LiDAR scene builders used by both the live LidarView and the
 * offscreen snapshot generator (forensic report). Kept outside a component
 * file so fast-refresh / lint rules accept component exports cleanly.
 */

import * as THREE from 'three';
import type { SceneEntity } from '../hooks/useMcapWorker';
import { rosQuatToThree, rosToThree, yawFromQuaternion } from './coordinates';

export function buildSweepMesh(
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

export function buildMapMesh(positions: Float32Array, colors: Float32Array | null): THREE.Points {
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

export function buildBox(center: number[], size: number[], quat: number[], color: THREE.ColorRepresentation, alpha: number): THREE.Group {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const fill = new THREE.Mesh(
    box,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: Math.min(1, alpha) * 0.28,
      depthWrite: false,
    }),
  );
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
  group.scale.set(size[0], size[2], size[1]);
  return group;
}

export function buildEgoMarker(): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.EdgesGeometry(new THREE.BoxGeometry(4.6, 1.7, 1.9));
  const bodyMesh = new THREE.LineSegments(body, new THREE.LineBasicMaterial({ color: 0x00e5ff }));
  group.add(bodyMesh);
  const arrowPoints = [new THREE.Vector3(2.4, 0, 0), new THREE.Vector3(3.6, 0, 0)];
  const arrow = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(arrowPoints),
    new THREE.LineBasicMaterial({ color: 0x00e5ff }),
  );
  group.add(arrow);
  return group;
}

export function disposeObject(obj: THREE.Object3D): void {
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

export function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    disposeObject(child);
    group.remove(child);
  }
}

export function rebuildBoxes(boxesGroup: THREE.Group, entities: SceneEntity[]): void {
  clearGroup(boxesGroup);
  const palette = [0x4da6ff, 0xffd34d, 0xff704d, 0x4dffb8, 0xc94dff];
  entities.forEach((entity, entityIndex) => {
    const baseColor = palette[entityIndex % palette.length];
    entity.cubes.forEach((cube) => {
      const color = cube.color ? new THREE.Color(cube.color[0], cube.color[1], cube.color[2]).getHex() : baseColor;
      const alpha = cube.color ? cube.color[3] : 1;
      boxesGroup.add(buildBox(cube.pose.position, cube.size, cube.pose.orientation, color, alpha));
    });
  });
}

export function updateEgoMarker(egoGroup: THREE.Group, pose: { position: number[]; orientation: number[] } | null): void {
  clearGroup(egoGroup);
  if (!pose) {
    return;
  }
  const marker = buildEgoMarker();
  marker.rotation.y = -yawFromQuaternion(pose.orientation as [number, number, number, number]);
  egoGroup.add(marker);
}
