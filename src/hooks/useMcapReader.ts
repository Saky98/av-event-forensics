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
  setIntegrity,
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
import { buildChainRecords, computeChain } from '../utils/forensics';
import { compareIntegrity, saveIntegritySnapshot } from '../utils/integrity';

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

  // Builds a per-frame chain from the loaded telemetry/events for the snapshot.
  const syncIntegrity = useCallback(
    async (
      fileName: string,
      telemetry: TelemetryData | null,
      events: EventData | null,
      fileHash: string | null,
    ): Promise<void> => {
      if (!fileHash) {
        dispatch(setIntegrity({ intact: false, mismatchFile: false, mismatchChain: false, noSnapshot: true }));
        return;
      }
      const collisionTimes = events?.collision?.t ?? null;
      const collisionValues = events?.collision?.v ?? null;
      const brakingTimes = events?.braking.map((b) => b.t) ?? [];
      const records = telemetry
        ? buildChainRecords(telemetry, collisionTimes, collisionValues, brakingTimes)
        : [];
      const links = await computeChain(records);
      const frameChain = links.map((l) => l.hash);

      const comparison = await compareIntegrity(fileName, fileHash, frameChain);
      if (comparison.noSnapshot) {
        await saveIntegritySnapshot(fileName, {
          fileHash,
          frameChain,
          createdAt: new Date().toISOString(),
        });
        dispatch(
          setIntegrity({
            intact: true,
            mismatchFile: false,
            mismatchChain: false,
            noSnapshot: false,
            snapshotShort: fileHash.slice(0, 8),
          }),
        );
      } else {
        dispatch(setIntegrity(comparison));
      }
    },
    [dispatch],
  );

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

          // Collected during load; used to build the integrity snapshot/chain.
          let loadedTelemetry: TelemetryData | null = null;
          let loadedEvents: EventData | null = null;

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
            loadedTelemetry = telemetry;
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
            loadedEvents = events;
            dispatch(setEvents(events));
          } catch (error) {
            console.warn('events load failed:', error);
          }
          let fileHashValue: string | null = null;
          try {
            fileHashValue = await hashFile();
            dispatch(setFileHash(fileHashValue));
          } catch (error) {
            console.warn('file hash failed:', error);
          }

          // Integrity snapshot & registry (chain of custody).
          try {
            await syncIntegrity(info.name, loadedTelemetry, loadedEvents, fileHashValue);
          } catch (error) {
            console.warn('integrity snapshot failed:', error);
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
    [dispatch, initWorker, readTelemetry, readEvents, hashFile, syncIntegrity],
  );

  const closeFile = useCallback(() => {
    void closeWorker();
    clearMcapSession();
    dispatch(clearFile());
  }, [closeWorker, dispatch]);

  return { loadFile, closeFile };
}
