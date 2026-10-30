import { useEffect, useState } from 'react';

/**
 * chatSurface.ts — which surface the chat opens on: the observatory (the
 * default) or the tmux terminal. A localStorage flag with a change event, same
 * shape as usageHeat's, so Settings can flip it and the surfaces re-render
 * without a reload. The terminal stays reachable either way — dev sessions
 * still live there.
 *
 * It defaults to the OBSERVATORY, which is the reverse of how it started: the
 * terminal was the original chat and the observatory the newcomer, so an unset
 * flag used to mean terminal. It has since become the surface actually in use
 * ("i just use observatory now not terminal"), and a default that opens onto a
 * terminal she never wants is a default that's wrong on every fresh window and
 * every new device.
 */

export const CHAT_SURFACE_KEY = 'exo-chat-surface';
export const CHAT_SURFACE_EVENT = 'exo:chat-surface';

// The stored value 'bots' predates the observatory rename (07-24) — the
// persona concept ("bot") stays, so this on-disk/localStorage value is
// deliberately unchanged; only the exported function names below follow
// the rename.
export function chatSurfaceIsObservatory(): boolean {
  try {
    // Only an explicit 'terminal' turns this off — anything else, including
    // never having chosen, means the observatory.
    return localStorage.getItem(CHAT_SURFACE_KEY) !== 'terminal';
  } catch {
    return true;
  }
}

export function setChatSurfaceObservatory(on: boolean): void {
  try {
    localStorage.setItem(CHAT_SURFACE_KEY, on ? 'bots' : 'terminal');
  } catch {
    // storage denied — the event still flips this session
  }
  window.dispatchEvent(new CustomEvent(CHAT_SURFACE_EVENT, { detail: { bots: on } }));
}

export function useChatSurfaceObservatory(): boolean {
  const [on, setOn] = useState(chatSurfaceIsObservatory);
  useEffect(() => {
    const refresh = () => setOn(chatSurfaceIsObservatory());
    window.addEventListener(CHAT_SURFACE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHAT_SURFACE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return on;
}
