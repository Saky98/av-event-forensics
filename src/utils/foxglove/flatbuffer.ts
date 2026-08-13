/**
 * Minimal flatbuffers reader (read-only) used by the foxglove schema parsers.
 *
 * Flatbuffers layout (little-endian):
 *  - byte 0 holds a uoffset to the root table
 *  - a table starts with an i32 vtable offset (relative to the table start)
 *  - the vtable holds u16 sizes then one u16 field offset per field id
 *  - a field offset of 0 means the field is absent; otherwise the field's
 *    value lives at `table + offset`
 *  - struct fields are inlined; string/vector/table fields hold a uoffset
 *    that is relative to the storage position of that uoffset
 *
 * All offsets here are absolute byte positions into the source buffer, so a
 * parser never has to juggle relative addressing.
 */

export class Fb {
  readonly view: DataView;
  readonly buf: Uint8Array;

  constructor(buffer: Uint8Array) {
    this.buf = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  /** Absolute offset of the root table. */
  rootTable(): number {
    return this.u32(0);
  }

  /** Absolute offset of the vtable for `table`, or -1 if none. */
  vtable(table: number): number {
    return table - this.i32(table);
  }

  /**
   * Absolute offset of the *value storage* for field `id` of `table`, or -1
   * when the field is absent. For structs the value is inline at this offset;
   * for strings/vectors/tables the value is a uoffset from here.
   */
  field(table: number, id: number): number {
    const vt = this.vtable(table);
    if (vt < 0) {
      return -1;
    }
    // vtableSize covers the two size u16s plus one u16 per field id; ids
    // beyond it are absent (tables can be empty when every field equals its
    // default, which flatbuffers omits).
    const vtableSize = this.u16(vt);
    if (4 + id * 2 + 2 > vtableSize) {
      return -1;
    }
    const off = this.u16(vt + 4 + id * 2);
    return off === 0 ? -1 : table + off;
  }

  u32(off: number): number {
    return this.view.getUint32(off, true);
  }

  i32(off: number): number {
    return this.view.getInt32(off, true);
  }

  u16(off: number): number {
    return this.view.getUint16(off, true);
  }

  u8(off: number): number {
    return this.view.getUint8(off);
  }

  f32(off: number): number {
    return this.view.getFloat32(off, true);
  }

  f64(off: number): number {
    return this.view.getFloat64(off, true);
  }

  /** Resolves a uoffset field into the absolute offset of the pointed-to record. */
  resolve(off: number): number {
    return off + this.u32(off);
  }

  /** Reads a string field (storage position `off`). */
  string(off: number): string {
    const record = this.resolve(off);
    const len = this.u32(record);
    const start = record + 4;
    return new TextDecoder().decode(this.buf.subarray(start, start + len));
  }

  /** Reads a vector field (storage position `off`): { off, len } of the vector record. */
  vector(off: number): { off: number; len: number } {
    const record = this.resolve(off);
    return { off: record, len: this.u32(record) };
  }

  /** Table element at `index` inside a vector of tables (`vec.off` from `vector()`). */
  tableAt(vec: { off: number; len: number }, index: number): number {
    return vec.off + 4 + index * 4 + this.u32(vec.off + 4 + index * 4);
  }
}
