import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';

export function DataRecalculateSection() {
  const [job, setJob] = useState<{ status: string; processed: number; total: number; error?: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function start() {
    let jobId: string;
    try {
      ({ jobId } = await api.startRecalculate());
    } catch (e) {
      // 409 -- one's already running (e.g. triggered from another tab, or
      // this tab was reloaded mid-run so its local `job` state reset).
      setJob({ status: 'failed', processed: 0, total: 0, error: e instanceof Error ? e.message : 'Failed to start' });
      return;
    }
    setJob({ status: 'running', processed: 0, total: 0 });
    pollRef.current = setInterval(async () => {
      const j = await api.getRecalculateJob(jobId);
      setJob(j);
      if (j.status === 'done' || j.status === 'failed') {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 500);
  }

  const pct = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  const running = job?.status === 'running';

  return (
    <div className="settings-section">
      <h3>Data &amp; Recalculate</h3>
      <p className="text-2" style={{ fontSize: 12 }}>
        Replays every symbol's full ingested history through the indicator engine from a cold start, using the
        indicator parameters currently saved under Indicator Parameters. Use this after changing a parameter to
        apply it retroactively instead of only to future bars.
      </p>
      <div className="settings-actions">
        <button className="chip-toggle chip-toggle-active" onClick={start} disabled={running}>
          {running ? 'Recalculating…' : 'Recalculate All'}
        </button>
        {job && (
          <span className="text-2 mono" style={{ fontSize: 11.5 }}>
            {job.status === 'failed' ? `✗ ${job.error}` : `${job.status} — ${job.processed}/${job.total}`}
          </span>
        )}
      </div>
      {job && job.total > 0 && (
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
