/**
 * SessionsCard.tsx — the saved record of research-runner runs for a thread,
 * newest first, collapsed by default so it doesn't crowd the chat. Running =
 * pulsing orange dot; queued (waiting on the memory-aware dispatcher) =
 * static muted dot; failed = static red dot; done = green, no dot.
 */

import { Card } from './Card';
import styles from './ResearchPage.module.css';
import type { Session } from './types';

export function SessionsCard({ sessions }: { sessions: Session[] }) {
  if (!sessions.length) return null;
  return (
    <Card
      cardId="research-sessions"
      defaultOpen={false}
      title="Sessions"
      count={<>{sessions.length} &mdash; the saved record of each run</>}
    >
      {sessions.map((s) => {
        const running = s.status === 'running';
        const queued = s.status === 'queued';
        const failed = s.status === 'failed';
        const dot = running ? (
          <span className={styles.dotOrange} />
        ) : queued ? (
          <span className={styles.dotMuted} />
        ) : failed ? (
          <span className={styles.dotRed} />
        ) : null;
        const color = running
          ? 'var(--orange)'
          : queued
            ? 'var(--text-muted)'
            : failed
              ? 'var(--red)'
              : 'var(--green)';
        const label = running ? 'running…' : queued ? 'queued' : failed ? 'failed' : 'done';
        return (
          <div key={s.id} className={styles.entry}>
            <div className={styles.sessionMeta}>
              <span className={styles.sessionDate}>
                {s.mode === 'deep' ? <>&#128300; </> : null}
                {s.created ?? ''}
              </span>
              <span className={styles.sessionStatus} style={{ color }}>
                {dot}
                {label}
              </span>
              <span className={styles.sessionCount}>{(s.entry_ids ?? []).length} entries sent</span>
            </div>
            {s.report ? <div className={styles.sessionReport}>{s.report}</div> : null}
          </div>
        );
      })}
    </Card>
  );
}
