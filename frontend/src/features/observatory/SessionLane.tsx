import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  approveConversation,
  denyConversation,
  forkConversation,
  stopConversation,
  streamSend,
  type Lane,
  type SessionMeta,
} from './api';
import { orchestraRows, type OrchestraRow } from './orchestra';
import { lastActivityLabel, sessionStatus } from './sessionStatus';
import { formatSessionSpend } from './turnStats';
import type { TerrainData } from '../terrain/api';
import styles from './Orchestra.module.css';

/**
 * SessionLane — one of the Observatory's two rooms, and the only place a
 * session card is drawn.
 *
 * WHY THIS EXISTS (her 07-27 call). The page used to render every session
 * twice: once in "My sessions" (the whole roster) and again in "Orchestra" (a
 * `running || awaiting` filter over that same roster), in two different visual
 * languages. So there was no way to say where anything *lived* — Orchestra was
 * a view, not a place. Now a session BELONGS to a lane, exclusively, and stays
 * put whether or not it happens to be working.
 *
 * The move that made it collapse: LIVE IS A STATE THE CARD WEARS, not a
 * section it migrates into. One card renders idle, breathing, waiting, and
 * blocked — so a Personal session shows the files it's touching exactly like
 * an Orchestra one, which the old split couldn't do at all.
 *
 * QUIET-UNTIL-ACTIVE, LOUD-WHEN-WAITING (Sunflower): a resting lane is still;
 * working cards breathe violet; cards that need her glow orange and float to
 * the top with the ask in her face — a request she has to walk past can't be a
 * whisper, or the queue becomes a graveyard (Terra).
 *
 * Terrain is polled ONCE by the page and passed in, not fetched per lane —
 * two lanes must not mean two pollers hitting the same endpoint.
 */

/** Files listed before the expander takes over. Six is about what fits on a
 * phone without the card swallowing the lane below it — and each row is a 40px
 * tap target now (they open the file), so six is taller than it used to be. */
const FILES_SHOWN = 6;

/** The card's housekeeping line: "4m ago · 18.2k tokens · $4.21". Built from
 * whichever halves exist, so a fresh session shows nothing rather than a row
 * of blanks and separators. Recomputed per render, which is what keeps the
 * "4m ago" honest as the roster polls. */
function cardMeta(meta: SessionMeta): string {
  return [lastActivityLabel(meta.last_at), meta.tokens ? formatSessionSpend(meta.tokens) : null]
    .filter(Boolean)
    .join(' · ');
}

