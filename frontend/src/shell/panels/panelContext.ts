import { createContext, useContext } from 'react';

/**
 * panelContext.ts — the one-line answer to "am I the whole window, or am I a
 * tile inside one?"
 *
 * Every page in this app renders under the router root (routes/__root.tsx),
 * and that root draws the app's furniture: the tab strip and the workspace
 * itself. A panel shows a page by running a SECOND router over the very same
 * route tree — which means without this flag the panel would draw the whole
 * app again inside itself, furniture and all, forever.
 *
 * So: the workspace wraps each route panel in this provider, and the root
 * checks it. Inside a panel, the root renders the page and nothing else.
 *
 * Touches: RoutePanel.tsx (provides it), routes/__root.tsx (reads it).
 */
export const InPanelContext = createContext(false);

/** True when the calling component is rendering inside a workspace panel
 *  rather than as the window's main content. */
export function useInPanel(): boolean {
  return useContext(InPanelContext);
}
