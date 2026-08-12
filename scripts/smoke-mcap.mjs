// Smoke test: MCAP write -> read round trip using the exact packages + logic
// the app uses (McapIndexedReader + BlobReadable + zstd/lz4/bz2 decompression).
import { McapWriter, McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const zstd = require('@foxglove/wasm-zstd');
await zstd.isLoaded;
const lz4 = require('@foxglove/wasm-lz4');
await lz4.isLoaded;
const Bzip2 = require('@foxglove/wasm-bz2');
const bz2 = await Bzip2.init();

const zstdCompress = (data) => new Uint8Array(zstd.compress(data, 3));
const zstdDecompress = (src, destSize) => new Uint8Array(zstd.decompress(src, Number(destSize)));
const lz4Decompress = (src, destSize) => new Uint8Array(lz4(src, Number(destSize)));
const bz2Decompress = (src, destSize) => bz2.decompress(src, Number(destSize), {});

// ---- 1) build an MCAP with 3 channels, zstd-compressed chunks
const chunks_out = [];
const writable = {
  _pos: 0n,
  async write(buffer) { chunks_out.push(new Uint8Array(buffer)); this._pos += BigInt(buffer.byteLength); },
  position() { return this._pos; },
};
const writer = new McapWriter({
  writable,
  chunkSize: 256 * 1024,
  compressChunk: (data) => ({ compression: 'zstd', compressedData: zstdCompress(data) }),
});
await writer.start({ profile: 'ros2', library: 'smoke-test/1.0' });
const schemaImage = await writer.registerSchema({ name: 'sensor_msgs/msg/Image', encoding: 'ros2msg', data: new Uint8Array([1, 2, 3]) });
const schemaImu = await writer.registerSchema({ name: 'sensor_msgs/msg/Imu', encoding: 'ros2msg', data: new Uint8Array([4, 5, 6]) });
const chLeft = await writer.registerChannel({ schemaId: schemaImage, topic: '/cam/left/image', messageEncoding: 'cdr', metadata: new Map() });
const chRight = await writer.registerChannel({ schemaId: schemaImage, topic: '/cam/right/image', messageEncoding: 'cdr', metadata: new Map() });
const chImu = await writer.registerChannel({ schemaId: schemaImu, topic: '/vehicle/imu', messageEncoding: 'json', metadata: new Map() });

for (let i = 0; i < 30; i++) {
  const t = BigInt(i) * 1_000_000_000n; // 1s apart
  await writer.addMessage({ channelId: chLeft, sequence: i, logTime: t, publishTime: t, data: new Uint8Array([i, i + 1, i + 2, 0xff]) });
  await writer.addMessage({ channelId: chRight, sequence: i, logTime: t, publishTime: t, data: new Uint8Array([i, i + 1, i + 2, 0xee]) });
  await writer.addMessage({ channelId: chImu, sequence: i, logTime: t, publishTime: t, data: new TextEncoder().encode(JSON.stringify({ v: i })) });
}
await writer.end();
const bytes = new Uint8Array(chunks_out.reduce((acc, c) => acc + c.byteLength, 0));
let off = 0; for (const c of chunks_out) { bytes.set(c, off); off += c.byteLength; }
console.log('written bytes:', bytes.length, '(zstd-compressed chunks)');

// ---- 2) read it back the way the app does
const reader = await McapIndexedReader.Initialize({
  readable: new BlobReadable(new Blob([bytes])),
  decompressHandlers: { zstd: zstdDecompress, lz4: lz4Decompress, bz2: bz2Decompress },
});

// replicate app's buildTopics / buildFileInfo
const topics = [];
for (const ch of reader.channelsById.values()) {
  const schema = reader.schemasById.get(ch.schemaId);
  topics.push({ topic: ch.topic, schemaName: schema?.name, messageCount: Number(reader.statistics?.channelMessageCounts.get(ch.id)) });
}
const stats = reader.statistics;
console.log('topics:', topics.map((t) => `${t.topic} (${t.schemaName}, n=${t.messageCount})`).join(', '));
console.log('stats:', { messageCount: Number(stats?.messageCount), startTime: stats?.messageStartTime, endTime: stats?.messageEndTime, chunkCount: reader.chunkIndexes.length });

// ---- 3) lazy readMessages over a time range (app's readMessages helper)
const range = [];
for await (const m of reader.readMessages({ startTime: 5_000_000_000n, endTime: 7_000_000_000n })) range.push(m);
console.log('messages in [5s,7s]:', range.length, '| topics:', [...new Set(range.map((m) => reader.channelsById.get(m.channelId).topic))]);

// ---- 4) single-topic read + payload round trip
const imu = [];
for await (const m of reader.readMessages({ topics: ['/vehicle/imu'] })) imu.push(m);
console.log('imu messages total:', imu.length, '| first payload:', new TextDecoder().decode(imu[0].data));

const assert = (cond, label) => { if (!cond) { console.error('FAIL:', label); process.exit(1); } console.log('PASS:', label); };
assert(stats?.messageCount === 90n, 'messageCount == 90');
assert(range.length === 9, 'time-range query returns 9 messages (3 channels x 3 ticks, inclusive range)');
assert(imu.length === 30, 'imu topic has 30 messages');
assert(new TextDecoder().decode(imu[5].data) === '{"v":5}', 'imu payload round trip');
console.log('chunkIndexes:', reader.chunkIndexes.map(c => ({ compression: c.compression, uncompressedSize: c.uncompressedSize, compressedSize: c.compressedSize })));
assert(reader.chunkIndexes[0].compression === 'zstd', 'chunk marked zstd');
console.log('\nSMOKE TEST OK');
