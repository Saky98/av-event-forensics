/**
 * Parser for `foxglove.SceneUpdate` (flatbuffer) — the topic used for
 * annotation bounding boxes in DeepAccident (`/annotations/objects`).
 *
 * Schema:
 *   SceneUpdate (table): 0: deletions [SceneEntityDeletion], 1: entities [SceneEntity]
 *   SceneEntity (table):
 *     0 timestamp (Time struct), 1 frame_id (string), 2 id (string),
 *     3 lifetime (Duration), 4 frame_locked (bool), 5 metadata,
 *     6 arrows, 7 cubes [CubePrimitive], 8 spheres, 9 cylinders,
 *     10 lines, 11 triangles, 12 texts, 13 models
 *   CubePrimitive (table): 0 pose (Pose), 1 size (Vector3), 2 color (Color)
 *
 * Like PointCloud, the DeepAccident files use the older foxglove layout where
 * Vector3/Quaternion/Color are tables; sizes and colors are read as tables.
 * Colors are float32 (RGBA 0..1).
 */

import { Fb } from './flatbuffer.ts';
import { parsePoseTable, readVector3Table, type Pose } from './pose.ts';

export interface Cube {
  pose: Pose;
  size: [number, number, number];
  /** RGBA 0..1, or null when absent. */
  color: [number, number, number, number] | null;
}

export interface SceneEntity {
  timestampNanos: bigint;
  frameId: string;
  id: string;
  cubes: Cube[];
}

export interface SceneUpdate {
  entities: SceneEntity[];
}

function parseCube(fb: Fb, table: number): Cube {
  const poseField = fb.field(table, 0);
  const pose = poseField === -1
    ? { position: [0, 0, 0], orientation: [0, 0, 0, 1] } as Pose
    : parsePoseTable(fb, fb.resolve(poseField));

  let size: [number, number, number] = [1, 1, 1];
  const sizeField = fb.field(table, 1);
  if (sizeField !== -1) {
    size = readVector3Table(fb, fb.resolve(sizeField));
  }

  let color: [number, number, number, number] | null = null;
  const colorField = fb.field(table, 2);
  if (colorField !== -1) {
    const colorTable = fb.resolve(colorField);
    // Color in this schema version is a table of float64 with defaults
    // (r=1, g=0, b=1, a=1) — flatbuffers omits fields equal to their default
    // (verified empirically: the converter writes 1.0 for r/b and they come
    // back absent).
    const r = fb.field(colorTable, 0);
    const g = fb.field(colorTable, 1);
    const b = fb.field(colorTable, 2);
    const a = fb.field(colorTable, 3);
    color = [
      r === -1 ? 1 : fb.f64(r),
      g === -1 ? 0 : fb.f64(g),
      b === -1 ? 1 : fb.f64(b),
      a === -1 ? 1 : fb.f64(a),
    ];
  }

  return { pose, size, color };
}

function parseEntity(fb: Fb, table: number): SceneEntity {
  const timestamp = fb.field(table, 0);
  const sec = timestamp === -1 ? 0 : fb.i32(timestamp);
  const nsec = timestamp === -1 ? 0 : fb.u32(timestamp + 4);

  const frameIdField = fb.field(table, 1);
  const frameId = frameIdField === -1 ? '' : fb.string(frameIdField);

  const idField = fb.field(table, 2);
  const id = idField === -1 ? '' : fb.string(idField);

  const cubes: Cube[] = [];
  const cubesField = fb.field(table, 7); // cubes
  if (cubesField !== -1) {
    const vec = fb.vector(cubesField);
    for (let i = 0; i < vec.len; i++) {
      cubes.push(parseCube(fb, fb.tableAt(vec, i)));
    }
  }

  return {
    timestampNanos: BigInt(sec) * 1_000_000_000n + BigInt(nsec),
    frameId,
    id,
    cubes,
  };
}

export function parseSceneUpdate(buffer: Uint8Array): SceneUpdate {
  const fb = new Fb(buffer);
  const table = fb.rootTable();
  const entities: SceneEntity[] = [];

  const entitiesField = fb.field(table, 1); // entities
  if (entitiesField !== -1) {
    const vec = fb.vector(entitiesField);
    for (let i = 0; i < vec.len; i++) {
      entities.push(parseEntity(fb, fb.tableAt(vec, i)));
    }
  }

  return { entities };
}
