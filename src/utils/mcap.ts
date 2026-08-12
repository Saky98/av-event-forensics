import { BlobReadable } from '@mcap/browser';
import { McapIndexedReader, type Message } from '@mcap/core';
import { loadDecompressHandlers } from './decompress';
import type { McapFileInfo, McapTopic } from '../types';

/**
 * Max bytes of message index data to keep cached in memory. Message indexes are
 * read lazily by McapIndexedReader on first access; caching avoids re-reading
 * them from disk on subsequent `readMessages()` calls.
 */
const MESSAGE_INDEX_CACHE_BYTES = 16 * 1024 * 1024;

/**
 * The active reader + File are kept outside Redux (they are not serializable)
 * in a module-level session. The store only holds lightweight metadata
 * (topics, file info, status), which keeps the app state serializable.
 */
let activeReader: McapIndexedReader | null = null;
let activeFile: File | null = null;

export function getActiveReader(): McapIndexedReader | null {
  return activeReader;
}

export function getActiveFile(): File | null {
  return activeFile;
}

function buildTopics(reader: McapIndexedReader): McapTopic[] {
  const topics: McapTopic[] = [];
  for (const channel of reader.channelsById.values()) {
    const schema = reader.schemasById.get(channel.schemaId);
    const messageCount = reader.statistics?.channelMessageCounts.get(channel.id) ?? 0n;
    topics.push({
      channelId: channel.id,
      topic: channel.topic,
      schemaId: channel.schemaId,
      schemaName: schema?.name ?? '<unknown>',
      messageEncoding: channel.messageEncoding,
      messageCount: Number(messageCount),
    });
  }
  // Stable ordering for the sidebar (grouped by topic name).
  return topics.sort((a, b) => a.topic.localeCompare(b.topic));
}

function buildFileInfo(file: File, reader: McapIndexedReader): McapFileInfo {
  const stats = reader.statistics;
  const startTime = stats?.messageStartTime ?? reader.chunkIndexes[0]?.messageStartTime ?? 0n;
  const endTime = stats?.messageEndTime ?? reader.chunkIndexes[0]?.messageEndTime ?? 0n;
  const compression = new Set<string>();
  for (const chunk of reader.chunkIndexes) {
    if (chunk.compression) {
      compression.add(chunk.compression);
    }
  }
  return {
    name: file.name,
    size: file.size,
    library: reader.header.library,
    profile: reader.header.profile,
    messageCount: Number(stats?.messageCount ?? 0n),
    channelCount: stats?.channelCount ?? reader.channelsById.size,
    schemaCount: stats?.schemaCount ?? reader.schemasById.size,
    chunkCount: reader.chunkIndexes.length,
    startTime,
    endTime,
    durationNanos: endTime - startTime,
    compressionFormats: [...compression],
  };
}

/**
 * Loads an MCAP file into an `McapIndexedReader` (reads the file summary + index
 * section) and returns the derived topic list and file info.
 */
export async function loadMcapFile(
  file: File,
): Promise<{ info: McapFileInfo; topics: McapTopic[] }> {
  const readable = new BlobReadable(file);
  // Loads wasm decompression handlers (zstd/lz4/bz2) only when first needed.
  const decompressHandlers = await loadDecompressHandlers();
  const reader = await McapIndexedReader.Initialize({
    readable,
    decompressHandlers,
    messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
  });
  activeReader = reader;
  activeFile = file;
  return { info: buildFileInfo(file, reader), topics: buildTopics(reader) };
}

/** Drops the current session (reader + file references). */
export function clearMcapSession(): void {
  activeReader = null;
  activeFile = null;
}

export interface ReadMessagesOptions {
  topics?: readonly string[];
  startTime?: bigint;
  endTime?: bigint;
  reverse?: boolean;
}

/**
 * Reads messages from the active session, lazily decoding only the chunks that
 * overlap the requested time range. Returns an empty array when no file is
 * loaded. Use this from the UI; heavy decoding should later move to a worker.
 */
export async function readMessages(options: ReadMessagesOptions = {}): Promise<Message[]> {
  if (!activeReader) {
    return [];
  }
  const messages: Message[] = [];
  for await (const message of activeReader.readMessages(options)) {
    messages.push(message);
  }
  return messages;
}

// ---- formatting helpers (shared by sidebar / timeline / viewer) ----

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(nanos: bigint): string {
  const totalSeconds = Number(nanos) / 1e9;
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0 s';
  }
  if (totalSeconds < 1) {
    return `${(totalSeconds * 1000).toFixed(0)} ms`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return minutes > 0 ? `${minutes}m ${seconds.toFixed(1)}s` : `${seconds.toFixed(1)}s`;
}

/** Formats a timestamp as seconds relative to a recording origin (e.g. file start). */
export function formatRelativeTime(nanos: bigint, origin: bigint): string {
  const seconds = Number(nanos - origin) / 1e9;
  if (!Number.isFinite(seconds)) {
    return '0.00 s';
  }
  return `${seconds.toFixed(2)} s`;
}
