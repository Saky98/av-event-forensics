/**
 * Minimal flatbuffer reader for `foxglove.CompressedImage` (foxglove/schemas).
 *
 * Schema (field order matters — we read by schema index):
 *   table CompressedImage {
 *     timestamp: Time (required);   // struct: sec u32, nsec u32  (field 0)
 *     frame_id: string;                                              (field 1)
 *     data: [ubyte] (required);     // compressed image bytes        (field 2)
 *     format: string;               // "jpeg" | "png" | ...         (field 3)
 *   }
 *
 * We deliberately avoid a flatbuffers dependency and read the few fields we
 * need directly. Validated against the python `foxglove_schemas_flatbuffer`
 * parser (see scripts/smoke-compressedimage.mjs).
 */

export interface CompressedImage {
  /** ROS-style timestamp */
  sec: number;
  nsec: number;
  /** sec * 1e9 + nsec, as used by MCAP */
  timestampNanos: bigint;
  frameId: string;
  format: string;
  /** Compressed image bytes (view into the input buffer) */
  data: Uint8Array;
}

const U32 = (view: DataView, off: number): number => view.getUint32(off, true);
const I32 = (view: DataView, off: number): number => view.getInt32(off, true);
const U16 = (view: DataView, off: number): number => view.getUint16(off, true);

export function parseCompressedImage(buffer: Uint8Array): CompressedImage {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const root = U32(view, 0); // uoffset from byte 0 to the root table
  const table = root;
  const vtable = table - I32(view, table);

  const fieldOffset = (index: number): number | undefined => {
    const off = U16(view, vtable + 4 + index * 2);
    return off === 0 ? undefined : table + off;
  };

  // 0: timestamp (Time struct, 8 bytes inline)
  const tsOff = fieldOffset(0);
  const sec = tsOff === undefined ? 0 : U32(view, tsOff);
  const nsec = tsOff === undefined ? 0 : U32(view, tsOff + 4);

  const readString = (fieldIndex: number): string => {
    const field = fieldOffset(fieldIndex);
    if (field === undefined) {
      return '';
    }
    const str = field + U32(view, field); // uoffset to string
    const len = U32(view, str);
    const start = str + 4;
    return new TextDecoder().decode(buffer.subarray(start, start + len));
  };

  // 2: data ([ubyte] vector)
  let data: Uint8Array = new Uint8Array(0);
  const dataField = fieldOffset(2);
  if (dataField !== undefined) {
    const vec = dataField + U32(view, dataField); // uoffset to vector
    const len = U32(view, vec);
    data = buffer.subarray(vec + 4, vec + 4 + len);
  }

  return {
    sec,
    nsec,
    timestampNanos: BigInt(sec) * 1_000_000_000n + BigInt(nsec),
    frameId: readString(1),
    format: readString(3),
    data,
  };
}

/** MIME type for a foxglove image format string. */
export function mimeForFormat(format: string): string {
  const f = format.toLowerCase();
  if (f === 'jpeg' || f === 'jpg') {
    return 'image/jpeg';
  }
  if (f === 'png') {
    return 'image/png';
  }
  if (f === 'webp') {
    return 'image/webp';
  }
  return `image/${f}`;
}
