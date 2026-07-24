import { useEffect, useState } from 'react';

/**
 * chatSurface.ts — which surface the mobile Chat tab opens: the tmux
 * terminal (/chat, the default) or the Keeper bot's reading room
 * (/reading-room/keeper — bot-surface-design, "wanting it to replace the
 * terminal"). A localStorage flag with a change event, same shape as
 * usageHeat's, so Settings can flip it and TopTabs re-renders without a
 * reload. The terminal itself stays reachable (More ▾ → Terminal) while the
 * flag is on — dev sessions still live there.
 */

export const CHAT_SURFACE_KEY = 'exo-chat-surface';
export const CHAT_SURFACE_EVENT = 'exo:chat-surface';

// The stored value 'bots' predates the reading-room rename (07-24) — the
// persona concept ("bot") stays, so this on-disk/localStorage value is
// deliberately unchanged; only the exported function names below follow
// the rename.
export function chatSurfaceIsReadingRoom(): boolean {
  try {
    return localStorage.getItem(CHAT_SURFACE_KEY) === 'bots';
  } catch {
    return false;
  }
}

export function setChatSurfaceReadingRoom(on: boolean): void {
  try {
    localStorage.setItem(CHAT_SURFACE_KEY, on ? 'bots' : 'terminal');
  } catch {
    // storage denied — the event still flips this session
  }
  window.dispatchEvent(new CustomEvent(CHAT_SURFACE_EVENT, { detail: { bots: on } }));
}

export function useChatSurfaceReadingRoom(): boolean {
  const [on, setOn] = useState(chatSurfaceIsReadingRoom);
  useEffect(() => {
    const refresh = () => setOn(chatSurfaceIsReadingRoom());
    window.addEventListener(CHAT_SURFACE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHAT_SURFACE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return on;
}
