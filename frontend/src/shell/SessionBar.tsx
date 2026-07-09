import { useRef, useState } from 'react';
import type { SessionState } from './useSessions';
import { useNeedsInput } from './useNeedsInput';
import { NewSessionDialog } from './NewSessionDialog';
import styles from './SessionBar.module.css';

/**
 * Terminal session tabs — React port of split.html's desktop session bar
 * (renderDesktopTabs, templates/split.html:664-699). One tab per tmux
 * session, click to attach, `+` to create, `×` to close custom (non-default)
 * sessions. Default sessions (chat/dev/other) can't be closed.
 *
 * Dev-note-driven behavior:
 * - New-session naming uses a Sheet modal (NewSessionDialog), not
 *   `window.prompt`.
 * - Closing a session is a two-step "tap × again to confirm" (3s window,
 *   same pattern as the mini-notes delete button), not `window.confirm`.
 * - A tab whose session is waiting on input (and isn't the open one) gets a
 *   tint — see useNeedsInput. The 'chat' session is excluded from that tint:
 *   the needs-input heuristic keys off Claude Code's own status line ("? for
 *   shortcuts"), which is on screen almost continuously while Claude Code is
 *   running — so chat's tab read as orange essentially all the time ("make
 *   the chat session not orange all the time"). It still gets its own fixed,
 *   always-on accent when idle so it stays easy to spot at a glance ("still
 *   make it a different color though, because i like that"), just not the
 *   shared warning-orange.
 */
export function SessionBar({ sessions }: { sessions: SessionState }) {
  const { sessions: list, active, setActive, addSession, removeSession, isCustom } = sessions;
  const needsInput = useNeedsInput(list.length > 0);

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionError, setNewSessionError] = useState<string | null>(null);

  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openNewSession = () => {
    setNewSessionError(null);
    setNewSessionOpen(true);
  };

  const onCreate = (name: string) => {
    addSession(name)
      .then(() => setNewSessionOpen(false))
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
    <div className={styles.bar} role="tablist" aria-label="Terminal sessions">
      {list.map((s) => {
        const isChat = s === 'chat';
        const tinted = needsInput[s] && s !== active && !isChat;
        const chatIdle = isChat && s !== active;
        const confirming = confirmCloseId === s;
        return (
          <div
            key={s}
            className={[
              styles.tab,
              s === active ? styles.active : '',
              tinted ? styles.needsInput : '',
              chatIdle ? styles.chatIdle : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={s === active}
              className={styles.tabLabel}
              onClick={() => setActive(s)}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
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
        );
      })}
      <button type="button" className={styles.addBtn} title="New session" aria-label="New session" onClick={openNewSession}>
        +
      </button>
      <NewSessionDialog
        open={newSessionOpen}
        error={newSessionError}
        onClose={() => setNewSessionOpen(false)}
        onCreate={onCreate}
      />
    </div>
  );
}
