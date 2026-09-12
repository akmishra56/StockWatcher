import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../../hooks/useLiveSnapshot';
import { api } from '../../api';
import { colorForFilter } from '../../filterColor';

/**
 * One membership-log line: '<ts> + CIPLA added to Oversold', with the
 * filter name colored to match its tab/chip color everywhere else
 * (filterColor.ts). Falls back to the raw filter id if the filter was
 * since deleted (filterNames won't have an entry for it).
 */
function LogLine({ entry, filterNames }: { entry: LogEntry; filterNames: Record<string, string> }) {
  const filterName = filterNames[entry.filter_id] ?? entry.filter_id;
  return (
    <span>
      <span className="mono text-3">{entry.ts_ist}</span>{' '}
      <span className={entry.action === 'added' ? 'cell-pos' : 'cell-neg'}>{entry.action === 'added' ? '+' : '−'}</span>{' '}
      <span className="sym">{entry.symbol}</span> <span className="text-2">{entry.action === 'added' ? 'added to' : 'removed from'}</span>{' '}
      <span style={{ color: colorForFilter(entry.filter_id), fontWeight: 600 }}>{filterName}</span>
    </span>
  );
}

/** Docked at the bottom of the table (not a left-panel split) so it never competes with the data grid for width. */
export function MonitorLogPanel({ entries }: { entries: LogEntry[] }) {
  const [minimized, setMinimized] = useState(false);
  const [flashUntil, setFlashUntil] = useState(0);
  const [filterNames, setFilterNames] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(entries.length);

  // Log entries only carry filter_id -- resolved to a name here (falling
  // back to the id itself if a filter was since deleted) so each line can
  // read "added to Oversold" instead of a raw uuid. Refetched whenever a
  // new entry arrives in case it references a filter created since mount.
  useEffect(() => {
    api.getFilters().then((fs) => {
      setFilterNames(Object.fromEntries(fs.map((f: { id: string; name: string }) => [f.id, f.name])));
    }).catch(() => {});
  }, [entries.length]);

  useEffect(() => {
    if (entries.length > prevCount.current) {
      setFlashUntil(Date.now() + 900);
      const t = setTimeout(() => setFlashUntil(0), 900);
      if (!minimized && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      prevCount.current = entries.length;
      return () => clearTimeout(t);
    }
    prevCount.current = entries.length;
  }, [entries.length, minimized]);

  const flashing = flashUntil > Date.now();
  const latest = entries[entries.length - 1];

  return (
    <div className={`monitor-log ${minimized ? 'monitor-log-min' : ''} ${flashing ? 'monitor-log-flash' : ''}`}>
      <div className="monitor-log-header">
        <span className="text-2" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>
          MEMBERSHIP LOG {entries.length > 0 && <span className="chip-sm">{entries.length}</span>}
        </span>
        <button className="chip-toggle" onClick={() => setMinimized((m) => !m)}>
          {minimized ? '▲ expand' : '▼ minimize'}
        </button>
      </div>
      {minimized ? (
        <div className="loglist-min">
          {latest ? <LogLine entry={latest} filterNames={filterNames} /> : <span className="text-3">No membership changes yet</span>}
        </div>
      ) : (
        <div className="loglist" ref={listRef}>
          {entries.length === 0 && <div className="text-3">No membership changes yet</div>}
          {entries.map((e, i) => (
            <div key={i} className={i === entries.length - 1 && flashing ? 'logrow-flash' : ''}>
              <LogLine entry={e} filterNames={filterNames} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
