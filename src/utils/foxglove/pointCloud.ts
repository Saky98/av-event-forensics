/**
 * Parser for `foxglove.PointCloud` (flatbuffer) + point extraction.
 *
 * Schema (table PointCloud):
 *   0: timestamp     Time struct (sec i32, nsec u32) — inline
 *   1: frame_id      string
 *   2: pose          Pose (table)
 *   3: point_stride  uint32
 *   4: fields        [PackedElementField] (vector of tables)
 *   5: data          [uint8] (vector)
 *
 * PackedElementField (table): 0: name (string), 1: offset (uint32), 2: type (NumericType ubyte).
 *
 * NumericType: UINT8=1 INT8=2 UINT16=3 INT16=4 UINT32=5 INT32=6 FLOAT32=7 FLOAT64=8
 *
 * The message stores points as a packed byte blob (`data`), `point_stride`
 * bytes per point, interpreted via `fields` (name -> byte offset -> type).
 */

import { Fb } from './flatbuffer.ts';
import { parsePoseTable, type Pose } from './pose.ts';

export const NumericType = {
  UNKNOWN: 0,
  UINT8: 1,
  INT8: 2,
  UINT16: 3,
  INT16: 4,
  UINT32: 5,
  INT32: 6,
  FLOAT32: 7,
  FLOAT64: 8,
} as const;
export type NumericType = (typeof NumericType)[keyof typeof NumericType];

export interface PointCloudField {
  name: string;
  offset: number;
  type: NumericType;
}

export interface PointCloud {
  timestampNanos: bigint;
  frameId: string;
  /** Pose of the point cloud in the frame (identity when absent). */
  pose: Pose;
  pointStride: number;
  fields: PointCloudField[];
  /** Raw packed point bytes. */
  data: Uint8Array;
  /** Number of complete points in `data`. */
  pointCount: number;
}

function parseFields(fb: Fb, vec: { off: number; len: number }): PointCloudField[] {
  const fields: PointCloudField[] = [];
  for (let i = 0; i < vec.len; i++) {
    const fieldTable = fb.tableAt(vec, i);
    // Absent fields equal their defaults (flatbuffers omits them): name '', offset 0, type UNKNOWN.
    const nameField = fb.field(fieldTable, 0);
    const name = nameField === -1 ? '' : fb.string(nameField);
    const offsetField = fb.field(fieldTable, 1);
    const offset = offsetField === -1 ? 0 : fb.u32(offsetField);
    const typeField = fb.field(fieldTable, 2);
    const type = typeField === -1 ? NumericType.UNKNOWN : (fb.u8(typeField) as NumericType);
    fields.push({ name, offset, type });
  }
  return fields;
}

export function parsePointCloud(buffer: Uint8Array): PointCloud {
  const fb = new Fb(buffer);
  const table = fb.rootTable();

  const timestamp = fb.field(table, 0);
  const sec = timestamp === -1 ? 0 : fb.i32(timestamp);
  const nsec = timestamp === -1 ? 0 : fb.u32(timestamp + 4);

  const frameIdField = fb.field(table, 1);
  const frameId = frameIdField === -1 ? '' : fb.string(frameIdField);

  const poseField = fb.field(table, 2);
  const pose = poseField === -1 ? { position: [0, 0, 0], orientation: [0, 0, 0, 1] } as Pose : parsePoseTable(fb, fb.resolve(poseField));

  const strideField = fb.field(table, 3);
  const pointStride = strideField === -1 ? 0 : fb.u32(strideField);

  const fieldsField = fb.field(table, 4);
  const fields = fieldsField === -1 ? [] : parseFields(fb, fb.vector(fieldsField));

  let data = new Uint8Array(0);
  const dataField = fb.field(table, 5);
  if (dataField !== -1) {
    const vec = fb.vector(dataField);
    const start = vec.off + 4;
    data = buffer.slice(start, start + vec.len) as Uint8Array<ArrayBuffer>;
  }

  const pointCount = pointStride > 0 ? Math.floor(data.length / pointStride) : 0;

  return {
    timestampNanos: BigInt(sec) * 1_000_000_000n + BigInt(nsec),
    frameId,
    pose,
    pointStride,
    fields,
    data,
    pointCount,
  };
}

// ---- point extraction for rendering ----

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

function findField(fields: PointCloudField[], name: string): PointCloudField | undefined {
  const lower = name.toLowerCase();
  return fields.find((f) => f.name.toLowerCase() === lower);
}

function readFieldValue(
  fb: Fb,
  field: PointCloudField,
  base: number,
): number {
  const o = base + field.offset;
  switch (field.type) {
    case NumericType.FLOAT64:
      return fb.f64(o);
    case NumericType.FLOAT32:
      return fb.f32(o);
    case NumericType.UINT8:
      return fb.u8(o);
    case NumericType.INT8:
      return fb.view.getInt8(o);
    case NumericType.UINT16:
      return fb.view.getUint16(o, true);
    case NumericType.INT16:
      return fb.view.getInt16(o, true);
    case NumericType.UINT32:
      return fb.u32(o);
    case NumericType.INT32:
      return fb.i32(o);
    default:
      return 0;
  }
}

/**
 * Extracts x/y/z (and optional intensity-derived colors) from a parsed point
 * cloud, keeping every `decimation`-th point. Returns typed arrays sized to
 * the decimated count — no copying of the source blob is performed.
 */
export function extractPoints(pc: PointCloud, decimation = 1): ExtractedPoints {
  const fx = findField(pc.fields, 'x');
  const fy = findField(pc.fields, 'y');
  const fz = findField(pc.fields, 'z');
  if (!fx || !fy || !fz || pc.pointCount === 0) {
    return { positions: new Float32Array(0), colors: null, count: 0, total: pc.pointCount };
  }
  const intensity = findField(pc.fields, 'intensity');

  const step = Math.max(1, Math.floor(decimation));
  const count = Math.ceil(pc.pointCount / step);
  const positions = new Float32Array(count * 3);

  // First pass: collect intensity values (if present) for min/max normalization.
  const fb = new Fb(pc.data);
  const rawIntensity = intensity ? new Float32Array(count) : null;
  let iMin = Infinity;
  let iMax = -Infinity;

  for (let i = 0, out = 0; i < pc.pointCount; i += step, out++) {
    const base = i * pc.pointStride;
    const x = readFieldValue(fb, fx, base);
    const y = readFieldValue(fb, fy, base);
    const z = readFieldValue(fb, fz, base);
    positions[out * 3] = x;
    positions[out * 3 + 1] = y;
    positions[out * 3 + 2] = z;
    if (rawIntensity) {
      const v = readFieldValue(fb, intensity!, base);
      rawIntensity[out] = v;
      if (v < iMin) iMin = v;
      if (v > iMax) iMax = v;
    }
  }

  if (!rawIntensity) {
    return { positions, colors: null, count, total: pc.pointCount };
  }

  // Intensity -> grayscale color, normalized to [0, 1].
  const range = iMax - iMin;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = range > 1e-9 ? (rawIntensity[i] - iMin) / range : 0.5;
    colors[i * 3] = t;
    colors[i * 3 + 1] = t;
    colors[i * 3 + 2] = t;
  }

  return { positions, colors, count, total: pc.pointCount };
}
