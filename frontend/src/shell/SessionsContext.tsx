import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useSessions, type SessionState } from './useSessions';

/**
 * Thin context wrapper around useSessions (unchanged) so the root layout can
 * own a single live instance shared by everything that needs "which tmux
 * session is active" outside the desktop split — right now that's TopTabs'
 * mobile Chat tab (label = active session name, see dev note on chat.tsx)
 * and the /chat route itself (session picker + iframes). Without this, two
 * independent useSessions() calls would each keep their own React state, so
 * switching sessions in one wouldn't be reflected in the other until a full
 * remount — the Chat tab label would go stale the moment you switched tabs
 * inside /chat.
 *
 * Also carries the /chat session picker's open/closed state (pickerOpen),
 * for the same cross-component reason: the thing that TOGGLES the picker is
 * the Chat tab in TopTabs (tapping it while already on /chat), but the thing
 * that RENDERS it is ChatPage — see ChatSessionPicker.
 *
 * Desktop's SplitLayout/TerminalPane keep their own separate useSessions()
 * call — untouched by this — since there's no cross-component sync problem
 * there (the mobile Chat tab and /chat route are both hidden/redirected away
 * on desktop).
 */
export interface SessionsUiState extends SessionState {
  pickerOpen: boolean;
  togglePicker: () => void;
  closePicker: () => void;
}

const SessionsCtx = createContext<SessionsUiState | null>(null);

export function SessionsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const sessions = useSessions(enabled);
  const [pickerOpen, setPickerOpen] = useState(false);
  const togglePicker = useCallback(() => setPickerOpen((v) => !v), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const value = useMemo(
    () => ({ ...sessions, pickerOpen, togglePicker, closePicker }),
    [sessions, pickerOpen, togglePicker, closePicker],
  );
  return <SessionsCtx.Provider value={value}>{children}</SessionsCtx.Provider>;
}

export function useSessionsContext(): SessionsUiState {
  const ctx = useContext(SessionsCtx);
  if (!ctx) throw new Error('useSessionsContext must be used within a SessionsProvider');
  return ctx;
}
