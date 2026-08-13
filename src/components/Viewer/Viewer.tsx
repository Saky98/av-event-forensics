import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { formatBytes, formatDuration } from '../../utils/mcap';
import CameraGrid from '../CameraGrid/CameraGrid';
import LidarView from '../LidarView/LidarView';
import './Viewer.css';

type ViewerTab = 'cameras' | 'lidar';

const Viewer: React.FC = () => {
  const {
    fileInfo,
    loadStatus,
    loadError,
    cameraTopics,
    playerReady,
    lidarPointTopics,
    lidarMapTopics,
  } = useSelector((state: RootState) => state.app);
  const [tab, setTab] = useState<ViewerTab>('cameras');

  if (loadStatus === 'loading') {
    return (
      <div className="viewer-container">
        <h2>Viewer</h2>
        <p>Loading MCAP index…</p>
      </div>
    );
  }

  if (loadStatus === 'error') {
    return (
      <div className="viewer-container">
        <h2>Viewer</h2>
        <p className="load-error-viewer">Failed to load file: {loadError}</p>
      </div>
    );
  }

  if (!fileInfo) {
    return (
      <div className="viewer-container">
        <h2>Viewer</h2>
        <p>
          No recording loaded. Open an <code>.mcap</code> file from the File Manager to inspect its
          topics and schemas.
        </p>
      </div>
    );
  }

  const showCameras = cameraTopics.length > 0 && playerReady;
  const showLidar = (lidarPointTopics.length > 0 || lidarMapTopics.length > 0) && playerReady;
  const hasTabs = showCameras && showLidar;

  if (!showCameras && !showLidar) {
    return (
      <div className="viewer-container">
        <h2>{fileInfo.name}</h2>
        <div className="file-summary">
          <div className="summary-grid">
            <div className="summary-item">
              <span className="summary-label">Time range</span>
              <span className="summary-value">{formatDuration(fileInfo.durationNanos)}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Messages</span>
              <span className="summary-value">{fileInfo.messageCount.toLocaleString()}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Channels</span>
              <span className="summary-value">{fileInfo.channelCount}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Schemas</span>
              <span className="summary-value">{fileInfo.schemaCount}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Size</span>
              <span className="summary-value">{formatBytes(fileInfo.size)}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Compression</span>
              <span className="summary-value">
                {fileInfo.compressionFormats.length ? fileInfo.compressionFormats.join(', ') : 'none'}
              </span>
            </div>
          </div>
          <p className="summary-hint">
            No playable content (cameras / LiDAR) found in this recording.
          </p>
        </div>
      </div>
    );
  }

  const activeTab: ViewerTab = hasTabs ? tab : showCameras ? 'cameras' : 'lidar';

  return (
    <div className="viewer-container">
      <div className="viewer-header">
        <h2 className="viewer-title">{fileInfo.name}</h2>
        {hasTabs && (
          <div className="viewer-tabs">
            <button
              className={activeTab === 'cameras' ? 'active' : ''}
              onClick={() => setTab('cameras')}
            >
              Cameras
            </button>
            <button
              className={activeTab === 'lidar' ? 'active' : ''}
              onClick={() => setTab('lidar')}
            >
              3D LiDAR
            </button>
          </div>
        )}
      </div>
      {activeTab === 'cameras' ? <CameraGrid /> : <LidarView />}
    </div>
  );
};

export default Viewer;
