import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { AppState, McapFile } from '../types';

const initialState: AppState = {
  currentTimestamp: 0n,
  topics: [],
  currentFile: null,
  isPlaying: false,
  playbackSpeed: 1,
};

export const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    setCurrentTimestamp: (state, action: PayloadAction<bigint>) => {
      state.currentTimestamp = action.payload;
    },
    setTopics: (state, action: PayloadAction<string[]>) => {
      state.topics = action.payload;
    },
    setCurrentFile: (state, action: PayloadAction<McapFile | null>) => {
      state.currentFile = action.payload;
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
  setIsPlaying,
  setPlaybackSpeed,
  togglePlay,
} = appSlice.actions;

export default appSlice.reducer;
