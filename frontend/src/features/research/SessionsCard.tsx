/**
 * SessionsCard.tsx — the saved record of research-runner runs for a thread,
 * newest first, collapsed by default so it doesn't crowd the chat. Running =
 * pulsing orange dot; queued (waiting on the memory-aware dispatcher) =
 * static muted dot; failed = static red dot; done = green, no dot.
 *
 * Runs are headless by design (her call, 2026-07-14) — replies just post
 * into the thread. A running session gets a "follow live" button that
 * attaches its tmux session for watching/steering: on mobile it becomes the
 * active Chat session; on desktop it flips the docked terminal pane via the
 * 'exo:set-session' window event (SplitLayout listens).
 */

import { useNavigate } from '@tanstack/react-router';
import { Card } from './Card';
import { useSessionsContext } from '../../shell/SessionsContext';
import { useMediaQuery, DESKTOP_QUERY } from '../../shell/useMediaQuery';
import styles from './ResearchPage.module.css';
import type { Session } from './types';

/** The tmux session a run lives in. Workers mirror the dispatcher's
 * worker_tmux_name (rw-<id>, non-alphanumerics collapsed, 40 chars); the
 * regular/deep runners are shared named sessions. */
function tmuxNameFor(s: Session): string {
  if (s.worker) return `rw-${s.id}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40);
  return s.mode === 'deep' ? 'research-deep' : 'research-runner';
}

export function SessionsCard({ sessions }: { sessions: Session[] }) {
  const shellSessions = useSessionsContext();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const navigate = useNavigate();

  if (!sessions.length) return null;

  function follow(s: Session) {
    const name = tmuxNameFor(s);
    if (isDesktop) {
      window.dispatchEvent(new CustomEvent('exo:set-session', { detail: name }));
    } else {
      shellSessions.setActive(name);
      void navigate({ to: '/chat' });
    }
  }

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
              {running ? (
                <button type="button" className={styles.chip} onClick={() => follow(s)}>
                  &#9095; follow live
                </button>
              ) : null}
            </div>
            {s.report ? <div className={styles.sessionReport}>{s.report}</div> : null}
          </div>
        );
      })}
    </Card>
  );
}
