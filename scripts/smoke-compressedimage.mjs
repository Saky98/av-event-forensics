// Smoke test: foxglove.CompressedImage flatbuffer parser (src/utils/foxglove/compressedImage.ts)
// validated against the REAL file and cross-checked with the python
// foxglove_schemas_flatbuffer parser (byte-for-byte JPEG equality via sha256).
//
// The TS parser cannot be imported directly in Node, so the parser logic is
// replicated here verbatim — the src version is what the worker uses.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const zstd = require('@foxglove/wasm-zstd');
await zstd.isLoaded;

// ---- replicated src/utils/foxglove/compressedImage.ts ----
const U32 = (view, off) => view.getUint32(off, true);
const I32 = (view, off) => view.getInt32(off, true);
const U16 = (view, off) => view.getUint16(off, true);
function parseCompressedImage(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const table = U32(view, 0);
  const vtable = table - I32(view, table);
  const fieldOffset = (index) => {
    const off = U16(view, vtable + 4 + index * 2);
    return off === 0 ? undefined : table + off;
  };
  const tsOff = fieldOffset(0);
  const sec = tsOff === undefined ? 0 : U32(view, tsOff);
  const nsec = tsOff === undefined ? 0 : U32(view, tsOff + 4);
  const readString = (fieldIndex) => {
    const field = fieldOffset(fieldIndex);
    if (field === undefined) return '';
    const str = field + U32(view, field);
    const len = U32(view, str);
    return new TextDecoder().decode(buffer.subarray(str + 4, str + 4 + len));
  };
  let data = new Uint8Array(0);
  const dataField = fieldOffset(2); // data is field 2 in foxglove.CompressedImage
  if (dataField !== undefined) {
    const vec = dataField + U32(view, dataField);
    const len = U32(view, vec);
    data = buffer.subarray(vec + 4, vec + 4 + len);
  }
  return {
    sec,
    nsec,
    timestampNanos: BigInt(sec) * 1000000000n + BigInt(nsec),
    frameId: readString(1),
    format: readString(3), // format is field 3
    data,
  };
}
function lastIndexLE(messages, target) {
  let lo = 0, hi = messages.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].logTime <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

// ---- load real file, read camera topic ----
const file = fs.readFileSync('storage/Town02_truck_collision.mcap');
const reader = await McapIndexedReader.Initialize({
  readable: new BlobReadable(new Blob([file])),
  decompressHandlers: { zstd: (b, n) => new Uint8Array(zstd.decompress(b, Number(n))) },
});
const TOPIC = '/camera_front/image/compressed';
const messages = [];
for await (const m of reader.readMessages({ topics: [TOPIC] })) messages.push(m);
messages.sort((a, b) => (a.logTime < b.logTime ? -1 : a.logTime > b.logTime ? 1 : a.sequence - b.sequence));
console.log(`topic ${TOPIC}: ${messages.length} messages`);

const assert = (cond, label) => { if (!cond) { console.error('FAIL:', label); process.exit(1); } console.log('PASS:', label); };

// ---- parse first 5 frames with the JS parser ----
const parsed = [];
for (let i = 0; i < Math.min(5, messages.length); i++) {
  const p = parseCompressedImage(messages[i].data);
  parsed.push(p);
  assert(p.format === 'jpeg', `frame ${i + 1}: format == jpeg (got "${p.format}")`);
  assert(p.frameId === 'Camera_Front', `frame ${i + 1}: frame_id == Camera_Front`);
  assert(p.data[0] === 0xff && p.data[1] === 0xd8, `frame ${i + 1}: JPEG magic FF D8`);
  assert(p.data[p.data.length - 2] === 0xff && p.data[p.data.length - 1] === 0xd9, `frame ${i + 1}: JPEG end FF D9`);
  assert(p.timestampNanos === messages[i].logTime, `frame ${i + 1}: timestampNanos == logTime`);
  assert(p.data.length > 1000, `frame ${i + 1}: data length ${p.data.length}`);
}

// ---- nearest-frame logic ----
const f2 = messages[2]; // frame 3
const f3 = messages[3]; // frame 4
assert(lastIndexLE(messages, f2.logTime) === 2, 'nearest <= frame3.logTime -> frame3');
assert(lastIndexLE(messages, f2.logTime + 50_000_000n) === 2, 'mid-way between frames -> previous frame');
assert(lastIndexLE(messages, f3.logTime) === 3, 'nearest <= frame4.logTime -> frame4');
assert(lastIndexLE(messages, messages[0].logTime - 1n) === -1, 'before first frame -> -1');

// ---- cross-check against python parser (sha256 of JPEG bytes) ----
const fbBytes = messages[0].data;
const jsSha = crypto.createHash('sha256').update(parsed[0].data).digest('hex');
fs.writeFileSync('/tmp/fb_frame1.bin', fbBytes);
const pyOut = execFileSync('python3', ['-c', `
import sys, hashlib, json
from foxglove_schemas_flatbuffer import CompressedImage
raw = open('/tmp/fb_frame1.bin','rb').read()
ci = CompressedImage.CompressedImage.GetRootAsCompressedImage(raw, 0)
data = bytes(ci.DataAsNumpy() if hasattr(ci,'DataAsNumpy') else ci.DataLength() and ci.Data())
# safer: read the byte vector via Length + data accessor
print(json.dumps({
  'format': ci.Format().decode(),
  'frame_id': ci.FrameId().decode(),
  'data_len': ci.DataLength(),
  'sha256': hashlib.sha256(data).hexdigest(),
}))
`], { encoding: 'utf8' });
const py = JSON.parse(pyOut.trim().split('\n').pop());
assert(py.format === 'jpeg', 'python: format == jpeg');
assert(py.frame_id === 'Camera_Front', 'python: frame_id == Camera_Front');
assert(py.data_len === parsed[0].data.length, `python data_len ${py.data_len} == JS ${parsed[0].data.length}`);
assert(py.sha256 === jsSha, `sha256 match (python ${py.sha256.slice(0, 12)}… == JS ${jsSha.slice(0, 12)}…)`);
console.log(`python cross-check: format=${py.format}, frame_id=${py.frame_id}, data_len=${py.data_len}, sha256=${py.sha256.slice(0, 16)}…`);

console.log('\nCOMPRESSED IMAGE PARSER SMOKE TEST OK');
