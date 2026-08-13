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

/** A numeric time series, x in seconds relative to the recording start. */
export interface TelemetrySeries {
  t: number[];
  v: number[];
}

export interface TelemetryData {
  velocity: TelemetrySeries | null;
  acceleration: TelemetrySeries | null;
  pose: { t: number[]; x: number[]; y: number[]; yaw: number[] } | null;
}

/** Event topics (collision flag, sudden-braking records) — Phase 6. */
export interface EventData {
  collision: { t: number[]; v: number[] } | null;
  braking: Array<{ t: number; event: Record<string, unknown> | null }>;
}

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
  /** Dynamic point cloud topics (per-frame lidar sweeps), e.g. /lidar/points. */
  lidarPointTopics: string[];
  /** Static point cloud topics (maps), e.g. /lidar/background_map. */
  lidarMapTopics: string[];
  /** SceneUpdate topics carrying 3D annotations (bounding boxes). */
  annotationTopics: string[];
  /** Topic publishing the ego vehicle pose (foxglove.Pose), or null. */
  egoPoseTopic: string | null;
  /** Topic publishing ego velocity (std_msgs/Float64), or null. */
  velocityTopic: string | null;
  /** Topic publishing ego acceleration (std_msgs/Float64), or null. */
  accelerationTopic: string | null;
  /** Loaded telemetry time series (relative seconds), or null when unavailable. */
  telemetry: TelemetryData | null;
  /** Topic publishing collision flags (std_msgs/Bool), or null. */
  collisionTopic: string | null;
  /** Topic publishing sudden-braking events (std_msgs/String), or null. */
  brakingTopic: string | null;
  /** Parsed event topics (Phase 6). */
  events: EventData | null;
  /** SHA-256 of the loaded file (computed in the worker), or null. */
  fileHash: string | null;
  /** Optional expected hash the user pastes for comparison. */
  expectedHash: string | null;
}
