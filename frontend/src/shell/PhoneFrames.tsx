import { useEffect, useState } from 'react';
import type { SessionState } from './useSessions';
import { useSettledFrames } from './useSettledFrames';
import styles from './PhoneFrames.module.css';

/**
 * Mobile counterpart to TerminalFrames.tsx: one iframe per visited tmux
 * session, `src="/phone?session=<name>"` (templates/phone.html — the same
 * mobile-optimized ttyd view the old split.html Chat tab used), keeping every
 * visited session's iframe mounted and toggling CSS `display` on switch
 * instead of swapping `src`. Same reasoning as TerminalFrames: an unmounted-
 * then-remounted iframe re-triggers ttyd's own "leave site?" unload prompt
 * and loses the websocket handshake for a beat, which reads as "I have to
 * tap the tab twice."
 */
export function PhoneFrames({ sessions }: { sessions: SessionState }) {
  const { active, sessions: list } = sessions;
  const [visited, setVisited] = useState<string[]>(() => [active]);
  // See useSettledFrames — same first-mount blank-iframe workaround as
  // TerminalFrames' desktop counterpart.
  const settled = useSettledFrames(visited);

  // Mount a new iframe the first time a session becomes active.
  useEffect(() => {
    setVisited((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [active]);

  // Unmount iframes for sessions that no longer exist (closed elsewhere).
  useEffect(() => {
    setVisited((prev) => {
      const next = prev.filter((s) => list.includes(s));
      return next.length === prev.length ? prev : next;
    });
  }, [list]);

  return (
    <>
      {visited.map((s) => (
        <iframe
          key={s}
          title={`Chat — ${s}`}
          className={styles.frame}
          src={`/phone?session=${encodeURIComponent(s)}`}
          scrolling="no"
          style={{ display: s === active && settled.has(s) ? 'block' : 'none' }}
        />
      ))}
    </>
  );
}
