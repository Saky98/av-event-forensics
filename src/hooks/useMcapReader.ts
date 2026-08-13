import { useCallback } from 'react';
import { useDispatch } from 'react-redux';
import {
  clearFile,
  setCameraTopics,
  setCurrentFile,
  setCurrentTimestamp,
  setEgoPoseTopic,
  setFileInfo,
  setFrameStepMs,
  setLidarTopics,
  setLoadError,
  setLoadStatus,
  setPlayerReady,
  setTimeRange,
  setTopics,
  setVisibleCameras,
  setAnnotationTopics,
} from '../store/appStore';
import { useMcapWorker } from './useMcapWorker';
import { clearMcapSession, loadMcapFile } from '../utils/mcap';

/** Topics that carry compressed images (cameras), by schema name or topic pattern. */
function isCameraTopic(schemaName: string, topic: string): boolean {
  return (
    schemaName === 'foxglove.CompressedImage' ||
    schemaName === 'sensor_msgs/msg/CompressedImage' ||
    /\/image\/compressed$/.test(topic)
  );
}

/**
 * Loads an MCAP file (selected by the user) into the app: parses the index on
 * the main thread for the sidebar, then hands the File to the decoding worker
 * and sets up the player state (time range, camera topics, grid).
 */
export function useMcapReader() {
  const dispatch = useDispatch();
  const { initWorker, closeWorker } = useMcapWorker();

  const loadFile = useCallback(
    async (file: File) => {
      dispatch(setLoadStatus('loading'));
      dispatch(setLoadError(null));
      try {
        const { info, topics } = await loadMcapFile(file);
        dispatch(setCurrentFile({ name: info.name, size: info.size }));
        dispatch(setFileInfo(info));
        dispatch(setTopics(topics));

        const cameraTopics = topics
          .filter((topic) => isCameraTopic(topic.schemaName, topic.topic))
          .map((topic) => topic.topic);
        dispatch(setCameraTopics(cameraTopics));
        dispatch(setVisibleCameras(cameraTopics.slice(0, 6)));

        // Point cloud topics (foxglove.PointCloud): per-frame sweeps vs static maps.
        const pointCloudTopics = topics
          .filter((t) => t.schemaName === 'foxglove.PointCloud')
          .map((t) => t.topic);
        const mapTopics = pointCloudTopics.filter((t) => /map|background/i.test(t));
        const sweepTopics = pointCloudTopics.filter((t) => !/map|background/i.test(t));
        dispatch(setLidarTopics({ pointTopics: sweepTopics, mapTopics }));
        dispatch(
          setAnnotationTopics(
            topics.filter((t) => t.schemaName === 'foxglove.SceneUpdate').map((t) => t.topic),
          ),
        );
        dispatch(
          setEgoPoseTopic(
            topics.find((t) => t.schemaName === 'foxglove.Pose' && /ego/.test(t.topic))?.topic ?? null,
          ),
        );

        dispatch(setTimeRange({ start: info.startTime, end: info.endTime }));
        // Start playback at the beginning of the recording — timestamps are
        // epoch-ns (huge), so keeping 0n would show negative time and no frame.
        dispatch(setCurrentTimestamp(info.startTime));
        // DeepAccident data is 10 fps; slider granularity is nominal anyway
        // (readImage always shows the nearest frame <= current time).
        dispatch(setFrameStepMs(100));

        // Non-fatal: the player still works for files without cameras.
        try {
          await initWorker(file);
          dispatch(setPlayerReady(true));
        } catch (error) {
          dispatch(setPlayerReady(false));
          console.warn('MCAP worker init failed:', error);
        }

        dispatch(setLoadStatus('ready'));
      } catch (error) {
        clearMcapSession();
        const message = error instanceof Error ? error.message : String(error);
        dispatch(setLoadError(message));
        dispatch(setLoadStatus('error'));
      }
    },
    [dispatch, initWorker],
  );

  const closeFile = useCallback(() => {
    void closeWorker();
    clearMcapSession();
    dispatch(clearFile());
  }, [closeWorker, dispatch]);

  return { loadFile, closeFile };
}
