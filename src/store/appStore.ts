import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  AppState,
  EventData,
  GridLayout,
  McapFileInfo,
  McapFileSummary,
  McapLoadStatus,
  McapTopic,
  TelemetryData,
  TimeRange,
} from '../types';

const initialState: AppState = {
  currentTimestamp: 0n,
  topics: [],
  currentFile: null,
  fileInfo: null,
  loadStatus: 'idle',
  loadError: null,
  isPlaying: false,
  playbackSpeed: 1,
  timeRange: null,
  cameraTopics: [],
  visibleCameras: [],
  gridLayout: '6',
  playerReady: false,
  frameStepMs: 100,
  lidarPointTopics: [],
  lidarMapTopics: [],
  annotationTopics: [],
  egoPoseTopic: null,
  velocityTopic: null,
  accelerationTopic: null,
  telemetry: null,
  collisionTopic: null,
  brakingTopic: null,
  events: null,
  fileHash: null,
  expectedHash: null,
};

export const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    setCurrentTimestamp: (state, action: PayloadAction<bigint>) => {
      state.currentTimestamp = action.payload;
    },
    setTopics: (state, action: PayloadAction<McapTopic[]>) => {
      state.topics = action.payload;
    },
    setCurrentFile: (state, action: PayloadAction<McapFileSummary | null>) => {
      state.currentFile = action.payload;
    },
    setFileInfo: (state, action: PayloadAction<McapFileInfo | null>) => {
      state.fileInfo = action.payload;
    },
    setLoadStatus: (state, action: PayloadAction<McapLoadStatus>) => {
      state.loadStatus = action.payload;
    },
    setLoadError: (state, action: PayloadAction<string | null>) => {
      state.loadError = action.payload;
    },
    setTimeRange: (state, action: PayloadAction<TimeRange | null>) => {
      state.timeRange = action.payload;
    },
    setCameraTopics: (state, action: PayloadAction<string[]>) => {
      state.cameraTopics = action.payload;
    },
    setVisibleCameras: (state, action: PayloadAction<string[]>) => {
      state.visibleCameras = action.payload;
    },
    setGridLayout: (state, action: PayloadAction<GridLayout>) => {
      state.gridLayout = action.payload;
    },
    setPlayerReady: (state, action: PayloadAction<boolean>) => {
      state.playerReady = action.payload;
    },
    setFrameStepMs: (state, action: PayloadAction<number>) => {
      state.frameStepMs = action.payload;
    },
    setLidarTopics: (state, action: PayloadAction<{ pointTopics: string[]; mapTopics: string[] }>) => {
      state.lidarPointTopics = action.payload.pointTopics;
      state.lidarMapTopics = action.payload.mapTopics;
    },
    setAnnotationTopics: (state, action: PayloadAction<string[]>) => {
      state.annotationTopics = action.payload;
    },
    setEgoPoseTopic: (state, action: PayloadAction<string | null>) => {
      state.egoPoseTopic = action.payload;
    },
    setVelocityTopic: (state, action: PayloadAction<string | null>) => {
      state.velocityTopic = action.payload;
    },
    setAccelerationTopic: (state, action: PayloadAction<string | null>) => {
      state.accelerationTopic = action.payload;
    },
    setTelemetry: (state, action: PayloadAction<TelemetryData | null>) => {
      state.telemetry = action.payload;
    },
    setCollisionTopic: (state, action: PayloadAction<string | null>) => {
      state.collisionTopic = action.payload;
    },
    setBrakingTopic: (state, action: PayloadAction<string | null>) => {
      state.brakingTopic = action.payload;
    },
    setEvents: (state, action: PayloadAction<EventData | null>) => {
      state.events = action.payload;
    },
    setFileHash: (state, action: PayloadAction<string | null>) => {
      state.fileHash = action.payload;
    },
    setExpectedHash: (state, action: PayloadAction<string | null>) => {
      state.expectedHash = action.payload;
    },
    clearFile: (state) => {
      state.currentFile = null;
      state.fileInfo = null;
      state.topics = [];
      state.loadStatus = 'idle';
      state.loadError = null;
      state.currentTimestamp = 0n;
      state.timeRange = null;
      state.cameraTopics = [];
      state.visibleCameras = [];
      state.playerReady = false;
      state.isPlaying = false;
      state.lidarPointTopics = [];
      state.lidarMapTopics = [];
      state.annotationTopics = [];
      state.egoPoseTopic = null;
      state.velocityTopic = null;
      state.accelerationTopic = null;
      state.telemetry = null;
      state.collisionTopic = null;
      state.brakingTopic = null;
      state.events = null;
      state.fileHash = null;
      state.expectedHash = null;
    },
    setIsPlaying: (state, action: PayloadAction<boolean>) => {
      state.isPlaying = action.payload;
    },
    setPlaybackSpeed: (state, action: PayloadAction<number>) => {
      state.playbackSpeed = action.payload;
    },
    togglePlay: (state) => {
      state.isPlaying = !state.isPlaying;
    },
  },
});

export const {
  setCurrentTimestamp,
  setTopics,
  setCurrentFile,
  setFileInfo,
  setLoadStatus,
  setLoadError,
  setTimeRange,
  setCameraTopics,
  setVisibleCameras,
  setGridLayout,
  setPlayerReady,
  setFrameStepMs,
  setLidarTopics,
  setAnnotationTopics,
  setEgoPoseTopic,
  setVelocityTopic,
  setAccelerationTopic,
  setTelemetry,
  setCollisionTopic,
  setBrakingTopic,
  setEvents,
  setFileHash,
  setExpectedHash,
  clearFile,
  setIsPlaying,
  setPlaybackSpeed,
  togglePlay,
} = appSlice.actions;

export default appSlice.reducer;
