import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { formatBytes, formatDuration } from '../../utils/mcap';
import CameraGrid from '../CameraGrid/CameraGrid';
import LidarView from '../LidarView/LidarView';
import TelemetryPanel from '../TelemetryPanel/TelemetryPanel';
import './Viewer.css';

type ViewerTab = 'cameras' | 'lidar' | 'telemetry';

const Viewer: React.FC = () => {
  const {
    fileInfo,
    loadStatus,
    loadError,
    cameraTopics,
    playerReady,
    lidarPointTopics,
    lidarMapTopics,
    velocityTopic,
    accelerationTopic,
    egoPoseTopic,
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
  const showTelemetry = Boolean(velocityTopic || accelerationTopic || egoPoseTopic) && playerReady;
  const tabsCount = [showCameras, showLidar, showTelemetry].filter(Boolean).length;
  const hasTabs = tabsCount > 1;
  const activeTab: ViewerTab = hasTabs ? tab : showCameras ? 'cameras' : showLidar ? 'lidar' : 'telemetry';

  if (!showCameras && !showLidar && !showTelemetry) {
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
            No playable content (cameras / LiDAR / telemetry) found in this recording.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-container">
      <div className="viewer-header">
        <h2 className="viewer-title">{fileInfo.name}</h2>
        {hasTabs && (
          <div className="viewer-tabs">
            {showCameras && (
              <button
                className={activeTab === 'cameras' ? 'active' : ''}
                onClick={() => setTab('cameras')}
              >
                Cameras
              </button>
            )}
            {showLidar && (
              <button
                className={activeTab === 'lidar' ? 'active' : ''}
                onClick={() => setTab('lidar')}
              >
                3D LiDAR
              </button>
            )}
            {showTelemetry && (
              <button
                className={activeTab === 'telemetry' ? 'active' : ''}
                onClick={() => setTab('telemetry')}
              >
                Telemetry
              </button>
            )}
          </div>
        )}
      </div>
      {activeTab === 'cameras' && <CameraGrid />}
      {activeTab === 'lidar' && <LidarView />}
      {activeTab === 'telemetry' && <TelemetryPanel />}
    </div>
  );
};

export default Viewer;
