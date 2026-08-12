export interface McapTopic {
  /** Unique id of the channel in the MCAP file */
  channelId: number;
  /** Fully qualified topic name, e.g. /camera_01/image_raw */
  topic: string;
  schemaId: number;
  /** Schema (message type) name, e.g. sensor_msgs/msg/Image */
  schemaName: string;
  /** Serialization used for the message payload, e.g. cdr, json, protobuf */
  messageEncoding: string;
  /** Number of messages recorded on this topic */
  messageCount: number;
}

export interface McapFileSummary {
  name: string;
  size: number;
}

export interface McapFileInfo {
  name: string;
  size: number;
  /** value of the library field in the MCAP header */
  library: string;
  /** value of the profile field in the MCAP header */
  profile: string;
  messageCount: number;
  channelCount: number;
  schemaCount: number;
  chunkCount: number;
  /** Nanoseconds since MCAP epoch */
  startTime: bigint;
  endTime: bigint;
  durationNanos: bigint;
  /** Compression algorithms used by chunks (e.g. zstd, lz4, bz2) */
  compressionFormats: string[];
}

export type McapLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface TimeRange {
  start: bigint;
  end: bigint;
}

/** Number of cameras shown in the grid: 1, 4 (2x2) or 6 (2x3, default). */
export type GridLayout = '1' | '4' | '6';

export interface AppState {
  currentTimestamp: bigint;
  topics: McapTopic[];
  currentFile: McapFileSummary | null;
  fileInfo: McapFileInfo | null;
  loadStatus: McapLoadStatus;
  loadError: string | null;
  isPlaying: boolean;
  playbackSpeed: number;
  /** Valid time range of the loaded recording (nanoseconds). */
  timeRange: TimeRange | null;
  /** Topics that carry compressed images (cameras). */
  cameraTopics: string[];
  /** Subset of cameraTopics currently shown. */
  visibleCameras: string[];
  /** Grid layout preset. */
  gridLayout: GridLayout;
  /** True once the decoding worker is initialized for the current file. */
  playerReady: boolean;
  /** Nominal inter-frame interval in ms (DeepAccident: 10 fps -> 100 ms). */
  frameStepMs: number;
}
