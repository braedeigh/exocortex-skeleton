import { useEffect, useState } from 'react';

/**
 * chatSurface.ts — which surface the mobile Chat tab opens: the tmux
 * terminal (/chat, the default) or the Keeper bot's reading room
 * (/bots/keeper — bot-surface-design, "wanting it to replace the terminal").
 * A localStorage flag with a change event, same shape as usageHeat's, so
 * Settings can flip it and TopTabs re-renders without a reload. The terminal
 * itself stays reachable (More ▾ → Terminal) while the flag is on — dev
 * sessions still live there.
 */

export const CHAT_SURFACE_KEY = 'exo-chat-surface';
export const CHAT_SURFACE_EVENT = 'exo:chat-surface';

export function chatSurfaceIsBots(): boolean {
  try {
    return localStorage.getItem(CHAT_SURFACE_KEY) === 'bots';
  } catch {
    return false;
  }
}

export function setChatSurfaceBots(on: boolean): void {
  try {
    localStorage.setItem(CHAT_SURFACE_KEY, on ? 'bots' : 'terminal');
  } catch {
    // storage denied — the event still flips this session
  }
  window.dispatchEvent(new CustomEvent(CHAT_SURFACE_EVENT, { detail: { bots: on } }));
}

export function useChatSurfaceBots(): boolean {
  const [on, setOn] = useState(chatSurfaceIsBots);
  useEffect(() => {
    const refresh = () => setOn(chatSurfaceIsBots());
    window.addEventListener(CHAT_SURFACE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHAT_SURFACE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return on;
}
