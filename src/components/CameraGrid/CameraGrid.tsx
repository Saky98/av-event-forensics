import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { setGridLayout } from '../../store/appStore';
import { useMcapWorker } from '../../hooks/useMcapWorker';
import { formatRelativeTime } from '../../utils/mcap';
import './CameraGrid.css';

interface CameraSlot {
  ready: boolean;
  hasFrame: boolean;
  logTime: bigint | null;
  frameIndex: number | null;
  error: string | null;
}

const EMPTY_SLOT: CameraSlot = {
  ready: false,
  hasFrame: false,
  logTime: null,
  frameIndex: null,
  error: null,
};

/** Short human label from a topic like /camera_front/image/compressed -> Front */
function shortLabel(topic: string): string {
  const match = topic.match(/camera_([^/]+)/);
  if (!match) {
    return topic;
  }
  const name = match[1];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const CameraGrid: React.FC = () => {
  const dispatch = useDispatch();
  const { visibleCameras, currentTimestamp, gridLayout, playerReady, timeRange, frameStepMs } =
    useSelector((state: RootState) => state.app);
  const { readImage } = useMcapWorker();

  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  /** Guards against stale async responses while scrubbing fast. */
  const latestSeq = useRef<Record<string, number>>({});
  const [slots, setSlots] = useState<Record<string, CameraSlot>>({});

  const drawBitmap = useCallback((topic: string, bitmap: ImageBitmap) => {
    const canvas = canvasRefs.current[topic];
    if (!canvas) {
      return;
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0);
    }
  }, []);

  // Request the nearest frame <= currentTimestamp for every visible camera.
  useEffect(() => {
    if (!playerReady || !timeRange) {
      return;
    }
    for (const topic of visibleCameras) {
      const seq = (latestSeq.current[topic] ?? 0) + 1;
      latestSeq.current[topic] = seq;
      // Defensive: never request a frame before the recording start.
      const seekTime = currentTimestamp < timeRange.start ? timeRange.start : currentTimestamp;

      void readImage(topic, seekTime)
        .then((result) => {
          if (latestSeq.current[topic] !== seq) {
            // A newer request superseded this one.
            result.bitmap?.close();
            return;
          }
          setSlots((prev) => ({
            ...prev,
            [topic]: {
              ready: true,
              hasFrame: result.bitmap !== null,
              logTime: result.actualLogTime,
              frameIndex:
                result.actualLogTime !== null && timeRange
                  ? Math.round(Number(result.actualLogTime - timeRange.start) / (frameStepMs * 1e6))
                  : null,
              error: null,
            },
          }));
          if (result.bitmap) {
            drawBitmap(topic, result.bitmap);
          }
        })
        .catch((error: Error) => {
          if (latestSeq.current[topic] !== seq) {
            return;
          }
          setSlots((prev) => ({
            ...prev,
            [topic]: { ...(prev[topic] ?? EMPTY_SLOT), ready: true, error: error.message },
          }));
        });
    }
  }, [currentTimestamp, visibleCameras, playerReady, timeRange, frameStepMs, readImage, drawBitmap]);

  // Close any bitmaps we hold when unmounting (canvas content is GC'd anyway,
  // but ImageBitmap resources should be released explicitly).
  useEffect(() => {
    return () => {
      latestSeq.current = {};
    };
  }, []);

  const setLayout = (layout: '1' | '4' | '6') => {
    dispatch(setGridLayout(layout));
  };

  const shown = gridLayout === '1' ? visibleCameras.slice(0, 1) : gridLayout === '4' ? visibleCameras.slice(0, 4) : visibleCameras.slice(0, 6);

  return (
    <div className="camera-grid">
      <div className="camera-grid-header">
        <span className="camera-grid-title">Cameras</span>
        <div className="layout-switcher">
          {(['1', '4', '6'] as const).map((layout) => (
            <button
              key={layout}
              className={gridLayout === layout ? 'active' : ''}
              onClick={() => setLayout(layout)}
              title={`${layout === '1' ? '1 camera' : `${layout} cameras`}`}
            >
              {layout === '1' ? '1' : `${layout}`}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="camera-grid-empty">No camera topics found in this recording.</p>
      ) : (
        <div className={`camera-grid-panels grid-${gridLayout}`}>
          {shown.map((topic) => {
            const slot = slots[topic] ?? EMPTY_SLOT;
            return (
              <div className="camera-panel" key={topic}>
                <canvas
                  ref={(el) => {
                    canvasRefs.current[topic] = el;
                  }}
                  className="camera-canvas"
                />
                <div className="camera-panel-overlay">
                  <span className="camera-panel-name">{shortLabel(topic)}</span>
                  <span className="camera-panel-time">
                    {slot.error
                      ? '⚠ decode error'
                      : slot.hasFrame && slot.logTime !== null && timeRange
                        ? `${formatRelativeTime(slot.logTime, timeRange.start)}${slot.frameIndex !== null ? ` · #${slot.frameIndex + 1}` : ''}`
                        : !playerReady
                          ? 'initializing…'
                          : 'no frame'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CameraGrid;
