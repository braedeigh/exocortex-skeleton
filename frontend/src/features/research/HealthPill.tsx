/**
 * HealthPill.tsx — a heartbeat, not a dashboard (Sunflower's spec). Renders
 * nothing at all when no research session is live. While live, a small teal
 * (`--ongoing`) pill shows how many sessions are actively running and, if
 * the box is memory-bound, that others are waiting for room — never a raw
 * RAM number, never bytes. Tapping it opens a small popover listing the
 * live/queued sessions (nice-to-have, kept cheap).
 *
 * Data: useResearch() (session counts + topic names, same cache ResearchPage
 * already subscribes to — no extra fetch) and useHealth() (GET
 * /api/research/health, polled every 15s, for the memory-bound signal).
 */
import { useRef, useState } from 'react';
import { useDismiss } from '../../shell/useDismiss';
import { topicsById } from './helpers';
import { useHealth, useResearch } from './useResearchData';
import type { Session } from './types';
import styles from './HealthPill.module.css';

export interface HealthPillProps {
  /** Whether any research session is currently running or queued — the
   * render gate; the pill only exists while something's actually going. */
  inFlight: boolean;
}

function sessionLabel(s: Session, byId: Record<string, { name: string }>): string {
  const topics = (s.topics ?? []).map((t) => byId[t]?.name ?? t);
  const what = topics.length ? topics.join(', ') : s.mode ? `${s.mode} session` : 'session';
  return `${s.id} · ${what}`;
}

export function HealthPill({ inFlight }: HealthPillProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  // Both queries only matter while something's live; skip the health poll
  // entirely when the pill wouldn't render anyway.
  const researchQuery = useResearch();
  const healthQuery = useHealth();

  if (!inFlight) return null;

  const sessions = researchQuery.data?.sessions ?? [];
  const byId = topicsById(researchQuery.data?.topics ?? []);
  const running = sessions.filter((s) => s.status === 'running');
  const queued = sessions.filter((s) => s.status === 'queued');
  const slots = healthQuery.data?.slots ?? null;
  const memoryBound = slots !== null && slots < 1 && queued.length > 0;

  const label = memoryBound
    ? `${running.length} running · ${queued.length} waiting for room`
    : queued.length
      ? `◐ ${running.length} running · ${queued.length} more queued`
      : `◐ ${running.length} running`;
  // TODO(Step D): once token counts land, slot a "~Nk tokens · Nm" clause in
  // here alongside the run/queue counts (rounded magnitudes, never raw bytes).

  const live = [...running, ...queued];

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.pill}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Research is working — tap for details"
      >
        {label}
      </button>
      {open ? (
        <div className={styles.popover}>
          {live.length ? (
            <ul className={styles.list}>
              {live.map((s) => (
                <li key={s.id} className={styles.item}>
                  <span className={s.status === 'running' ? styles.dotRunning : styles.dotQueued} />
                  {sessionLabel(s, byId)}
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.empty}>Nothing live right now.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
