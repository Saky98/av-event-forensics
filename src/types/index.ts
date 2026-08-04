export interface McapFile {
  name: string;
  file: File;
}

export interface AppState {
  currentTimestamp: bigint;
  topics: string[];
  currentFile: McapFile | null;
  isPlaying: boolean;
  playbackSpeed: number;
}