export function SessionLane({
  lane,
  heading,
  blurb,
  sessions,
  terrain,
  opened,
  onOpen,
  onNew,
  onRename,
  onChanged,
  onClose,
}: {
  lane: Lane;
  heading: string;
  /** One line under the heading saying what this room IS — the lanes differ in
   * whether they stop and ask, which is invisible unless it's written down. */
  blurb: string;
  /** Every session assigned to this lane, already sorted by the page. */
  sessions: SessionMeta[];
  terrain: TerrainData | undefined;
  /** convId -> last-opened ISO stamp, for the unread accent. */
  opened: Record<string, string>;
  onOpen: (convId: string) => void;
  onNew: (lane: Lane) => void;
  onRename: (session: SessionMeta) => void;
  onChanged?: () => void;
  onClose: (convId: string) => void;
}) {
  const navigate = useNavigate();
  const rows = orchestraRows(sessions, terrain);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  // Tap a file to read it (her 07-27 ask). On desktop this lane lives in the
  // split's LEFT pane and the router owns the right one, so navigating to
  // /code opens the file beside the session that's writing it, without
  // disturbing the lane. On mobile there's no split and it's a normal page
  // move — back returns here.
  const openFile = (repo: string, path: string) => {
    void navigate({ to: '/code', search: { repo, path } });
  };

  const [stopArmed, setStopArmed] = useState<string | null>(null);
  const [closeArmed, setCloseArmed] = useState<string | null>(null);
  // Which cards have their full file list open. Deliberately NOT persisted:
  // this is a live view of work in flight, not a preference.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Per-row fork state: 'forking' while it stages, 'done' once the take-over
  // spinoff exists, 'error' on failure.
  const [fork, setFork] = useState<Record<string, 'forking' | 'done' | 'error'>>({});
  // Per-row approval UI state: the Once/Always toggle (default Once — the
  // safest per Terra) and whether a decision is mid-flight.
  const [sticky, setSticky] = useState<Record<string, boolean>>({});
  const [deciding, setDeciding] = useState<Record<string, boolean>>({});

  const doFork = (id: string) => {
    setFork((f) => ({ ...f, [id]: 'forking' }));
    forkConversation(id)
      .then(() => {
        setFork((f) => ({ ...f, [id]: 'done' }));
        onChanged?.();
      })
      .catch(() => setFork((f) => ({ ...f, [id]: 'error' })));
  };

  // Resume the blocked turn after she decides: her tap + this send IS the retry
  // (same transport as request_input). Fire-and-forget — the turn runs detached
  // server-side; the roster poll shows it running again.
  // The resume text is what the AGENT sees (its retry cue). The optional
  // `decision` is what SHE sees: it makes the server log a "✓ Approved: <cmd>"
  // line in the transcript instead of a blank off-record gap. Both approve and
  // deny carry the exact command the routes hand back.
  const resume = (
    id: string,
    text: string,
    decision?: { kind: 'approve' | 'deny'; command: string },
  ) => {
    void streamSend(id, text, { record: false, decision }, () => {}).catch(() => {});
    onChanged?.();
  };

  const doApprove = (id: string) => {
    setDeciding((d) => ({ ...d, [id]: true }));
    approveConversation(id, sticky[id] === true)
      .then((res) =>
        resume(id, 'Approved — go ahead and retry that exact command now.', {
          kind: 'approve',
          command: res.command,
        }),
      )
      .catch(() => setDeciding((d) => ({ ...d, [id]: false })));
  };

  const doDeny = (id: string) => {
    setDeciding((d) => ({ ...d, [id]: true }));
    denyConversation(id)
      .then((res) =>
        resume(id, "I've denied that command — don't run it. Find another way, or stop and tell me why.", {
          kind: 'deny',
          command: res.command,
        }),
      )
      .catch(() => setDeciding((d) => ({ ...d, [id]: false })));
  };

  // Urgency order, top to bottom: a gated command needing her OK (nothing moves
  // until she taps) > waiting-on-her (a reply) > everything else, in lane order.
  const approvals = rows.filter((r) => r.pendingApproval);
  const waiting = rows.filter((r) => !r.pendingApproval && r.awaiting);
  const rest = rows.filter((r) => !r.pendingApproval && !r.awaiting);

  const needing = approvals.length + waiting.length;
  const running = rest.filter((r) => r.running).length;

  const renderFiles = (row: OrchestraRow) => {
    if (row.files.length === 0) return null;
    const open = expanded[row.id] === true;
    const shown = open ? row.files : row.files.slice(0, FILES_SHOWN);
    const hidden = row.files.length - shown.length;
    return (
      <>
        <ul className={[styles.files, open ? styles.filesOpen : ''].filter(Boolean).join(' ')}>
          {shown.map((f) => (
            <li key={`${f.repo}:${f.path}`}>
              <button
                type="button"
                className={styles.file}
                title={`Read ${f.repo}/${f.path}`}
                onClick={() => openFile(f.repo, f.path)}
              >
                <span className={styles.filePath}>{f.path}</span>
                {f.creates > 0 ? <span className={styles.newBadge}>new</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {hidden > 0 || open ? (
          <button
            type="button"
            className={styles.showAllBtn}
            aria-expanded={open}
            onClick={() => setExpanded((e) => ({ ...e, [row.id]: !open }))}
          >
            {open ? 'Show fewer' : `Show all ${row.files.length} files`}
          </button>
        ) : null}
      </>
    );
  };

  return (
    <section className={styles.orchestra} aria-label={heading}>
      <div className={styles.head}>
        <h2 className={styles.heading}>{heading}</h2>
        {needing > 0 ? (
          <span className={styles.waitCount}>
            {needing} need{needing === 1 ? 's' : ''} you
          </span>
        ) : running > 0 ? (
          <span className={styles.count}>{running} running</span>
        ) : null}
        <button
          type="button"
          className={styles.newInLane}
          onClick={() => onNew(lane)}
          title={`New ${heading} session`}
          aria-label={`New ${heading} session`}
        >
          +
        </button>
      </div>
      <p className={styles.blurb}>{blurb}</p>

      {rows.length === 0 ? (
        <div className={styles.idle}>
          <span className={styles.idleDot} aria-hidden="true" />
          Nothing here yet — tap + to start one.
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
                <div className={styles.scopeToggle} role="group" aria-label="Approval scope">
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

          {/* Everything else: the lane's own cards. Same object whether it's
              breathing or resting — only the dot, the file list and the
              working-only controls (Stop, Fork) change. */}
          {rest.map((row) => {
            const meta = byId.get(row.id);
            if (!meta) return null;
            const status = sessionStatus(meta, opened[row.id]);
            return (
              <div
                key={row.id}
                className={[
                  styles.card,
                  row.running ? styles.cardLive : '',
                  status === 'ready' ? styles.cardUnread : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className={styles.cardTop}>
                  <button
                    type="button"
                    className={styles.open}
                    onClick={() => onOpen(row.id)}
                    title="Open this session"
                  >
                    {row.running ? (
                      <span className={styles.liveDot} aria-hidden="true" />
                    ) : status === 'ready' ? (
                      <span className={styles.readyDot} aria-hidden="true" />
                    ) : (
                      <span className={styles.restDot} aria-hidden="true" />
                    )}
                    <span className={styles.title}>{row.title}</span>
                    {meta.pinned ? <span className={styles.badge}>pinned</span> : null}
                    {meta.draft ? <span className={styles.badge}>staged</span> : null}
                    {row.running ? (
                      <span className={styles.fileCount}>
                        {row.fileCount === 0
                          ? 'starting…'
                          : `${row.fileCount} ${row.fileCount === 1 ? 'file' : 'files'}`}
                      </span>
                    ) : null}
                  </button>
                  {row.running ? (
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
                            /* a failed stop just leaves it running — the poll re-syncs */
                          });
                      }}
                    >
                      {stopArmed === row.id ? 'Sure?' : 'Stop'}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={styles.editBtn}
                        aria-label={`Rename ${row.title}`}
                        title="Session settings"
                        onClick={() => onRename(meta)}
                      >
                        ✎
                      </button>
                      {!meta.pinned ? (
                        <button
                          type="button"
                          className={[styles.closeBtn, closeArmed === row.id ? styles.closeArmed : '']
                            .filter(Boolean)
                            .join(' ')}
                          aria-label={`Close ${row.title}`}
                          title="Close session"
                          onClick={() => {
                            if (closeArmed !== row.id) {
                              setCloseArmed(row.id);
                              return;
                            }
                            setCloseArmed(null);
                            onClose(row.id);
                          }}
                        >
                          {closeArmed === row.id ? 'Sure?' : '×'}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>

                {/* What it's working on, then which files. The summary was
                    already on the roster payload — the live card just never
                    showed it, so a working session said WHICH files but never
                    WHAT FOR. */}
                {row.summary ? <div className={styles.summary}>{row.summary}</div> : null}
                {/* One quiet line of housekeeping: when it last did anything
                    (last_at moves on both her send and the turn's finish), and
                    what it has spent. Either half can be missing — a session
                    with no finished turn has no spend, a never-run one has no
                    stamp — so they're joined only where both exist and the
                    line disappears entirely when neither does. */}
                {cardMeta(meta) ? <div className={styles.cardMeta}>{cardMeta(meta)}</div> : null}
                {meta.journal === false ? <div className={styles.note}>not journaled</div> : null}
                {renderFiles(row)}

                {/* Fork-the-work: offload a bloated long-runner. Only offered
                    while it's actually working and has a surface to hand over.
                    Take-over, not parallel — she stops this one, then opens the
                    fork (no auto-navigate that would run both at once). */}
                {row.running && row.fileCount > 0 ? (
                  fork[row.id] === 'done' ? (
                    <div className={styles.forkDone}>
                      ✓ Forked into a fresh session. Stop this one first, so the two don&rsquo;t
                      clobber each other.
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
            );
          })}
        </div>
      )}
    </section>
  );
}
