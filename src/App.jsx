import React, { useState, useEffect } from 'react';
import Dashboard from './pages/Dashboard';
import MobileCamera from './pages/MobileCamera';
import LiveViewer from './pages/LiveViewer';

export default function App({ initialView }) {
  const [currentView, setCurrentView] = useState(() => {
    if (initialView) return initialView;
    const path = window.location.pathname.toLowerCase();
    if (path.includes('mobile')) return 'mobile';
    if (path.includes('viewer')) return 'viewer';

    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    if (viewParam === 'mobile') return 'mobile';
    if (viewParam === 'viewer') return 'viewer';

    return 'dashboard';
  });

  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname.toLowerCase();
      if (path.includes('mobile')) setCurrentView('mobile');
      else if (path.includes('viewer')) setCurrentView('viewer');
      else setCurrentView('dashboard');
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (currentView === 'mobile') {
    return <MobileCamera />;
  }

  if (currentView === 'viewer') {
    return <LiveViewer />;
  }

  return <Dashboard />;
}
