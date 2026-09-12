import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';

// Dev-only preview hook: visiting /?crashtest=1 renders a component that
// throws immediately, so the ErrorBoundary fallback page can be inspected
// on demand without waiting for (or faking) a real crash. Remove once the
// crash page has been reviewed.
function CrashTestTrigger(): never {
  throw new Error('Crash test triggered via ?crashtest=1 -- this is not a real error.');
}
const crashTest = new URLSearchParams(window.location.search).get('crashtest') === '1';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {crashTest ? <CrashTestTrigger /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
