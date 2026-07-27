import { useState } from 'react';
import { useTerrain } from '../terrain/api';
import { forkConversation, stopConversation, type SessionMeta } from './api';
import { orchestraRows, type OrchestraRow } from './orchestra';
import styles from './Orchestra.module.css';

/**
 * Orchestra — the Observatory's live section: the agents running *right now*
 * and the files each is writing, plus any that have raised a structural
 * "I need you" and are waiting on her. Trunk of the observability arc; S2
 * (this orange-glow), S3 (fork-work), S4 (act-ask gate) render into here.
 *
 * QUIET-UNTIL-ACTIVE, LOUD-WHEN-WAITING (Sunflower): still and calm when
 * nothing runs; the live rows breathe (violet); the *waiting* rows glow orange
 * and float to the top with their question in her face — a request she has to
 * walk past can't be a whisper, or the queue becomes a graveyard (Terra).
 *
 * No new plumbing: running-ness + awaiting_input come from the roster the page
 * already polls (passed as `sessions`), file footprints from the existing
 * terrain payload. Read-only + one control: a two-tap Stop per running row.
 */

const FILES_SHOWN = 6;

export function Orchestra({
  sessions,
  onOpen,
  onChanged,
}: {
  /** The Orchestra-relevant subset of the roster: running OR awaiting input. */
  sessions: SessionMeta[];
  onOpen: (convId: string) => void;
  /** Called after a Stop lands, so the page can refresh the roster promptly. */
  onChanged?: () => void;
}) {
  // Poll terrain live only while something is actually running; a purely
  // awaiting session needs no live polling (its ask isn't moving).
  const live = sessions.some((s) => s.running);
  const { data: terrain } = useTerrain(live, 350);
  const rows = orchestraRows(sessions, terrain);
  const [stopArmed, setStopArmed] = useState<string | null>(null);
  // Per-row fork state: 'forking' while it stages, 'done' once the take-over
  // spinoff is in My Sessions, 'error' on failure.
  const [fork, setFork] = useState<Record<string, 'forking' | 'done' | 'error'>>({});

  const doFork = (id: string) => {
    setFork((f) => ({ ...f, [id]: 'forking' }));
    forkConversation(id)
      .then(() => {
        setFork((f) => ({ ...f, [id]: 'done' }));
        onChanged?.(); // the staged spinoff shows up in My Sessions
      })
      .catch(() => setFork((f) => ({ ...f, [id]: 'error' })));
  };

  // Waiting-on-her floats to the top (a reply is more urgent than watching
  // work happen); the rest are the ones merely running.
  const waiting = rows.filter((r) => r.awaiting);
  const active = rows.filter((r) => !r.awaiting);

  const renderFiles = (row: OrchestraRow) =>
    row.files.length > 0 ? (
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
    ) : null;

  return (
    <section className={styles.orchestra} aria-label="Orchestra — agents running now">
      <div className={styles.head}>
        <h2 className={styles.heading}>Orchestra</h2>
        {waiting.length > 0 ? (
          <span className={styles.waitCount}>
            {waiting.length} waiting on you
          </span>
        ) : active.length > 0 ? (
          <span className={styles.count}>{active.length} running</span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className={styles.idle}>
          <span className={styles.idleDot} aria-hidden="true" />
          Nothing running right now.
        </div>
      ) : (
        <div className={styles.rows}>
          {/* Waiting on her — orange, question in her face, tap to answer. */}
          {waiting.map((row) => (
            <button
              key={row.id}
              type="button"
              className={styles.awaiting}
              onClick={() => onOpen(row.id)}
              title="Answer this session"
            >
              <div className={styles.awaitTop}>
                <span className={styles.awaitDot} aria-hidden="true" />
                <span className={styles.title}>{row.title}</span>
                <span className={styles.answerHint}>Answer →</span>
              </div>
              <div className={styles.question}>{row.awaiting}</div>
            </button>
          ))}

          {/* Running — violet breath, files ticking, two-tap Stop. */}
          {active.map((row) => (
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
              {renderFiles(row)}

              {/* Fork-the-work: offload a bloated long-runner. Only when it has
                  a write surface to hand over. Take-over, not parallel — on
                  success it stages into My Sessions; she stops this one, then
                  opens the fork (no auto-navigate that would run both at once). */}
              {row.fileCount > 0 ? (
                fork[row.id] === 'done' ? (
                  <div className={styles.forkDone}>
                    ✓ Forked into a fresh session — open it in <strong>My sessions</strong>. Stop
                    this one first, so the two don&rsquo;t clobber each other.
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.forkBtn}
                    disabled={fork[row.id] === 'forking'}
                    onClick={() => doFork(row.id)}
                  >
                    {fork[row.id] === 'forking'
                      ? 'Staging a fork…'
                      : fork[row.id] === 'error'
                        ? 'Fork failed — tap to retry'
                        : 'Fork this work into a fresh session'}
                  </button>
                )
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
