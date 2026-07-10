import { useEffect, useState } from 'react';
import type { SessionState } from './useSessions';
import { useSettledFrames } from './useSettledFrames';
import { PhoneTerminal } from '../features/phone/PhoneTerminal';

/**
 * Mobile counterpart to TerminalFrames.tsx: one native PhoneTerminal
 * (features/phone — the React port of templates/phone.html, which this used
 * to load as a `/phone?session=…` iframe) per visited tmux session, keeping
 * every visited session mounted and toggling visibility on switch instead of
 * unmounting. Same reasoning as TerminalFrames: each PhoneTerminal contains
 * a live ttyd iframe, and an unmounted-then-remounted iframe re-triggers
 * ttyd's own "leave site?" unload prompt and loses the websocket handshake
 * for a beat, which reads as "I have to tap the tab twice." Keeping the
 * component mounted also preserves its chrome state (draft message, open
 * panels) across session switches.
 *
 * closePicker (present when ChatPage passes its SessionsUiState) is handed
 * down as PhoneTerminal's onInteract: tapping into the /phone iframe used to
 * blur the window, which ChatPage treated as "done picking — fold the picker
 * away"; a native tap doesn't blur anything, so the terminal reports the
 * interaction explicitly instead.
 */
export function PhoneFrames({ sessions }: { sessions: SessionState & { closePicker?: () => void } }) {
  const { active, sessions: list } = sessions;
  const [visited, setVisited] = useState<string[]>(() => [active]);
  // See useSettledFrames — same first-mount blank-iframe workaround as
  // TerminalFrames' desktop counterpart (the ttyd iframe inside PhoneTerminal
  // still needs its one display:none->visible settle frame).
  const settled = useSettledFrames(visited);

  // Mount a new terminal the first time a session becomes active.
  useEffect(() => {
    setVisited((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [active]);

  // Unmount terminals for sessions that no longer exist (closed elsewhere).
  useEffect(() => {
    setVisited((prev) => {
      const next = prev.filter((s) => list.includes(s));
      return next.length === prev.length ? prev : next;
    });
  }, [list]);

  return (
    <>
      {visited.map((s) => (
        <PhoneTerminal
          key={s}
          session={s}
          active={s === active}
          visible={s === active && settled.has(s)}
          onInteract={sessions.closePicker}
        />
      ))}
    </>
  );
}
