import { useEffect, useState } from 'react';
import { api } from '../../api';

export function MonitorLogSection() {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.getMonitorLog>>>([]);

  useEffect(() => {
    const load = () => api.getMonitorLog(30).then(setEntries).catch(() => {});
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="settings-section">
      <h3>Monitor Log</h3>
      <p className="text-2" style={{ fontSize: 12 }}>Ingestion cycle history, including missing-symbol detail per cycle.</p>
      <div className="table-scroll" style={{ maxHeight: 480 }}>
        <table>
          <thead>
            <tr>
              <th>Scheduled</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Rows</th>
              <th style={{ textAlign: 'right' }}>Expected</th>
              <th style={{ textAlign: 'right' }}>Missing</th>
              <th>Missing symbols</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="mono">{e.scheduled_ts_ist}</td>
                <td className={e.status === 'ok' ? 'cell-pos' : e.status === 'partial' ? 'cell-warn' : 'cell-neg'}>{e.status}</td>
                <td style={{ textAlign: 'right' }}>{e.row_count}</td>
                <td style={{ textAlign: 'right' }}>{e.expected_row_count}</td>
                <td style={{ textAlign: 'right' }}>{e.missing_symbol_count}</td>
                <td className="text-2" style={{ maxWidth: 320, whiteSpace: 'normal' }}>{e.missingSymbols.slice(0, 20).join(', ')}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="text-3">No ingestion cycles yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
