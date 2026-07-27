import { useState } from 'react';
import { useTerrain } from '../terrain/api';
import {
  approveConversation,
  denyConversation,
  forkConversation,
  stopConversation,
  streamSend,
  type SessionMeta,
} from './api';
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

  // Per-row approval UI state: the Once/Always toggle (default Once — the
  // safest per Terra) and whether a decision is mid-flight.
  const [sticky, setSticky] = useState<Record<string, boolean>>({});
  const [deciding, setDeciding] = useState<Record<string, boolean>>({});

  // Resume the blocked turn after she decides: her tap + this send IS the retry
  // (same transport as request_input). Fire-and-forget — the turn runs detached
  // server-side; the roster poll shows it running again. onChanged refreshes now
  // so the card clears the moment the decision lands.
  const resume = (id: string, text: string) => {
    void streamSend(id, text, { record: false }, () => {}).catch(() => {});
    onChanged?.();
  };

  const doApprove = (id: string) => {
    setDeciding((d) => ({ ...d, [id]: true }));
    approveConversation(id, sticky[id] === true)
      .then(() => resume(id, 'Approved — go ahead and retry that exact command now.'))
      .catch(() => setDeciding((d) => ({ ...d, [id]: false })));
  };

  const doDeny = (id: string) => {
    setDeciding((d) => ({ ...d, [id]: true }));
    denyConversation(id)
      .then(() =>
        resume(id, "I've denied that command — don't run it. Find another way, or stop and tell me why."),
      )
      .catch(() => setDeciding((d) => ({ ...d, [id]: false })));
  };

  // Urgency order, top to bottom: a gated command needing her OK (nothing moves
  // until she taps) > waiting-on-her (a reply) > merely running.
  const approvals = rows.filter((r) => r.pendingApproval);
  const waiting = rows.filter((r) => !r.pendingApproval && r.awaiting);
  const active = rows.filter((r) => !r.pendingApproval && !r.awaiting);

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
        {approvals.length > 0 ? (
          <span className={styles.waitCount}>
            {approvals.length} need{approvals.length === 1 ? 's' : ''} your OK
          </span>
        ) : waiting.length > 0 ? (
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
          {/* Needs her OK — a gated command the act-ask gate stopped. The exact
              command in her face, an Approve (Once/Always) and a Deny. */}
          {approvals.map((row) => (
            <div key={row.id} className={styles.approval}>
              <div className={styles.awaitTop}>
                <span className={styles.awaitDot} aria-hidden="true" />
                <span className={styles.title}>{row.title}</span>
                <button
                  type="button"
                  className={styles.openLink}
                  onClick={() => onOpen(row.id)}
                  title="Open this session"
                >
                  open →
                </button>
              </div>
              <div className={styles.approvalLabel}>wants to run</div>
              <code className={styles.command}>{row.pendingApproval?.command}</code>
              <div className={styles.approvalActions}>
                <div
                  className={styles.scopeToggle}
                  role="group"
                  aria-label="Approval scope"
                >
                  <button
                    type="button"
                    className={[styles.scopeBtn, sticky[row.id] !== true ? styles.scopeOn : '']
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={sticky[row.id] !== true}
                    onClick={() => setSticky((s) => ({ ...s, [row.id]: false }))}
                    title="Allow just this once"
                  >
                    Once
                  </button>
                  <button
                    type="button"
                    className={[styles.scopeBtn, sticky[row.id] === true ? styles.scopeOn : '']
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={sticky[row.id] === true}
                    onClick={() => setSticky((s) => ({ ...s, [row.id]: true }))}
                    title="Allow this command for the rest of the session"
                  >
                    Always
                  </button>
                </div>
                <div className={styles.decideBtns}>
                  <button
                    type="button"
                    className={styles.denyBtn}
                    disabled={deciding[row.id]}
                    onClick={() => doDeny(row.id)}
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    className={styles.approveBtn}
                    disabled={deciding[row.id]}
                    onClick={() => doApprove(row.id)}
                  >
                    {deciding[row.id]
                      ? 'Sending…'
                      : sticky[row.id] === true
                        ? 'Approve · always'
                        : 'Approve · once'}
                  </button>
                </div>
              </div>
            </div>
          ))}

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
