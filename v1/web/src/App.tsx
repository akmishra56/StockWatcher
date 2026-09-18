import { useEffect, useState } from 'react';
import { useLiveSnapshot } from './hooks/useLiveSnapshot';
import { useTheme } from './hooks/useTheme';
import { api } from './api';
import { DashboardTab } from './components/Dashboard/DashboardTab';
import { WatchlistsTab } from './components/Watchlists/WatchlistsTab';
import { SettingsTab } from './components/Settings/SettingsTab';
import { DisclaimerModal } from './components/Disclaimer/DisclaimerModal';
import { PriceAlertTicker } from './components/PriceAlerts/PriceAlertTicker';
import './theme.css';
import './app.css';

// Draws attention back to the disclaimer link periodically -- it's a
// blocking popup only on first load; after that it's easy to forget it's
// still one click away, so the link flashes on this cadence per the user's
// explicit instruction.
const DISCLAIMER_FLASH_INTERVAL_MS = 5 * 60 * 1000;
const DISCLAIMER_FLASH_DURATION_MS = 60 * 1000;

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'watchlists', label: 'Watchlists' },
  { key: 'settings', label: 'Settings' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export default function App() {
  const { rows, logEntries, missingSymbolAlert, priceAlertEvents, clearMissingSymbolAlert, connectionStatus, mergeRows } = useLiveSnapshot();
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState<TabKey>('dashboard');
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean | null>(null);
  const [isMarketOpen, setIsMarketOpen] = useState<boolean | null>(null);
  const [disclaimerOpen, setDisclaimerOpen] = useState(true);
  const [disclaimerFlash, setDisclaimerFlash] = useState(false);

  function refreshScheduler() {
    api.getScheduler().then((s) => { setSchedulerEnabled(s.enabled); setIsMarketOpen(s.isMarketOpen); }).catch(() => {});
  }
  // Polled (not just on mount/settings-change) so the Market Open/Closed
  // indicator flips on its own right at the configured open/close time,
  // without needing a Settings visit or a page reload.
  useEffect(() => {
    refreshScheduler();
    const id = setInterval(refreshScheduler, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function flash() {
      setDisclaimerFlash(true);
      setTimeout(() => setDisclaimerFlash(false), DISCLAIMER_FLASH_DURATION_MS);
    }
    // One flash shortly after load, then on the regular cadence -- without
    // this, confirming the flash works at all means waiting a full interval.
    const initial = setTimeout(flash, 3000);
    const id = setInterval(flash, DISCLAIMER_FLASH_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="app-topbar">
        <div className="app-brand">
          <span className="app-title">StockWatcher</span>
          <span className="universeBadge">Nifty 50 universe</span>
        </div>
        <nav className="app-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`app-tab ${tab === t.key ? 'app-tab-active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
          <button
            className={`disclaimer-link ${disclaimerFlash ? 'disclaimer-link-flash' : ''}`}
            onClick={() => setDisclaimerOpen(true)}
            title="Risk disclaimer"
          >
            Disclaimer
          </button>
        </nav>
        <div className="app-topbar-right">
          {isMarketOpen !== null && (
            <span className="market-status" title="Configured in Settings > Automation & Scheduler > Market hours">
              <span className={`market-status-dot ${isMarketOpen ? 'market-status-dot-open' : 'market-status-dot-closed'}`} />
              Market {isMarketOpen ? 'Open' : 'Closed'}
            </span>
          )}
          <span className="status">
            <span className={`status-dot status-dot-${connectionStatus}`} />
            {connectionStatus} · {rows.length} symbols
          </span>
          <button className="chip-toggle" onClick={toggle}>
            {theme === 'dark' ? '☀ Light' : '● Dark'}
          </button>
        </div>
      </div>

      {disclaimerOpen && <DisclaimerModal onClose={() => setDisclaimerOpen(false)} />}

      <div className="app-body">
        {tab === 'dashboard' && (
          <DashboardTab
            rows={rows}
            mergeRows={mergeRows}
            logEntries={logEntries}
            missingSymbolAlert={missingSymbolAlert}
            clearMissingSymbolAlert={clearMissingSymbolAlert}
          />
        )}
        {tab === 'watchlists' && <WatchlistsTab rows={rows} mergeRows={mergeRows} />}
        {tab === 'settings' && <SettingsTab onSchedulerChanged={refreshScheduler} />}
      </div>

      <PriceAlertTicker liveEvents={priceAlertEvents} />
    </div>
  );
}
