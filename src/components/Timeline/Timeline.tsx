import React, { useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { setCurrentTimestamp, setIsPlaying, setPlaybackSpeed } from '../../store/appStore';
import { formatRelativeTime } from '../../utils/mcap';
import './Timeline.css';

const Timeline: React.FC = () => {
  const dispatch = useDispatch();
  const { currentTimestamp, isPlaying, playbackSpeed, timeRange, frameStepMs } = useSelector(
    (state: RootState) => state.app,
  );

  // Keep the latest timestamp for the interval callback without restarting it.
  const timestampRef = useRef(currentTimestamp);
  useEffect(() => {
    timestampRef.current = currentTimestamp;
  }, [currentTimestamp]);

  const start = timeRange?.start ?? 0n;
  const end = timeRange?.end ?? 0n;
  const stepNs = BigInt(frameStepMs) * 1_000_000n; // ms -> ns
  const frameNs = frameStepMs * 1e6; // ns per frame (number)
  const totalFrames = timeRange ? Math.floor(Number(end - start) / frameNs) : 0;
  const currentFrame = timeRange ? Math.floor(Number(currentTimestamp - start) / frameNs) : 0;
  const clampedFrame = Math.min(Math.max(currentFrame, 0), totalFrames);

  // Playback loop: advance exactly one frame per tick (frame-accurate scrubbing).
  useEffect(() => {
    if (!isPlaying || !timeRange) {
      return;
    }
    const intervalMs = Math.max(10, frameStepMs / playbackSpeed);
    const id = window.setInterval(() => {
      let next = timestampRef.current + stepNs;
      if (next > end) {
        next = start; // loop
      }
      dispatch(setCurrentTimestamp(next));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [isPlaying, playbackSpeed, timeRange, frameStepMs, stepNs, end, start, dispatch]);

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const frame = Number(event.target.value);
    dispatch(setCurrentTimestamp(start + BigInt(frame) * stepNs));
  };

  const hasFile = timeRange !== null;

  return (
    <div className="timeline-container">
      <div className="timeline-controls">
        <button
          onClick={() => dispatch(setIsPlaying(!isPlaying))}
          disabled={!hasFile}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <span className="timeline-speed">
          Speed: {playbackSpeed.toFixed(1)}x
          <input
            type="range"
            min="0.1"
            max="3"
            step="0.1"
            value={playbackSpeed}
            onChange={(e) => dispatch(setPlaybackSpeed(parseFloat(e.target.value)))}
            disabled={!hasFile}
          />
        </span>
        <span className="timeline-time">
          {hasFile ? formatRelativeTime(currentTimestamp, start) : '0.00 s'}
          {' / '}
          {hasFile ? formatRelativeTime(end, start) : '0.00 s'}
        </span>
        <span className="timeline-frame">
          {hasFile ? `frame ${clampedFrame + 1} / ${totalFrames + 1}` : 'no file'}
        </span>
      </div>
      <div className="timeline-track">
        <input
          type="range"
          className="timeline-scrubber"
          min={0}
          max={Math.max(totalFrames, 0)}
          step={1}
          value={clampedFrame}
          onChange={handleSeek}
          disabled={!hasFile}
          aria-label="Seek timeline"
        />
      </div>
    </div>
  );
};

export default Timeline;
