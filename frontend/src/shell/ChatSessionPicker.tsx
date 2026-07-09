import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet, TapRow } from '../ui';
import type { SessionsUiState } from './SessionsContext';
import { useNeedsInput } from './useNeedsInput';
import { NewSessionDialog } from './NewSessionDialog';
import styles from './ChatSessionPicker.module.css';

/**
 * The /chat session picker row — collapsed by default (ChatPage only mounts
 * it while pickerOpen, so the /phone iframe normally gets full height) and
 * toggled by tapping the Chat dash-tab while already on /chat (see TopTabs).
 *
 * One little tab per tmux session in the same visual language as the other
 * tab rows (purple underline on the active one), a `×` to close visible
 * custom sessions (SessionBar's two-step "tap again to confirm"), and a `+`
 * that opens NewSessionDialog. Sessions that don't fit the width fold into a
 * "More ▾" Sheet — the same measure-then-hide-from-the-end pass as
 * DashboardTabRow's layoutTabs port (TopTabs.tsx), except every session is
 * "optional" (only the active one is never folded) and the refs are keyed by
 * live session name instead of a fixed tab union. The More button is always
 * mounted (visibility:hidden when nothing overflows) so its width is part of
 * every measurement — conditionally unmounting it would free width, un-
 * overflow the row, remount it, re-overflow it, and oscillate forever.
 *
 * Picking a session (row tab or More sheet) sets it active AND closes the
 * picker — the picker is a transient switcher, not a persistent bar.
 */
export function ChatSessionPicker({ sessions }: { sessions: SessionsUiState }) {
  const { sessions: list, active, setActive, addSession, removeSession, isCustom, closePicker } = sessions;
  const needsInput = useNeedsInput(list.length > 0);

  const [overflowed, setOverflowed] = useState<readonly string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionError, setNewSessionError] = useState<string | null>(null);

  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rowRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Measure with every session tab visible, then hide from the end (never
  // the active one) until the row fits — DashboardTabRow's layout(), minus
  // its hide-the-active-tab-last fallback: the active session always stays
  // visible, and if its name alone is wider than the row it just clips
  // (the row is overflow:hidden).
  const layout = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    for (const s of list) {
      const el = tabRefs.current[s];
      if (el) el.style.display = 'flex';
    }
    const newOverflow: string[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (row.scrollWidth <= row.clientWidth) break;
      const s = list[i];
      if (s === active) continue;
      const el = tabRefs.current[s];
      if (el) el.style.display = 'none';
      newOverflow.unshift(s);
    }
    // Leave inline styles exactly matching the decision — the committed state
    // re-applies the same answer via the .hidden class, so render and
    // measurement never fight.
    for (const s of list) {
      const el = tabRefs.current[s];
      if (el) el.style.display = newOverflow.includes(s) ? 'none' : 'flex';
    }
    setOverflowed((prev) =>
      prev.length === newOverflow.length && prev.every((s, i) => s === newOverflow[i]) ? prev : newOverflow,
    );
  }, [list, active]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    layout();
    const ro = new ResizeObserver(() => layout());
    ro.observe(row);
    return () => ro.disconnect();
  }, [layout]);

  const select = (name: string) => {
    setActive(name);
    setMoreOpen(false);
    closePicker();
  };

  const openNewSession = () => {
    setNewSessionError(null);
    setNewSessionOpen(true);
  };

  const onCreate = (name: string) => {
    addSession(name) // addSession also makes the new session active
      .then(() => {
        setNewSessionOpen(false);
        closePicker();
      })
      .catch((e: Error) => setNewSessionError(e.message));
  };

  // Two-step "tap × again to confirm" close, verbatim from SessionBar.
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
    <div className={styles.picker} role="tablist" aria-label="Terminal sessions">
      <div className={styles.row} ref={rowRef}>
        {list.map((s) => {
          const isChat = s === 'chat';
          // Chat is excluded from the shared needs-input tint and gets its
          // own fixed idle accent instead — see SessionBar.tsx's header
          // comment ("make the chat session not orange all the time").
          const tinted = needsInput[s] && s !== active && !isChat;
          const chatIdle = isChat && s !== active;
          const confirming = confirmCloseId === s;
          return (
            <div
              key={s}
              ref={(el) => {
                tabRefs.current[s] = el;
              }}
              className={[
                styles.tab,
                s === active ? styles.active : '',
                tinted ? styles.needsInput : '',
                chatIdle ? styles.chatIdle : '',
                overflowed.includes(s) ? styles.hidden : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={s === active}
                className={styles.tabLabel}
                onClick={() => select(s)}
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
      </div>

      <button
        type="button"
        className={[styles.moreBtn, overflowed.length === 0 ? styles.moreIdle : ''].filter(Boolean).join(' ')}
        onClick={() => setMoreOpen(true)}
        aria-expanded={moreOpen}
        aria-haspopup="menu"
      >
        More &#9662;
      </button>

      <button type="button" className={styles.addBtn} title="New session" aria-label="New session" onClick={openNewSession}>
        +
      </button>

      <Sheet open={moreOpen} title="Sessions" onClose={() => setMoreOpen(false)}>
        {overflowed.map((s) => (
          <TapRow key={s} onClick={() => select(s)}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </TapRow>
        ))}
      </Sheet>

      <NewSessionDialog
        open={newSessionOpen}
        error={newSessionError}
        onClose={() => setNewSessionOpen(false)}
        onCreate={onCreate}
      />
    </div>
  );
}
