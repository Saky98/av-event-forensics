import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { togglePlay, setPlaybackSpeed } from '../../store/appStore';

const Timeline: React.FC = () => {
  const dispatch = useDispatch();
  const { currentTimestamp, isPlaying, playbackSpeed } = useSelector(
    (state: RootState) => state.app
  );

  const formatTime = (ts: bigint) => {
    const seconds = Number(ts) / 1e9;
    return seconds.toFixed(2) + 's';
  };

  const handleTogglePlay = () => {
    dispatch(togglePlay());
  };

  const handleSpeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    dispatch(setPlaybackSpeed(parseFloat(e.target.value)));
  };

  return (
    <div className="timeline-container">
      <div>
        <button onClick={handleTogglePlay}>
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <span>Time: {formatTime(currentTimestamp)}</span>
        <span>Speed: {playbackSpeed}x</span>
        <input
          type="range"
          min="0.1"
          max="3"
          step="0.1"
          value={playbackSpeed}
          onChange={handleSpeedChange}
        />
      </div>
      <div className="timeline-track">
        <p>Timeline (placeholder)</p>
      </div>
    </div>
  );
};

export default Timeline;
