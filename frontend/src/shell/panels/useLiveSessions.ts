import { useMemo } from 'react';
import { useSessionRoster } from '../../features/observatory/api';
import type { SessionState } from './panelTabs';

/**
 * useLiveSessions.ts — which sessions are working or waiting on her right now,
 * by conversation id, so a tab she opened can wear that state.
 *
 * This is a LOOKUP, not a feed of tabs: a session she hasn't opened gets
 * nothing on the bar however busy it is (the roster shows those). TabBar asks
 * it about each session tab it already has.
 *
 * Both facts are the server's, not guessed here. `running` is set server-side
 * because a turn outlives the HTTP connection that started it, and
 * `awaiting_input` is raised by the session itself when it asks for something.
 *
 * ONE QUERY, not one per panel. Every tab bar calls this, but they all share
 * react-query's roster cache under the same key, so three panels poll once
 * between them. Kept on the fast cadence: a status light that takes half a
 * minute to notice isn't one.
 *
 * Touches: panelTabs.ts (the shape it answers in), TabBar.tsx (the caller),
 * features/observatory/api.ts (the roster query it rides on).
 */
export function useLiveSessions(): ReadonlyMap<string, SessionState> {
  const { data } = useSessionRoster(true);
  const sessions = data?.sessions;

  return useMemo(() => {
    const states = new Map<string, SessionState>();
    for (const s of sessions ?? []) {
      // A question in a session she saved for later waits with it, uncoloured.
      const awaiting = Boolean(s.awaiting_input) && !s.saved_at;
      if (s.running || awaiting) states.set(s.id, { running: Boolean(s.running), awaiting });
    }
    return states;
  }, [sessions]);
}
