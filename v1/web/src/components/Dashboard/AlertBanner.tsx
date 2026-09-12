import { useState } from 'react';
import type { SnapshotRow } from '../../hooks/useLiveSnapshot';

// Every cycle's equity leg starts only after the deliberate 2-minute
// NSE-politeness gap after the indices download (see scheduler.js), plus
// its own scrape time -- real on-schedule cycles routinely land ~2.5-3
// minutes after the slot even when nothing is wrong. The threshold has to
// clear that structural baseline with real margin, or every on-time cycle
// false-positives.
const DELAY_FLAG_SECONDS = 300;

export function DelayBanner({ rows }: { rows: SnapshotRow[] }) {
  const [dismissed, setDismissed] = useState(false);
  const flagged = rows.filter((r) => typeof r.delay_seconds === 'number' && (r.delay_seconds as number) > DELAY_FLAG_SECONDS);
  if (dismissed || flagged.length === 0) return null;

  return (
    <div className="alert-banner alert-banner-warn">
      <span>
        ⚠ {flagged.length} symbol{flagged.length === 1 ? '' : 's'} delayed more than {Math.round(DELAY_FLAG_SECONDS / 60)} minutes this cycle: {flagged.slice(0, 8).map((r) => r.symbol).join(', ')}
        {flagged.length > 8 ? '…' : ''}
      </span>
      <button className="chip-toggle" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  );
}

export function MissingSymbolToast({
  alert,
  onDismiss,
}: {
  alert: { count: number; symbols: string[]; ts_ist: string } | null;
  onDismiss: () => void;
}) {
  if (!alert) return null;
  return (
    <div className="missing-toast">
      <div className="missing-toast-header">
        <span className="cell-warn">⚠ {alert.count} symbols missing</span>
        <button className="chip-toggle" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <div className="text-3 mono" style={{ fontSize: 10.5 }}>
        cycle {alert.ts_ist}
      </div>
      <div className="missing-toast-list">{alert.symbols.slice(0, 40).join(', ')}</div>
    </div>
  );
}
