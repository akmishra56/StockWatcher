import { useEffect, useState } from 'react';
import { api, type Settings } from '../../api';

export function ColorRulesSection() {
  const [rules, setRules] = useState<Settings['colorRules'] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => setRules(s.colorRules));
  }, []);

  if (!rules) return <div className="text-3">Loading…</div>;

  function set(rule: string, field: string, value: any) {
    setRules((r) => (r ? { ...r, [rule]: { ...r[rule], [field]: value } } : r));
  }

  async function save() {
    setStatus('Saving…');
    await api.putSettings({ colorRules: rules! });
    setStatus('Saved — applies immediately to the live table and filter conditions.');
  }

  return (
    <div className="settings-section">
      <h3>Color Rules</h3>
      <p className="text-2" style={{ fontSize: 12 }}>
        Thresholds here also drive the <code>rsi.isOversold</code> / <code>rsi.isOverbought</code> filter conditions.
      </p>

      <div className="params-grid">
        <div className="param-group">
          <div className="param-group-title">RSI Oversold</div>
          <div className="param-group-fields">
            <label className="field">
              <span className="text-2" style={{ fontSize: 11 }}>Threshold (below)</span>
              <input type="number" value={rules.rsiOversold.threshold} onChange={(e) => set('rsiOversold', 'threshold', Number(e.target.value))} />
            </label>
            <ColorField value={rules.rsiOversold.bg} onChange={(v) => set('rsiOversold', 'bg', v)} label="Color" />
            <ToggleField checked={rules.rsiOversold.enabled} onChange={(v) => set('rsiOversold', 'enabled', v)} label="Enabled" />
          </div>
        </div>
        <div className="param-group">
          <div className="param-group-title">RSI Overbought</div>
          <div className="param-group-fields">
            <label className="field">
              <span className="text-2" style={{ fontSize: 11 }}>Threshold (above)</span>
              <input type="number" value={rules.rsiOverbought.threshold} onChange={(e) => set('rsiOverbought', 'threshold', Number(e.target.value))} />
            </label>
            <ColorField value={rules.rsiOverbought.bg} onChange={(v) => set('rsiOverbought', 'bg', v)} label="Color" />
            <ToggleField checked={rules.rsiOverbought.enabled} onChange={(v) => set('rsiOverbought', 'enabled', v)} label="Enabled" />
          </div>
        </div>
        <div className="param-group">
          <div className="param-group-title">Price Change Alert</div>
          <div className="param-group-fields">
            <label className="field">
              <span className="text-2" style={{ fontSize: 11 }}>Threshold (%)</span>
              <input type="number" step={0.1} value={rules.priceChangeAlert.threshold} onChange={(e) => set('priceChangeAlert', 'threshold', Number(e.target.value))} />
            </label>
            <ColorField value={rules.priceChangeAlert.posBg} onChange={(v) => set('priceChangeAlert', 'posBg', v)} label="Positive color" />
            <ColorField value={rules.priceChangeAlert.negBg} onChange={(v) => set('priceChangeAlert', 'negBg', v)} label="Negative color" />
            <ToggleField checked={rules.priceChangeAlert.enabled} onChange={(v) => set('priceChangeAlert', 'enabled', v)} label="Enabled" />
          </div>
        </div>
        <div className="param-group">
          <div className="param-group-title">Bollinger Cross</div>
          <div className="param-group-fields">
            <ToggleField checked={rules.bollingerCross.enabled} onChange={(v) => set('bollingerCross', 'enabled', v)} label="Enabled" />
          </div>
        </div>
        <div className="param-group">
          <div className="param-group-title">Supertrend Direction</div>
          <div className="param-group-fields">
            <ToggleField checked={rules.supertrendDirection.enabled} onChange={(v) => set('supertrendDirection', 'enabled', v)} label="Enabled" />
          </div>
        </div>
      </div>

      <div className="settings-actions">
        <button className="chip-toggle chip-toggle-active" onClick={save}>Save</button>
        {status && <span className="text-2" style={{ fontSize: 11.5 }}>{status}</span>}
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="text-2" style={{ fontSize: 11 }}>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ height: 30, padding: 2 }} />
    </label>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="streaming-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
      <span className="text-2" style={{ fontSize: 11 }}>{label}</span>
    </label>
  );
}
