import { useState } from 'react';
import { IndicatorParamsSection } from './IndicatorParamsSection';
import { ColorRulesSection } from './ColorRulesSection';
import { DataRecalculateSection } from './DataRecalculateSection';
import { MonitorLogSection } from './MonitorLogSection';
import { AutomationSchedulerSection } from './AutomationSchedulerSection';
import { ClassificationSection } from './ClassificationSection';

const SECTIONS = [
  { key: 'indicators', label: 'Indicator Parameters' },
  { key: 'colors', label: 'Color Rules' },
  { key: 'data', label: 'Data & Recalculate' },
  { key: 'monitor', label: 'Monitor Log' },
  { key: 'automation', label: 'Automation & Scheduler' },
  { key: 'classification', label: 'Index Classification' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

export function SettingsTab({ onSchedulerChanged }: { onSchedulerChanged: () => void }) {
  const [active, setActive] = useState<SectionKey>('indicators');

  return (
    <div className="settings-tab">
      <div className="settings-nav">
        {SECTIONS.map((s) => (
          <button key={s.key} className={`settings-nav-item ${active === s.key ? 'settings-nav-item-active' : ''}`} onClick={() => setActive(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="settings-panel">
        {active === 'indicators' && <IndicatorParamsSection />}
        {active === 'colors' && <ColorRulesSection />}
        {active === 'data' && <DataRecalculateSection />}
        {active === 'monitor' && <MonitorLogSection />}
        {active === 'automation' && <AutomationSchedulerSection onSchedulerChanged={onSchedulerChanged} />}
        {active === 'classification' && <ClassificationSection />}
      </div>
    </div>
  );
}
