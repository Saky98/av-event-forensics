import React, { useRef } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { useMcapReader } from '../../hooks/useMcapReader';
import { formatBytes, formatDuration } from '../../utils/mcap';
import './Sidebar.css';

type FilePickerHandle = {
  getFile: () => Promise<File>;
};

type FilePickerOptions = {
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  multiple?: boolean;
};

/**
 * Picks a single file with the File System Access API (Chromium). Returns null
 * when the API is unavailable or the user cancels the dialog — the caller then
 * falls back to a plain <input type="file">.
 */
async function pickMcapFile(): Promise<File | null> {
  const win = window as Window & {
    showOpenFilePicker?: (options?: FilePickerOptions) => Promise<FilePickerHandle[]>;
  };
  const picker = win.showOpenFilePicker;
  if (typeof picker !== 'function') {
    return null;
  }
  try {
    const [handle] = await picker.call(win, {
      types: [
        {
          description: 'MCAP recordings',
          accept: { 'application/octet-stream': ['.mcap'] },
        },
      ],
      multiple: false,
    });
    return await handle.getFile();
  } catch (error) {
    // AbortError = user dismissed the dialog; treat as "no file chosen".
    if (error instanceof DOMException && error.name === 'AbortError') {
      return null;
    }
    throw error;
  }
}

const Sidebar: React.FC = () => {
  const { topics, currentFile, fileInfo, loadStatus, loadError } = useSelector(
    (state: RootState) => state.app,
  );
  const { loadFile, closeFile } = useMcapReader();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpenClick = async () => {
    const picked = await pickMcapFile();
    if (picked) {
      void loadFile(picked);
      return;
    }
    // Fallback path (Firefox/Safari or older browsers).
    inputRef.current?.click();
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      void loadFile(file);
    }
    event.target.value = '';
  };

  // Group topics by schema (message type) for a hierarchical sidebar.
  const groups = new Map<string, typeof topics>();
  for (const topic of topics) {
    const list = groups.get(topic.schemaName) ?? [];
    list.push(topic);
    groups.set(topic.schemaName, list);
  }

  const isLoading = loadStatus === 'loading';

  return (
    <div className="sidebar-container">
      <div className="sidebar-header">
        <h3>File Manager</h3>
        <button onClick={handleOpenClick} disabled={isLoading}>
          {isLoading ? 'Loading…' : 'Open MCAP'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".mcap"
          className="file-input-hidden"
          onChange={handleInputChange}
          aria-label="Open MCAP file"
        />
        {currentFile && (
          <button onClick={closeFile} disabled={isLoading}>
            Close
          </button>
        )}
      </div>

      {loadError && <div className="load-error">⚠ {loadError}</div>}

      {fileInfo && (
        <div className="file-card">
          <div className="file-name" title={fileInfo.name}>
            {fileInfo.name}
          </div>
          <dl className="file-meta">
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(fileInfo.size)}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(fileInfo.durationNanos)}</dd>
            </div>
            <div>
              <dt>Messages</dt>
              <dd>{fileInfo.messageCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Channels</dt>
              <dd>{fileInfo.channelCount}</dd>
            </div>
            <div>
              <dt>Compression</dt>
              <dd>{fileInfo.compressionFormats.length ? fileInfo.compressionFormats.join(', ') : 'none'}</dd>
            </div>
            <div>
              <dt>Library</dt>
              <dd title={fileInfo.library}>{fileInfo.library || '—'}</dd>
            </div>
          </dl>
        </div>
      )}

      <h4>Topics</h4>
      {topics.length === 0 ? (
        <p className="empty-hint">
          {isLoading ? 'Parsing index…' : 'No file loaded. Open an .mcap file to see its topics.'}
        </p>
      ) : (
        <ul className="topic-groups">
          {[...groups.entries()].map(([schemaName, groupTopics]) => (
            <li key={schemaName} className="topic-group">
              <div className="topic-group-label" title={schemaName}>
                <span className="schema-name">{schemaName.split('/').pop()}</span>
                <span className="topic-count">{groupTopics.length}</span>
              </div>
              <ul className="topic-list">
                {groupTopics.map((topic) => (
                  <li key={topic.channelId} className="topic-item" title={topic.topic}>
                    <span className="topic-name">{topic.topic}</span>
                    <span className="topic-msg-count">{topic.messageCount.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default Sidebar;
