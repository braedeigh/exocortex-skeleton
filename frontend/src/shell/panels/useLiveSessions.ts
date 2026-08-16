import { useMemo } from 'react';
import { useSessionRoster } from '../../features/observatory/api';
import type { LiveTab } from './panelTabs';

/**
 * useLiveSessions.ts — the sessions that belong on the bar without her having
 * opened them.
 *
 * Two states count as live, and they're deliberately one group: a session
 * WORKING right now, and a session that stopped and is WAITING on her. Both
 * are things happening that she'd want to see from any panel; they're told
 * apart by colour on the tab, not by position, so the group never reshuffles
 * when one changes state.
 *
 * Both facts are the server's, not guessed here. `running` is set server-side
 * because a turn outlives the HTTP connection that started it, and
 * `awaiting_input` is raised by the session itself when it asks for something.
 *
 * ONE QUERY, not one per panel. Every tab bar calls this, but they all share
 * react-query's roster cache under the same key, so three panels poll once
 * between them. Kept on the fast cadence rather than the idle one: this is the
 * feed that makes a starting session appear, and a status light that takes
 * half a minute to notice isn't one.
 *
 * Touches: panelTabs.ts (the shape it feeds), TabBar.tsx (the caller),
 * features/observatory/api.ts (the roster query it rides on).
 */
export function useLiveSessions(): LiveTab[] {
  const { data } = useSessionRoster(true);
  const sessions = data?.sessions;

  return useMemo(() => {
    if (!sessions) return [];
    return sessions
      .filter((s) => s.running || s.awaiting_input)
      .map((s) => ({
        convId: s.id,
        title: s.title,
        running: Boolean(s.running),
        // A session can be running again after having asked — running wins for
        // the label's sake, but both flags travel so the tab can decide.
        awaiting: Boolean(s.awaiting_input),
      }));
  }, [sessions]);
}
