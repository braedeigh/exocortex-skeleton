import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getFrameWindows } from './frameStore';
import { TAB_ROUTES, isValidTab } from './tabs';

interface ShellMessage {
  type: string;
  [key: string]: unknown;
}

function isShellMessage(data: unknown): data is ShellMessage {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).type === 'string';
}

/** Forward a theme-changed payload to every mounted iframe except `exclude`. */
export function broadcastThemeChanged(overrides: unknown, exclude?: Window | null): void {
  for (const win of getFrameWindows().values()) {
    if (win === exclude) continue;
    try {
      win.postMessage({ type: 'theme-changed', overrides }, window.location.origin);
    } catch {
      // frame torn down mid-flight — ignore
    }
  }
}

/**
 * Same-origin postMessage bridge replicating split.html's cross-frame
 * contract (templates/split.html:909-1554), adapted to the SPA's
 * one-mounted-iframe-per-view model (frameStore.ts/FrameHost.tsx) instead of
 * split.html's single dashboard iframe with internal client-side tab
 * switching. Mount once, at the shell root (see routes/__root.tsx).
 */
export function useFrameBridge(): void {
  const navigate = useNavigate();

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (!isShellMessage(e.data)) return;
      const msg = e.data;

      switch (msg.type) {
        // A legacy tab's own in-page nav asks the shell to switch tabs
        // (static/js/core.js switchTab() -> window.parent.postMessage({type:'tab', name})).
        // Also accept 'switchTo' for robustness — split.html only ever sent
        // that one down to iframes, never received it, but the contract is
        // the same intent.
        case 'tab':
        case 'switchTo': {
          const name = typeof msg.name === 'string' ? msg.name : null;
          // Every dashboard tab is now a native SPA route.
          if (name && isValidTab(name)) {
            void navigate({ to: TAB_ROUTES[name] });
          }
          break;
        }

        // Relay to every other mounted iframe. The shell's own document
        // updates itself without any extra code here: sky-theme.js (loaded
        // via a <script> tag in index.html, unmodified) has its own
        // `window.addEventListener('message', ...)` listener and reacts to
        // this same event directly since it's registered on this window too.
        case 'theme-changed': {
          if (msg.overrides !== undefined) broadcastThemeChanged(msg.overrides, e.source as Window | null);
          break;
        }

        // journal-view asks the shell to open a file in the Files/keeper view
        // (templates/split.html:1491-1514 openKeeperFile, "open-keeper":
        // journal -> shell, "keeper-open": shell -> files iframe). FrameHost
        // keeps the files frame mounted once visited, so if it's already up
        // just relay 'keeper-open' straight to it; navigating there either
        // way lands the lazy src load (?/keeper) or brings the existing frame
        // to front.
        case 'open-keeper': {
          const path = typeof msg.path === 'string' ? msg.path : null;
          if (path) {
            const filesWin = getFrameWindows().get('files');
            if (filesWin) {
              try {
                filesWin.postMessage({ type: 'keeper-open', path }, window.location.origin);
              } catch {
                // ignore
              }
            }
            void navigate({ to: '/files' });
          }
          break;
        }

        // Todos-triage / research "open a terminal session" request
        // (templates/split.html:1538-1554). There is no native terminal
        // route in the SPA yet — stopgap until one exists: land on Today,
        // the tab triage was launched from.
        case 'openTerminalSession': {
          void navigate({ to: '/todos' });
          break;
        }

        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);
}
