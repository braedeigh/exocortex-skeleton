import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSessionsContext } from './SessionsContext';
import { useNeedsInput } from './useNeedsInput';
import { NewSessionDialog } from './NewSessionDialog';
import { getSessionRecaps, type SessionRecap } from './shellApi';
import styles from './SessionListPage.module.css';

const POLL_MS = 6000;

/**
 * The /sessions full-page terminal switcher — replaces the old ChatSessionPicker
 * dropdown row ("no second dropdown of tabs anymore; a full page, each labeled
 * by title with the latest recap from the terminal as the description").
 * Reached by tapping the Chat dash-tab while already on /chat (TopTabs).
 *
 * A top-to-bottom stack of cards, one per tmux session: the session name,
 * the latest recap from /api/terminal/recaps (the pane's Claude transcript,
 * or the pane tail for plain shells), a busy/waiting badge, and the same
 * two-step `×` close for custom sessions as SessionBar. Tapping a card makes
 * that session active and returns to /chat — the terminal iframe is already
 * mounted (PhoneFrames), so it opens instantly.
 */
export function SessionListPage() {
  const sessions = useSessionsContext();
  const { sessions: list, active, setActive, addSession, removeSession, isCustom } = sessions;
  const navigate = useNavigate();
  const needsInput = useNeedsInput(list.length > 0);

  const [recaps, setRecaps] = useState<Record<string, SessionRecap>>({});
  const [recapsFailed, setRecapsFailed] = useState(false);

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionError, setNewSessionError] = useState<string | null>(null);

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

  return (
    <div className={styles.page}>
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

      <div className={styles.list}>
        {list.map((s) => {
          const r = recaps[s];
          const waiting = !!needsInput[s];
          const busy = r?.status === 'busy';
          const confirming = confirmCloseId === s;
          return (
            <div
              key={s}
              role="button"
              tabIndex={0}
              className={[styles.card, s === active ? styles.cardActive : ''].filter(Boolean).join(' ')}
              onClick={() => open(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  open(s);
                }
              }}
            >
              <div className={styles.cardTop}>
                <span className={styles.cardTitle}>{s.charAt(0).toUpperCase() + s.slice(1)}</span>
                {waiting ? <span className={[styles.badge, styles.badgeWaiting].join(' ')}>waiting for input</span> : null}
                {!waiting && busy ? <span className={[styles.badge, styles.badgeBusy].join(' ')}>● busy</span> : null}
                {s === active ? <span className={styles.badge}>current</span> : null}
                {isCustom(s) && (
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
              {r?.error ? (
                <div className={styles.cardError}>{r.error}</div>
              ) : (
                <div className={styles.cardRecap}>
                  {r?.status === 'not-running'
                    ? 'Not started yet — tap to open.'
                    : r?.recap || (r ? 'Nothing here yet.' : '…')}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <NewSessionDialog
        open={newSessionOpen}
        error={newSessionError}
        onClose={() => setNewSessionOpen(false)}
        onCreate={onCreate}
      />
    </div>
  );
}
