import { useState } from 'react';
import { useTerrain } from '../terrain/api';
import { stopConversation, type SessionMeta } from './api';
import { orchestraRows } from './orchestra';
import styles from './Orchestra.module.css';

/**
 * Orchestra — the Observatory's live section: the agents running *right now*
 * and the files each is writing. Trunk of the observability arc (S1); S2
 * (orange-glow), S3 (fork-work), S4 (act-ask gate) all render into here later.
 *
 * QUIET-UNTIL-ACTIVE (Sunflower's cut): still and calm when nothing runs; only
 * the live rows carry motion (a soft breathing dot), so movement on this
 * surface always means real work is happening this moment.
 *
 * No new plumbing: running-ness comes from the roster the page already polls
 * (passed down as `runningSessions`), the file footprints from the existing
 * terrain payload — `useTerrain(live)` self-polls every ~5s while anything runs
 * and the server guarantees a session-attributed file survives the file cap, so
 * a running agent's files are never trimmed away here.
 *
 * READ-ONLY watching surface, with one exception the arc allows: a two-tap Stop
 * per row (the existing per-session stop door). Observability before autonomy —
 * nothing here auto-runs.
 */

const FILES_SHOWN = 6;

export function Orchestra({
  runningSessions,
  onOpen,
  onChanged,
}: {
  runningSessions: SessionMeta[];
  onOpen: (convId: string) => void;
  /** Called after a Stop lands, so the page can refresh the roster promptly. */
  onChanged?: () => void;
}) {
  // Only poll terrain live while something is actually running — idle Observatory
  // makes no requests beyond the one mount fetch.
  const live = runningSessions.length > 0;
  const { data: terrain } = useTerrain(live, 350);
  const rows = orchestraRows(runningSessions, terrain);
  const [stopArmed, setStopArmed] = useState<string | null>(null);

  return (
    <section className={styles.orchestra} aria-label="Orchestra — agents running now">
      <div className={styles.head}>
        <h2 className={styles.heading}>Orchestra</h2>
        {rows.length > 0 ? <span className={styles.count}>{rows.length} running</span> : null}
      </div>

      {rows.length === 0 ? (
        <div className={styles.idle}>
          <span className={styles.idleDot} aria-hidden="true" />
          Nothing running right now.
        </div>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) => (
            <div key={row.id} className={styles.card}>
              <div className={styles.cardTop}>
                <button
                  type="button"
                  className={styles.open}
                  onClick={() => onOpen(row.id)}
                  title="Open this session"
                >
                  <span className={styles.liveDot} aria-hidden="true" />
                  <span className={styles.title}>{row.title}</span>
                  <span className={styles.fileCount}>
                    {row.fileCount === 0
                      ? 'starting…'
                      : `${row.fileCount} ${row.fileCount === 1 ? 'file' : 'files'}`}
                  </span>
                </button>
                <button
                  type="button"
                  className={[styles.stopBtn, stopArmed === row.id ? styles.stopArmed : '']
                    .filter(Boolean)
                    .join(' ')}
                  aria-label={`Stop ${row.title}`}
                  title="Stop this agent"
                  onClick={() => {
                    if (stopArmed !== row.id) {
                      setStopArmed(row.id);
                      return;
                    }
                    setStopArmed(null);
                    stopConversation(row.id)
                      .then(() => onChanged?.())
                      .catch(() => {
                        /* a failed stop just leaves it running — the roster poll re-syncs */
                      });
                  }}
                >
                  {stopArmed === row.id ? 'Sure?' : 'Stop'}
                </button>
              </div>

              {row.files.length > 0 ? (
                <ul className={styles.files}>
                  {row.files.slice(0, FILES_SHOWN).map((f) => (
                    <li key={`${f.repo}:${f.path}`} className={styles.file}>
                      <span className={styles.filePath}>{f.path}</span>
                      {f.creates > 0 ? <span className={styles.newBadge}>new</span> : null}
                    </li>
                  ))}
                  {row.files.length > FILES_SHOWN ? (
                    <li className={styles.fileMore}>+{row.files.length - FILES_SHOWN} more</li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className={styles.laterNote}>
        System agents (triage, research, crons) — <span className={styles.laterEm}>coming later</span>
      </div>
    </section>
  );
}
