import { useCallback } from 'react';
import { useDispatch } from 'react-redux';
import {
  clearFile,
  setAccelerationTopic,
  setAnnotationTopics,
  setCameraTopics,
  setCurrentFile,
  setCurrentTimestamp,
  setEgoPoseTopic,
  setCollisionTopic,
  setBrakingTopic,
  setEvents,
  setFileHash,
  setFileInfo,
  setFrameStepMs,
  setLidarTopics,
  setLoadError,
  setLoadStatus,
  setPlayerReady,
  setTelemetry,
  setTimeRange,
  setTopics,
  setVelocityTopic,
  setVisibleCameras,
} from '../store/appStore';
import type { EventData, TelemetryData } from '../types';
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
 * and sets up the player state (time range, camera topics, grid, telemetry).
 */
export function useMcapReader() {
  const dispatch = useDispatch();
  const { initWorker, closeWorker, readTelemetry, readEvents, hashFile } = useMcapWorker();

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
        const egoPoseTopic =
          topics.find((t) => t.schemaName === 'foxglove.Pose' && /ego/.test(t.topic))?.topic ?? null;
        dispatch(setEgoPoseTopic(egoPoseTopic));

        // Telemetry: std_msgs/Float64 topics named velocity/acceleration.
        const velocityTopic =
          topics.find((t) => t.schemaName === 'std_msgs/Float64' && /velocity/.test(t.topic))?.topic ?? null;
        const accelerationTopic =
          topics.find((t) => t.schemaName === 'std_msgs/Float64' && /acceleration/.test(t.topic))?.topic ?? null;
        dispatch(setVelocityTopic(velocityTopic));
        dispatch(setAccelerationTopic(accelerationTopic));

        // Event topics (Phase 6): collision flag + sudden-braking records.
        const collisionTopic =
          topics.find((t) => t.schemaName === 'std_msgs/Bool' && /collision/i.test(t.topic))?.topic ?? null;
        const brakingTopic =
          topics.find((t) => t.schemaName === 'std_msgs/String' && /braking|event/i.test(t.topic))?.topic ?? null;
        dispatch(setCollisionTopic(collisionTopic));
        dispatch(setBrakingTopic(brakingTopic));

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

          // Telemetry series (velocity/acceleration/pose) — small, read once.
          try {
            const result = await readTelemetry({
              velocityTopic,
              accelerationTopic,
              poseTopic: egoPoseTopic,
              originNs: info.startTime,
            });
            const toArr = (fa: Float64Array | null): number[] | null => (fa ? Array.from(fa) : null);
            const telemetry: TelemetryData = {
              velocity: result.velocity
                ? { t: toArr(result.velocity.t)!, v: toArr(result.velocity.v)! }
                : null,
              acceleration: result.acceleration
                ? { t: toArr(result.acceleration.t)!, v: toArr(result.acceleration.v)! }
                : null,
              pose: result.pose
                ? { t: toArr(result.pose.t)!, x: toArr(result.pose.x)!, y: toArr(result.pose.y)!, yaw: toArr(result.pose.yaw)! }
                : null,
            };
            dispatch(setTelemetry(telemetry));
          } catch (error) {
            console.warn('telemetry load failed:', error);
          }

          // Events (collision / braking) + file SHA-256 (Phase 6).
          try {
            const ev = await readEvents({
              collisionTopic,
              brakingTopic,
              originNs: info.startTime,
            });
            const events: EventData = {
              collision: ev.collision
                ? { t: Array.from(ev.collision.t), v: Array.from(ev.collision.v) }
                : null,
              braking: ev.braking,
            };
            dispatch(setEvents(events));
          } catch (error) {
            console.warn('events load failed:', error);
          }
          try {
            dispatch(setFileHash(await hashFile()));
          } catch (error) {
            console.warn('file hash failed:', error);
          }
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
    [dispatch, initWorker, readTelemetry, readEvents, hashFile],
  );

  const closeFile = useCallback(() => {
    void closeWorker();
    clearMcapSession();
    dispatch(clearFile());
  }, [closeWorker, dispatch]);

  return { loadFile, closeFile };
}
