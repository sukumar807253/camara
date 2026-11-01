import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  const initialView = rootEl.dataset.view;
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App initialView={initialView} />
    </React.StrictMode>
  );
}
