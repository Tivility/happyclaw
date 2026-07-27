import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';
import { shouldUseHashRouter } from './utils/url';
import { cleanupLegacyPwaArtifacts } from './utils/legacyPwaCleanup';

if (typeof window !== 'undefined') {
  window.__HAPPYCLAW_HASH_ROUTER__ = shouldUseHashRouter();

  // Prevent pinch-to-zoom on iOS (iOS 10+ ignores user-scalable=no)
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
}

if (typeof window !== 'undefined') {
  // HappyClaw no longer uses a Service Worker. Clean up registrations and
  // Cache Storage left by older releases without delaying the first render.
  void cleanupLegacyPwaArtifacts();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
