import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';

const Sidebar: React.FC = () => {
  const { topics, currentFile } = useSelector((state: RootState) => state.app);

  return (
    <div className="sidebar-container">
      <h3>File Manager</h3>
      {currentFile ? (
        <p>Current file: {currentFile.name}</p>
      ) : (
        <p>No MCAP file loaded</p>
      )}
      <h4>Topics:</h4>
      <ul>
        {topics.length === 0 ? (
          <li>No topics</li>
        ) : (
          topics.map((topic) => <li key={topic}>{topic}</li>)
        )}
      </ul>
    </div>
  );
};

export default Sidebar;
