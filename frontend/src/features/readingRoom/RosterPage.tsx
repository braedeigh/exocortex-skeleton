import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  closeConversation,
  createSession,
  getSessions,
  updateConversation,
  type SessionMeta,
} from './api';
import { sessionStatus } from './sessionStatus';
import { isUnread, openedMap } from './openedStore';
import { SessionDialog } from './SessionDialog';
import styles from './RosterPage.module.css';

function ago(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * /reading-room — the Sessions page: the reading-room counterpart of the
 * terminal's session list. A session is a SPACE, not a persona — she summons
 * whichever voices she wants inside it with slash commands (/spark, /terra,
 * /journalstart), exactly like a tmux session ("each session can have more
 * than 1 bot activated into it"). One card per session: name (renameable),
 * unread-since-reply accent, freshness; '+ New session' creates a named one,
 * optionally non-diary (dashed rule — sends log but never journal).
 */
export function RosterPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  // Model aliases the server will accept — it stays the authority on the
  // list; an empty one just hides the picker.
  const [modelChoices, setModelChoices] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionMeta | null>(null);
  // Two-step close (destructive-confirm pattern): first tap arms the button
  // into "Sure?", second tap closes. Arming a different card disarms this one.
  const [closeArmed, setCloseArmed] = useState<string | null>(null);

  const refresh = () => {
    getSessions()
      .then(({ sessions: list, model_choices }) => {
        setSessions(list);
        if (model_choices) setModelChoices(model_choices);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };

  useEffect(() => {
    refresh();
    // Gentle poll so a busy dot flips to ready on its own — a turn runs
    // detached from any one HTTP connection, so nothing else here would
    // notice it finishing.
    const id = setInterval(refresh, 5500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opened = openedMap();
  // isUnread lives in openedStore.ts so this dot and the reading room's
  // open-at-unread scroll anchor read the exact same comparison.
  const cardUnread = (c: SessionMeta) => isUnread(c.last_at, opened[c.id]);

  // The room page's route still carries a `$botId` URL segment (bots-
  // surface-design's file layout, un-nested via reading-room_.$botId.tsx) —
  // but with the persona concept dissolved server-side there's no real bot
  // id to put there anymore. Minimal routing change: keep the route, fill
  // that segment with a fixed placeholder; the conversation id (the only
  // identity that still means anything) travels in `?conv=`. Old bookmarked
  // URLs with a real bot id still route to the same page and just work —
  // the segment is never read for anything now.
  const open = (convId: string) => {
    void navigate({ to: '/reading-room/$botId', params: { botId: 'session' }, search: { conv: convId } });
  };

  const onCreate = (title: string, journal: boolean, model: string) => {
    createSession(title, journal, model)
      .then(({ id }) => {
        setNewOpen(false);
        open(id);
      })
      .catch(() => setFailed(true));
  };

  const onEdit = (title: string, journal: boolean, model: string) => {
    if (!renameTarget) return;
    // '' is meaningful here (clear the pin), so it's always sent.
    updateConversation(renameTarget.id, { title, journal, model })
      .then(() => {
        setRenameTarget(null);
        refresh();
      })
      .catch(() => setFailed(true));
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <h1 className={styles.title}>Sessions</h1>
          <button type="button" className={styles.newBtn} onClick={() => setNewOpen(true)}>
            + New session
          </button>
        </div>
        {failed ? <div className={styles.pageError}>Couldn&rsquo;t load sessions.</div> : null}

        <div className={styles.list}>
          {sessions.map((c) => {
            const unread = cardUnread(c);
            const status = sessionStatus(c, opened[c.id]);
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                className={[
                  styles.card,
                  unread ? styles.cardUnread : '',
                  c.journal === false ? styles.cardNoJournal : '',
                  c.pinned ? styles.cardPinned : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => open(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open(c.id);
                  }
                }}
              >
                <div className={styles.cardTop}>
                  <span className={[styles.botName, unread ? styles.botNameUnread : ''].filter(Boolean).join(' ')}>
                    {c.title || c.id}
                    {c.pinned ? <span className={styles.pinBadge}>pinned</span> : null}
                    {c.draft ? <span className={styles.stagedBadge}>staged</span> : null}
                    {status !== 'idle' ? (
                      <span
                        aria-hidden="true"
                        className={[
                          styles.statusDot,
                          status === 'busy' ? styles.statusDotBusy : styles.statusDotReady,
                        ].join(' ')}
                      />
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className={styles.editBtn}
                    aria-label={`Rename ${c.title || c.id}`}
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameTarget(c);
                    }}
                  >
                    ✎
                  </button>
                  {!c.pinned ? (
                    <button
                      type="button"
                      className={[styles.closeBtn, closeArmed === c.id ? styles.closeArmed : '']
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={`Close ${c.title || c.id}`}
                      title="Close session"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (closeArmed !== c.id) {
                          setCloseArmed(c.id);
                          return;
                        }
                        setCloseArmed(null);
                        closeConversation(c.id)
                          .then(refresh)
                          .catch(() => setFailed(true));
                      }}
                    >
                      {closeArmed === c.id ? 'Sure?' : '×'}
                    </button>
                  ) : null}
                  <span className={styles.cardTime}>{ago(c.last_at)}</span>
                </div>
                {c.summary ? <div className={styles.cardSummary}>{c.summary}</div> : null}
                {c.journal === false ? (
                  <div className={styles.cardNote}>not journaled</div>
                ) : null}
              </div>
            );
          })}
          {sessions.length === 0 && !failed ? (
            <div className={styles.emptyHint}>No sessions yet — start one.</div>
          ) : null}
        </div>

        <SessionDialog
          open={newOpen}
          title="New session"
          modelChoices={modelChoices}
          onClose={() => setNewOpen(false)}
          onSave={onCreate}
        />
        <SessionDialog
          open={renameTarget !== null}
          title={renameTarget ? `Edit ${renameTarget.title || renameTarget.id}` : 'Edit session'}
          initial={renameTarget?.title ?? ''}
          initialJournal={renameTarget?.journal === true}
          initialModel={renameTarget?.model ?? ''}
          modelChoices={modelChoices}
          onClose={() => setRenameTarget(null)}
          onSave={onEdit}
        />
      </div>
    </div>
  );
}
