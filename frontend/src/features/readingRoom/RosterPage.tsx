import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  closeConversation,
  createConversation,
  getBots,
  updateConversation,
  type BotConvMeta,
} from './api';
import { sessionStatus } from './sessionStatus';
import { openedMap } from './openedStore';
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
  const [botId, setBotId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<BotConvMeta[]>([]);
  const [failed, setFailed] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BotConvMeta | null>(null);
  // Two-step close (destructive-confirm pattern): first tap arms the button
  // into "Sure?", second tap closes. Arming a different card disarms this one.
  const [closeArmed, setCloseArmed] = useState<string | null>(null);

  const refresh = () => {
    getBots()
      .then(({ bots }) => {
        // v1 runs one engine config; its conversations ARE the sessions.
        const bot = bots[0];
        if (!bot) return;
        setBotId(bot.id);
        setSessions(bot.conversations);
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
  const isUnread = (c: BotConvMeta) => {
    if (!c.last_at) return false;
    const seen = opened[c.id];
    return !seen || Date.parse(c.last_at) > Date.parse(seen);
  };

  const open = (convId: string) => {
    if (!botId) return;
    void navigate({ to: '/reading-room/$botId', params: { botId }, search: { conv: convId } });
  };

  const onCreate = (title: string, journal: boolean) => {
    if (!botId) return;
    createConversation(botId, title, journal)
      .then(({ id }) => {
        setNewOpen(false);
        open(id);
      })
      .catch(() => setFailed(true));
  };

  const onEdit = (title: string, journal: boolean) => {
    if (!renameTarget) return;
    updateConversation(renameTarget.id, { title, journal })
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
            const unread = isUnread(c);
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
          onClose={() => setNewOpen(false)}
          onSave={onCreate}
        />
        <SessionDialog
          open={renameTarget !== null}
          title={renameTarget ? `Edit ${renameTarget.title || renameTarget.id}` : 'Edit session'}
          initial={renameTarget?.title ?? ''}
          initialJournal={renameTarget?.journal === true}
          onClose={() => setRenameTarget(null)}
          onSave={onEdit}
        />
      </div>
    </div>
  );
}
