import { useEffect, useRef, useState } from 'react';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '../../routeTree.gen';
import { InPanelContext } from './panelContext';
import { intentKindsForUrl, urlForIntent } from './panelIntents';
import { registerIntentTarget, type IntentKind } from './windowBus';
import styles from './RoutePanel.module.css';

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

  /* The subscription below and the intent target further down are both bound
     once and outlive many renders, so neither can close over `url` or
     `onUrlChange` directly — it would freeze whatever those were on the tile's
     first render. They read these refs instead, which are rewritten every
     render and are therefore always current. */
  const latest = useRef({ url, onUrlChange });
  latest.current = { url, onUrlChange };

  // Page moved itself (a link, a redirect) — tell the workspace so the
  // arrangement remembers where this tile actually ended up.
  useEffect(() => {
    return router.subscribe('onResolved', () => {
      const href = router.state.location.href;
      if (href !== latest.current.url) latest.current.onUrlChange(href);
    });
  }, [router]);

  // Picker moved the tile — follow it.
  useEffect(() => {
    if (router.state.location.href !== url) void router.navigate({ to: url });
  }, [router, url]);

  /**
   * This tile catches things, if the page it's showing is the kind of page
   * that should — a code tile catches code files, an observatory tile catches
   * conversations (panelIntents.ts). Catching one just points the tile
   * somewhere new, which is the same move the picker makes.
   *
   * Re-registering when the accepted kinds change is what makes a tile stop
   * catching code the moment you point it at the journal.
   */
  const accepts = intentKindsForUrl(url);
  const acceptsKey = accepts.join(',');
  const bumpRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!acceptsKey) return;
    const { unregister, bump } = registerIntentTarget(acceptsKey.split(',') as IntentKind[], (intent) => {
      const next = urlForIntent(intent);
      if (next) latest.current.onUrlChange(next);
    });
    bumpRef.current = bump;
    return () => {
      bumpRef.current = () => {};
      unregister();
    };
  }, [acceptsKey]);

  return (
    <InPanelContext.Provider value={true}>
      {/* Touching a tile makes it the one that catches the next thing. Capture
          phase, so it counts even when the click lands on something inside the
          page that stops the event — and pointerdown rather than focus,
          because scrolling or clicking dead space in a tile still means "this
          is the one I'm working in". */}
      <div className={styles.host} onPointerDownCapture={() => bumpRef.current()}>
        <RouterProvider router={router} />
      </div>
    </InPanelContext.Provider>
  );
}
