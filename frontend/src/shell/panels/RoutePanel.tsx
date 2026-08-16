import { useEffect, useState } from 'react';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '../../routeTree.gen';
import { InPanelContext } from './panelContext';

/**
 * RoutePanel.tsx — one tile showing any page in the app.
 *
 * THE TRICK, in plain English. A browser window can only be at one address at
 * a time, which is why the old split could never show the terrain map and a
 * code file side by side: both are pages, and a window has one address. This
 * component gives the tile its OWN private address bar — an in-memory one that
 * the browser never sees — so it can sit at a different page than the rest of
 * the window. Every existing page works here unchanged; none of them had to be
 * rewritten to become a panel.
 *
 * The private router runs the same route tree as the real one, so anything
 * reachable by URL is reachable in a tile.
 *
 * WHY THE ROUTER IS BUILT ONCE. It's created in a useState initializer, not on
 * every render, because rebuilding it would throw away the page's scroll,
 * its form state, and any request in flight. Pointing the tile somewhere new
 * NAVIGATES the existing router instead (the effect below).
 *
 * THE ADDRESS GOES BOTH WAYS. Links inside the page move the private router,
 * and the tile has to notice so the arrangement can be saved and reopened at
 * the same place — that's the subscription. And the picker in the tile header
 * moves the tree, which the tile has to follow — that's the navigate. Both
 * compare the address as a string first, so they can't chase each other in a
 * loop.
 *
 * Touches: panelContext.ts (stops the app re-drawing itself inside the tile),
 * routes/__root.tsx (obeys that flag), PanelFrame.tsx (the chrome around it).
 */
export function RoutePanel({ url, onUrlChange }: { url: string; onUrlChange: (url: string) => void }) {
  const [router] = useState(() =>
    createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [url] }),
      // A tile is a viewport of its own; letting it also drive the window's
      // scroll position would yank the other tiles around.
      scrollRestoration: false,
    }),
  );

  // Page moved itself (a link, a redirect) — tell the workspace so the
  // arrangement remembers where this tile actually ended up.
  useEffect(() => {
    const unsub = router.subscribe('onResolved', () => {
      const href = router.state.location.href;
      if (href !== url) onUrlChange(href);
    });
    return unsub;
    // `url` and `onUrlChange` are read live inside the callback; re-subscribing
    // on every address change would tear down and rebuild the subscription for
    // no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Picker moved the tile — follow it.
  useEffect(() => {
    if (router.state.location.href !== url) void router.navigate({ to: url });
  }, [router, url]);

  return (
    <InPanelContext.Provider value={true}>
      <RouterProvider router={router} />
    </InPanelContext.Provider>
  );
}
