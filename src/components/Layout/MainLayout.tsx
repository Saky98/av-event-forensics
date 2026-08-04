import React from 'react';
import Sidebar from '../Sidebar/Sidebar';
import Viewer from '../Viewer/Viewer';
import Timeline from '../Timeline/Timeline';
import './MainLayout.css';

const MainLayout: React.FC = () => {
  return (
    <div className="main-layout">
      <aside className="sidebar">
        <Sidebar />
      </aside>
      <main className="viewer-area">
        <Viewer />
      </main>
      <footer className="timeline-area">
        <Timeline />
      </footer>
    </div>
  );
};

export default MainLayout;
