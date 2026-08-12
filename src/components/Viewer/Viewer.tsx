import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { formatBytes, formatDuration } from '../../utils/mcap';
import CameraGrid from '../CameraGrid/CameraGrid';
import './Viewer.css';

const Viewer: React.FC = () => {
  const { fileInfo, loadStatus, loadError, cameraTopics, playerReady } = useSelector(
    (state: RootState) => state.app,
  );

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

  return (
    <div className="viewer-container">
      <h2>{fileInfo.name}</h2>
      {showCameras ? (
        <CameraGrid />
      ) : (
        <>
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
            {cameraTopics.length === 0 ? (
              <p className="summary-hint">
                No compressed-image topics found — camera playback is unavailable for this file.
              </p>
            ) : (
              <p className="summary-hint">Initializing player…</p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default Viewer;
