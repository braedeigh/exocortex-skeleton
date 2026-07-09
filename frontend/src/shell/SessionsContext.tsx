import { createContext, useContext, type ReactNode } from 'react';
import { useSessions, type SessionState } from './useSessions';

/**
 * Thin context wrapper around useSessions (unchanged) so the root layout can
 * own a single live instance shared by everything that needs "which tmux
 * session is active" outside the desktop split — right now that's TopTabs'
 * mobile Chat tab (label = active session name, see dev note on chat.tsx)
 * and the /chat route itself (session switcher + iframes). Without this, two
 * independent useSessions() calls would each keep their own React state, so
 * switching sessions in one wouldn't be reflected in the other until a full
 * remount — the Chat tab label would go stale the moment you switched tabs
 * inside /chat.
 *
 * Desktop's SplitLayout/TerminalPane keep their own separate useSessions()
 * call — untouched by this — since there's no cross-component sync problem
 * there (the mobile Chat tab and /chat route are both hidden/redirected away
 * on desktop).
 */
const SessionsCtx = createContext<SessionState | null>(null);

export function SessionsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const sessions = useSessions(enabled);
  return <SessionsCtx.Provider value={sessions}>{children}</SessionsCtx.Provider>;
}

export function useSessionsContext(): SessionState {
  const ctx = useContext(SessionsCtx);
  if (!ctx) throw new Error('useSessionsContext must be used within a SessionsProvider');
  return ctx;
}
