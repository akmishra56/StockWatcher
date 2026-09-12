import { Component, type ErrorInfo, type ReactNode } from 'react';

const FEATURES = [
  { title: 'Live Dashboard', body: 'Real-time NSE snapshots with RSI, MACD, Bollinger Bands, Supertrend and EMA, refreshed on every scheduled scrape.' },
  { title: 'Custom Filters', body: 'Build multi-condition filters -- including edge-triggered crosses above / crosses below -- and watch matches update live.' },
  { title: 'Trade Log', body: 'Track entries and exits with before/after chart snapshots and persistent notes per trade.' },
  { title: 'Historical Charts', body: 'TradingView-powered intraday and historical views for every tracked ticker.' },
];

/**
 * Without this, an uncaught render error anywhere in the tree unmounts the
 * WHOLE app -- a blank screen with nothing explaining why. Instead this
 * shows a static "something went wrong" page (so the screen never just
 * goes blank) with the error surfaced in a dismissable popup on top of it,
 * per the user's explicit request after a blank-screen crash report.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; info: ErrorInfo | null; dismissed: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null, info: null, dismissed: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    // eslint-disable-next-line no-console
    console.error('StockWatcher crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="crash-page">
        <div className="crash-hero">
          <div className="crash-hero-title">StockWatcher</div>
          <p className="crash-hero-tag">Live NSE market monitoring, filters and trade tracking.</p>
          <div className="crash-feature-grid">
            {FEATURES.map((f) => (
              <div className="crash-feature-card" key={f.title}>
                <div className="crash-feature-title">{f.title}</div>
                <div className="crash-feature-body">{f.body}</div>
              </div>
            ))}
          </div>
        </div>

        {!this.state.dismissed && (
          <div className="crash-popup-overlay">
            <div className="crash-popup" role="alertdialog" aria-live="assertive">
              <div className="crash-popup-title">Something went wrong</div>
              <p className="crash-popup-message">
                This screen ran into an unexpected error and couldn't continue. Your data is safe -- nothing was lost.
              </p>
              <details className="crash-popup-details">
                <summary>Technical details</summary>
                <pre>
                  {this.state.error.message}
                  {'\n'}
                  {this.state.error.stack}
                  {this.state.info?.componentStack}
                </pre>
              </details>
              <p className="crash-popup-footer">Our team has been notified and is looking into this error.</p>
              <div className="crash-popup-actions">
                <button className="crash-btn crash-btn-primary" onClick={() => window.location.reload()}>Reload app</button>
                <button className="crash-btn" onClick={() => this.setState({ dismissed: true })}>Dismiss</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
}
