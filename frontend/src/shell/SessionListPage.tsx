import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Sheet } from '../ui';
import { useSessionsContext } from './SessionsContext';
import { NewSessionDialog } from './NewSessionDialog';
import { getSessionRecaps, type SessionRecap } from './shellApi';
import styles from './SessionListPage.module.css';

const POLL_MS = 6000;

function fallbackTitle(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function ago(ts: number | null): string | null {
  if (!ts) return null;
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * The /sessions full-page terminal switcher — replaces the old ChatSessionPicker
 * dropdown row ("no second dropdown of tabs anymore; a full page, each labeled
 * by title with the latest recap from the terminal as the description").
 * Reached by tapping the Chat dash-tab while already on /chat (TopTabs).
 *
 * A top-to-bottom stack of cards, one per tmux session: display title
 * (user-set via the ✎ rename sheet, else the session name), the latest recap
 * from /api/terminal/recaps (the pane's Claude transcript, or the pane tail
 * for plain shells) with its freshness, waiting/busy badges, and the same
 * two-step `×` close for custom sessions as SessionBar. Live rw-* worker
 * sessions get their own read-only section (attach-only — no ×, no rename).
 * Tapping any card makes that session active and returns to /chat.
 */
export function SessionListPage() {
  const sessions = useSessionsContext();
  const { sessions: list, workers, titles, active, setActive, addSession, removeSession, setTitle, isCustom } =
    sessions;
  const navigate = useNavigate();

  const [recaps, setRecaps] = useState<Record<string, SessionRecap>>({});
  const [recapsFailed, setRecapsFailed] = useState(false);

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionError, setNewSessionError] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Two-step "tap × again to confirm" close, same as SessionBar.
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getSessionRecaps()
        .then((data) => {
          if (cancelled) return;
          setRecaps(data.sessions || {});
          setRecapsFailed(false);
        })
        .catch(() => {
          if (!cancelled) setRecapsFailed(true);
        });
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const open = (name: string) => {
    setActive(name);
    void navigate({ to: '/chat' });
  };

  const onCreate = (name: string) => {
    addSession(name) // addSession also makes the new session active
      .then(() => {
        setNewSessionOpen(false);
        void navigate({ to: '/chat' });
      })
      .catch((e: Error) => setNewSessionError(e.message));
  };

  const onRename = (title: string) => {
    if (!renameTarget) return;
    setTitle(renameTarget, title)
      .then(() => setRenameTarget(null))
      .catch((e: Error) => setRenameError(e.message));
  };

  const onCloseClick = (name: string) => {
    if (confirmCloseId !== name) {
      clearTimeout(confirmTimer.current ?? undefined);
      setConfirmCloseId(name);
      confirmTimer.current = setTimeout(() => setConfirmCloseId(null), 3000);
      return;
    }
    clearTimeout(confirmTimer.current ?? undefined);
    setConfirmCloseId(null);
    removeSession(name).catch((e) => window.alert(e.message));
  };

  const renderCard = (s: string, worker: boolean) => {
    const r = recaps[s];
    const waiting = !worker && !!r?.needsInput;
    const busy = r?.status === 'busy';
    const confirming = confirmCloseId === s;
    const updated = ago(r?.updatedAt ?? null);
    return (
      <div
        key={s}
        role="button"
        tabIndex={0}
        className={[styles.card, s === active ? styles.cardActive : '', worker ? styles.cardWorker : '']
          .filter(Boolean)
          .join(' ')}
        onClick={() => open(s)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open(s);
          }
        }}
      >
        <div className={styles.cardTop}>
          <span className={styles.cardTitle}>{titles[s] || fallbackTitle(s)}</span>
          {!worker && (
            <button
              type="button"
              className={styles.editBtn}
              aria-label={`Rename ${s} session`}
              title="Rename"
              onClick={(e) => {
                e.stopPropagation();
                setRenameError(null);
                setRenameTarget(s);
              }}
            >
              ✎
            </button>
          )}
          {!worker && isCustom(s) && (
            <button
              type="button"
              className={[styles.closeX, confirming ? styles.closeConfirm : ''].filter(Boolean).join(' ')}
              aria-label={confirming ? `Confirm close ${s} session` : `Close ${s} session`}
              title={confirming ? 'Tap again to confirm — this kills the tmux session' : 'Close session'}
              onClick={(e) => {
                e.stopPropagation();
                onCloseClick(s);
              }}
            >
              {confirming ? 'Sure?' : '×'}
            </button>
          )}
        </div>
        <div className={styles.cardMeta}>
          {s === active ? <span className={styles.badge}>current</span> : null}
          {worker ? <span className={styles.badge}>worker</span> : null}
          {waiting ? <span className={[styles.badge, styles.badgeWaiting].join(' ')}>waiting for input</span> : null}
          {!waiting && busy ? <span className={[styles.badge, styles.badgeBusy].join(' ')}>● busy</span> : null}
          {updated ? <span className={styles.cardTime}>updated {updated}</span> : null}
        </div>
        {r?.error ? (
          <div className={styles.cardError}>{r.error}</div>
        ) : (
          <div className={styles.cardRecap}>
            {r?.status === 'not-running' ? 'Not started yet — tap to open.' : r?.recap || (r ? 'Nothing here yet.' : '…')}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
      <div className={styles.header}>
        <h1 className={styles.title}>Terminals</h1>
        <button
          type="button"
          className={styles.newBtn}
          onClick={() => {
            setNewSessionError(null);
            setNewSessionOpen(true);
          }}
        >
          + New session
        </button>
      </div>

      {recapsFailed && Object.keys(recaps).length === 0 ? (
        <div className={styles.pageError}>Couldn’t load recaps — descriptions unavailable.</div>
      ) : null}

      <div className={styles.list}>{list.map((s) => renderCard(s, false))}</div>

      {workers.length > 0 ? (
        <>
          <div className={styles.sectionLabel}>Workers</div>
          <div className={styles.list}>{workers.map((s) => renderCard(s, true))}</div>
        </>
      ) : null}

      <NewSessionDialog
        open={newSessionOpen}
        error={newSessionError}
        onClose={() => setNewSessionOpen(false)}
        onCreate={onCreate}
      />

      <RenameDialog
        target={renameTarget}
        current={renameTarget ? titles[renameTarget] || '' : ''}
        error={renameError}
        onClose={() => setRenameTarget(null)}
        onSave={onRename}
      />
      </div>
    </div>
  );
}

/** Sheet for the ✎ button — set a card's display title; empty reverts to the
 * session name. Same shape as NewSessionDialog. */
function RenameDialog({
  target,
  current,
  error,
  onClose,
  onSave,
}: {
  target: string | null;
  current: string;
  error: string | null;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [title, setTitleState] = useState('');

  useEffect(() => {
    if (target) setTitleState(current);
    // Re-seed only when a new card's rename opens, not as `current` refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSave(title);
    }
  };

  return (
    <Sheet open={target !== null} title={target ? `Rename ${fallbackTitle(target)}` : 'Rename'} onClose={onClose}>
      <div className={styles.renameBody}>
        <input
          autoFocus
          type="text"
          className={styles.renameInput}
          placeholder={target ? fallbackTitle(target) : ''}
          maxLength={40}
          value={title}
          onChange={(e) => setTitleState(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={styles.renameHint}>Leave empty to go back to the session name.</div>
        {error && <div className={styles.renameError}>{error}</div>}
        <button type="button" className={styles.renameSave} onClick={() => onSave(title)}>
          Save
        </button>
      </div>
    </Sheet>
  );
}
