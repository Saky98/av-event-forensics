/**
 * Parser for `foxglove.Pose` (flatbuffer).
 *
 * Schema (table Pose):
 *   0: position    Vector3 (table: x, y, z: float64)
 *   1: orientation Quaternion (table: x, y, z, w: float64)
 *
 * NOTE: the DeepAccident MCAPs were written with a foxglove-schemas version
 * where Vector3/Quaternion are TABLES (uoffset references), not inline
 * structs. The official current schema uses structs; the parsers here follow
 * the on-disk layout of our files (tables), and tolerate empty tables
 * (flatbuffers omits fields equal to their defaults, so an identity pose is
 * often an empty table).
 */

import { Fb } from './flatbuffer.ts';

export interface Pose {
  position: [number, number, number];
  orientation: [number, number, number, number];
}

const IDENTITY: Pose = {
  position: [0, 0, 0],
  orientation: [0, 0, 0, 1],
};

/** Reads a Vector3/Point3 table (fields x=0, y=1, z=2). */
export function readVector3Table(fb: Fb, table: number): [number, number, number] {
  const x = fb.field(table, 0);
  const y = fb.field(table, 1);
  const z = fb.field(table, 2);
  return [
    x === -1 ? 0 : fb.f64(x),
    y === -1 ? 0 : fb.f64(y),
    z === -1 ? 0 : fb.f64(z),
  ];
}

/** Reads a Quaternion table (fields x=0, y=1, z=2, w=3). */
export function readQuaternionTable(fb: Fb, table: number): [number, number, number, number] {
  const x = fb.field(table, 0);
  const y = fb.field(table, 1);
  const z = fb.field(table, 2);
  const w = fb.field(table, 3);
  const qx = x === -1 ? 0 : fb.f64(x);
  const qy = y === -1 ? 0 : fb.f64(y);
  const qz = z === -1 ? 0 : fb.f64(z);
  let qw = w === -1 ? 1 : fb.f64(w);
  // All-default (or all-zero) quaternion -> identity.
  if (qx === 0 && qy === 0 && qz === 0 && (qw === 0 || qw === 1)) {
    qw = 1;
  }
  return [qx, qy, qz, qw];
}

/** Parses a Pose table from an Fb at a table offset (not a standalone buffer). */
export function parsePoseTable(fb: Fb, table: number): Pose {
  const posField = fb.field(table, 0);
  const oriField = fb.field(table, 1);
  const position: [number, number, number] =
    posField === -1 ? [0, 0, 0] : readVector3Table(fb, fb.resolve(posField));
  const orientation: [number, number, number, number] =
    oriField === -1 ? [0, 0, 0, 1] : readQuaternionTable(fb, fb.resolve(oriField));
  return { position, orientation };
}

/** Parses a standalone `foxglove.Pose` buffer (e.g. /ego/pose messages). */
export function parsePose(buffer: Uint8Array): Pose {
  const fb = new Fb(buffer);
  const table = fb.rootTable();
  if (table < 0 || table + 4 > buffer.length) {
    return IDENTITY;
  }
  return parsePoseTable(fb, table);
}
