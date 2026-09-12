import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';

export function ClassificationSection() {
  const [status, setStatus] = useState<Record<string, { count: number; updatedAt: string | null }> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  function refresh() {
    api.getClassificationStatus().then(setStatus);
  }
  useEffect(refresh, []);

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    try {
      const res = await api.uploadClassification('nifty50', file);
      setMessage(`✓ ${res.count} symbols uploaded for Nifty 50`);
      refresh();
    } catch (err) {
      setMessage(`✗ ${(err as Error).message}`);
    }
  }

  return (
    <div className="settings-section">
      <h3>Index Classification</h3>
      <p className="text-2" style={{ fontSize: 12 }}>
        v1 tracks exactly one universe -- Nifty 50. Upload a symbol-list CSV (a plain symbol list, or a full NSE
        market-watch export where only the SYMBOL column is used) to update membership.
      </p>

      <div className="params-grid">
        <div className="param-group">
          <div className="param-group-title">Nifty 50</div>
          <div className="param-group-fields" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
            <span className="text-2 mono" style={{ fontSize: 11 }}>
              {status?.nifty50?.count ?? 0} symbols · updated {status?.nifty50?.updatedAt ?? 'never'}
            </span>
            <button className="chip-toggle" onClick={() => inputRef.current?.click()}>⭱ Upload CSV</button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv"
              style={{ display: 'none' }}
              onChange={(e) => handleUpload(e.target.files?.[0]).then(() => (e.target.value = ''))}
            />
          </div>
        </div>
      </div>

      {message && <div className="text-2" style={{ fontSize: 11.5, marginTop: 8 }}>{message}</div>}
    </div>
  );
}
