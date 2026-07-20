import { useEffect, useState } from 'react';
import type { SessionState } from './useSessions';
import { useSettledFrames } from './useSettledFrames';
import styles from './TerminalFrames.module.css';

/**
 * Mounts one ttyd iframe per visited tmux session and toggles `display`
 * instead of swapping `src` — the fix for two dev notes at once:
 *
 * - "there is always a 'navigate away from this page?' prompt when I'm
 *   switching between terminal tabs" — that's ttyd's own xterm.js client
 *   warning before its page unloads. TerminalPane used to force that unload
 *   on every switch (`key={active}` on a single iframe re-mounts it with a
 *   new `src`). If the iframe is never unmounted, its page never unloads, so
 *   the prompt never fires.
 * - "I have to click the terminal tab I want twice for it to show up" — the
 *   same reload meant the newly-attached ttyd session hadn't finished its
 *   websocket handshake by the time the click handler returned; toggling
 *   `display` on an already-live iframe is instant.
 *
 * Each mounted iframe is its own ttyd websocket connection (ttyd spawns a
 * fresh `ttyd_connect.sh <session>` per connection and attaches to the named
 * tmux session — tmux supports multiple simultaneous attaches to the same
 * session fine), so this is architecturally the same as FrameHost.tsx's
 * approach for the dashboard pane's legacy iframes.
 *
 * "the terminal pane can get stuck empty... loads fine if i click another
 * tab and then navigate back" — see useSettledFrames for why: every newly
 * mounted iframe here is forced through one display:none->block cycle
 * before it's ever shown, instead of hoping the user stumbles into an
 * unrelated navigation that happens to do the same thing.
 */
export function TerminalFrames({ sessions }: { sessions: SessionState }) {
  const { active, sessions: list, workers } = sessions;
  const [visited, setVisited] = useState<string[]>(() => [active]);
  const settled = useSettledFrames(visited);

  // Mount a new iframe the first time a session becomes active.
  useEffect(() => {
    setVisited((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [active]);

  // Unmount iframes for sessions that no longer exist (closed elsewhere).
  // Never prune `active`: on a fresh page load `list` is still useSessions'
  // FALLBACK placeholder (['chat']) until /api/sessions answers, and judging
  // the localStorage-remembered active session against that unmounted its
  // iframe with nothing to ever re-add it (the add effect only fires when
  // `active` *changes*) — refresh on any non-chat session showed a blank
  // pane until a tab switch. Workers (rw-*) count as existing too; they
  // live in their own list. If the active session truly dies, useSessions
  // moves `active` off it and the next pass prunes it normally.
  useEffect(() => {
    setVisited((prev) => {
      const next = prev.filter((s) => s === active || list.includes(s) || workers.includes(s));
      return next.length === prev.length ? prev : next;
    });
  }, [list, workers, active]);

  return (
    <>
      {visited.map((s) => (
        <iframe
          key={s}
          title={`Terminal — ${s}`}
          className={styles.frame}
          src={`/terminal/?arg=${encodeURIComponent(s)}`}
          scrolling="no"
          style={{ display: s === active && settled.has(s) ? 'block' : 'none' }}
        />
      ))}
    </>
  );
}
