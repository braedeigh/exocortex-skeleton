import { useEffect, useMemo, useState } from 'react';
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
import { Orchestra } from './Orchestra';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { ToastStack } from '../../ui';
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

// The roster's sort order — by creation time, so cards never churn on
// activity. 'oldest' (the default) puts the earliest-made session at the top
// and the newest at the bottom; a header toggle flips it. Persisted so her
// choice survives reloads, mirroring the notes-pill sort.
type RosterSort = 'oldest' | 'newest';
const SORT_KEY = 'exo-observatory-sort';

function readStoredSort(): RosterSort {
  if (typeof localStorage === 'undefined') return 'oldest';
  return localStorage.getItem(SORT_KEY) === 'newest' ? 'newest' : 'oldest';
}

/** Pinned (the Keeper) always on top; everything else by `started`, in the
 * chosen direction. `started` back-fills to last_at for legacy entries. Stable
 * because it keys on a fixed timestamp — the poll can't reshuffle it. */
function sortRoster(sessions: SessionMeta[], dir: RosterSort): SessionMeta[] {
  const sign = dir === 'oldest' ? 1 : -1;
  return [...sessions].sort((a, b) => {
    const pin = (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1);
    if (pin !== 0) return pin;
    const as = a.started || a.last_at || '';
    const bs = b.started || b.last_at || '';
    return as < bs ? -sign : as > bs ? sign : 0;
  });
}

/**
 * /observatory — the Sessions page: the observatory counterpart of the
 * terminal's session list. A session is a SPACE, not a persona — she summons
 * whichever voices she wants inside it with slash commands (/spark, /terra,
 * /journalstart), exactly like a tmux session ("each session can have more
 * than 1 bot activated into it"). One card per session: name (renameable),
 * unread-since-reply accent, freshness; '+ New session' creates a named one,
 * optionally non-diary (dashed rule — sends log but never journal).
 *
 * DOCKED MODE (07-25): also the Sessions view of the desktop split's left
 * pane (shell/KeeperPane.tsx). `onOpenConversation` is the same seam
 * ObservatoryPage has — opening a card hands the id to the pane instead of
 * routing the whole app, so the roster and the room it opens into are both
 * on the left and the right pane keeps whatever she was reading.
 */
export function RosterPage({ onOpenConversation }: { onOpenConversation?: (convId: string) => void } = {}) {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  // Model aliases the server will accept — it stays the authority on the
  // list; an empty one just hides the picker.
  const [modelChoices, setModelChoices] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  const [sortDir, setSortDir] = useState<RosterSort>(readStoredSort);
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

  // Orchestra shows anything that needs watching or a reply: running now, OR
  // awaiting her input (the ask outlives the turn, so an awaiting session isn't
  // necessarily still "running").
  const orchestraSessions = sessions.filter((c) => c.running || c.awaiting_input);
  const orderedSessions = useMemo(() => sortRoster(sessions, sortDir), [sessions, sortDir]);
  const toggleSort = () => {
    setSortDir((cur) => {
      const next: RosterSort = cur === 'oldest' ? 'newest' : 'oldest';
      if (typeof localStorage !== 'undefined') localStorage.setItem(SORT_KEY, next);
      return next;
    });
  };
  const opened = openedMap();
  // isUnread lives in openedStore.ts so this dot and the observatory's
  // open-at-unread scroll anchor read the exact same comparison.
  const cardUnread = (c: SessionMeta) => isUnread(c.last_at, opened[c.id]);

  // The room page's route still carries a `$botId` URL segment (bots-
  // surface-design's file layout, un-nested via observatory_.$botId.tsx) —
  // but with the persona concept dissolved server-side there's no real bot
  // id to put there anymore. Minimal routing change: keep the route, fill
  // that segment with a fixed placeholder; the conversation id (the only
  // identity that still means anything) travels in `?conv=`. Old bookmarked
  // URLs with a real bot id still route to the same page and just work —
  // the segment is never read for anything now.
  const open = (convId: string) => {
    if (onOpenConversation) {
      onOpenConversation(convId);
      return;
    }
    void navigate({ to: '/observatory/$botId', params: { botId: 'session' }, search: { conv: convId } });
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
          <h1 className={styles.title}>Observatory</h1>
          <button type="button" className={styles.newBtn} onClick={() => setNewOpen(true)}>
            + New session
          </button>
        </div>
        {failed ? <div className={styles.pageError}>Couldn&rsquo;t load sessions.</div> : null}

        <div className={styles.sectionRow}>
          <div className={styles.sectionLabel}>My sessions</div>
          <button
            type="button"
            className={styles.sortBtn}
            onClick={toggleSort}
            title={sortDir === 'oldest' ? 'Oldest first — tap for newest first' : 'Newest first — tap for oldest first'}
            aria-label="Change session sort order"
          >
            {sortDir === 'oldest' ? 'Oldest first ↓' : 'Newest first ↑'}
          </button>
        </div>
        <div className={styles.list}>
          {orderedSessions.map((c) => {
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

        {/* The live section sits below her own sessions now (her 07-27 ask):
            the roster she reaches for is her sessions; the Orchestra is what's
            running underneath, not the first thing in her face. */}
        <Orchestra sessions={orchestraSessions} onOpen={open} onChanged={refresh} />

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

      {/* Same floating dev-notes / ideas pill as every other page — only on
          the full Observatory route, not the desktop split's docked pane. */}
      {!onOpenConversation ? (
        <>
          <ToastStack toasts={toasts} onDismiss={dismiss} />
          <NotesPill tab="observatory" onError={push} />
        </>
      ) : null}
    </div>
  );
}
