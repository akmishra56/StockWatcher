import { useEffect, useState } from 'react';
import { api, type Settings } from '../../api';

export function IndicatorParamsSection() {
  const [params, setParams] = useState<Settings['indicators'] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => setParams(s.indicators));
  }, []);

  if (!params) return <div className="text-3">Loading…</div>;

  function set(indicator: string, field: string, value: number) {
    setParams((p) => (p ? { ...p, [indicator]: { ...p[indicator], [field]: value } } : p));
  }

  async function save() {
    if (!params) return;
    setStatus('Saving…');
    await api.putSettings({ indicators: params });
    setStatus('Saved — takes effect on the next ingest cycle. Use Data & Recalculate to apply retroactively.');
  }

  return (
    <div className="settings-section">
      <h3>Indicator Parameters</h3>
      <p className="text-2" style={{ fontSize: 12 }}>
        Changing a value here only affects <em>future</em> cycles. To recompute existing history with the new
        parameters, save first, then run Recalculate All under Data &amp; Recalculate.
      </p>

      <div className="params-grid">
        <ParamGroup title="Bollinger Bands">
          <NumField label="Period" value={params.bollinger.period} onChange={(v) => set('bollinger', 'period', v)} />
          <NumField label="k (std devs)" value={params.bollinger.k} step={0.1} onChange={(v) => set('bollinger', 'k', v)} />
        </ParamGroup>
        <ParamGroup title="RSI">
          <NumField label="Period" value={params.rsi.period} onChange={(v) => set('rsi', 'period', v)} />
        </ParamGroup>
        <ParamGroup title="MACD">
          <NumField label="Fast EMA" value={params.macd.fast} onChange={(v) => set('macd', 'fast', v)} />
          <NumField label="Slow EMA" value={params.macd.slow} onChange={(v) => set('macd', 'slow', v)} />
          <NumField label="Signal EMA" value={params.macd.signal} onChange={(v) => set('macd', 'signal', v)} />
        </ParamGroup>
        <ParamGroup title="ATR">
          <NumField label="Period" value={params.atr.period} onChange={(v) => set('atr', 'period', v)} />
        </ParamGroup>
        <ParamGroup title="EMA">
          <NumField label="Short period" value={params.ema.short} onChange={(v) => set('ema', 'short', v)} />
          <NumField label="Long period" value={params.ema.long} onChange={(v) => set('ema', 'long', v)} />
        </ParamGroup>
        <ParamGroup title="Supertrend">
          <NumField label="ATR period" value={params.supertrend.atrPeriod} onChange={(v) => set('supertrend', 'atrPeriod', v)} />
          <NumField label="Multiplier" value={params.supertrend.multiplier} step={0.1} onChange={(v) => set('supertrend', 'multiplier', v)} />
        </ParamGroup>
      </div>

      <div className="settings-actions">
        <button className="chip-toggle chip-toggle-active" onClick={save}>Save</button>
        {status && <span className="text-2" style={{ fontSize: 11.5 }}>{status}</span>}
      </div>
    </div>
  );
}

function ParamGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="param-group">
      <div className="param-group-title">{title}</div>
      <div className="param-group-fields">{children}</div>
    </div>
  );
}

function NumField({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span className="text-2" style={{ fontSize: 11 }}>{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
