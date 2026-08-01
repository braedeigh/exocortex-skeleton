import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { getSessions } from '../features/observatory/api';

/**
 * paneHistory.ts — where the desktop split's LEFT pane is, and how it gets
 * back to where it was.
 *
 * Before this, the pane's position was split across two components: whether
 * the roster or a conversation was showing lived in SplitLayout, and WHICH
 * conversation lived inside KeeperPane. Nothing could go "back", because no
 * single place knew the whole answer. This file holds that whole answer as one
 * value — a PaneLocation — and keeps a stack of them.
 *
 * A location is two things: roster-or-conversation, and which conversation.
 * Deliberately NOT included: terminal-vs-observatory. That one is a saved
 * preference shared with the phone (chatSurface.ts), not a place you travel
 * to — folding it in would mean a back gesture silently rewriting a Settings
 * value. Switching to the Terminal tab therefore isn't a step you can go back
 * from; the pane's history is the observatory's own.
 *
 * WHO PUSHES. Every way the pane moves: the two observatory tabs in
 * SplitLayout, a card tapped in the roster, a conversation the room itself
 * opens (a fresh compose's first send, a rollover), and a conversation pushed
 * in from the right half of the split by the terrain map (paneConversation.ts).
 * They all land here, and because the location carries both fields, opening a
 * conversation from the roster and opening one from inside the room are now
 * literally the same call.
 *
 * WHICH CONVERSATION IT OPENS ON. Same rule the routed page uses for
 * `?conv=latest`: the pinned Keeper session, else the newest, else a fresh
 * compose. That resolution used to live in KeeperPane, which held the id; it
 * moved here with the id. It only ever FILLS IN — a location that already
 * names a conversation is left alone, so a push that lands while the fetch is
 * in flight still wins.
 *
 * Touches: SplitLayout.tsx (owns the hook), KeeperPane.tsx (renders the
 * location it's handed), usePaneSwipeBack.ts (drives `back`).
 *
 * Prompt that produced it: "is it possible to make the back button on the page
 * go back on either the left or the right side of the split screen depending
 * on which you are hovering over" — the left half of that, which needed a
 * left-pane history before it could have a back at all.
 */

export type PaneLocation = {
  /** true = the roster (the Observatory in general), false = the open conversation. */
  roster: boolean;
  /** undefined = the default is still resolving; null = "no sessions, compose fresh". */
  conv: string | null | undefined;
};

/** Long enough that a real afternoon of reading never hits it, short enough
 * that a stuck loop can't grow the array without bound. */
const MAX_DEPTH = 30;

/* The three stack moves are plain functions rather than logic buried in the
   hook, so they can be tested without rendering anything — see
   paneHistory.test.ts. Each returns the SAME array when nothing changed, which
   is what keeps React from re-rendering the pane on a no-op. */

/** Go somewhere. Omitted fields keep their current value, and arriving where
 * you already are is a no-op — otherwise tapping a tab twice would stack two
 * identical entries and the first ‹ would look broken. */
export function pushLocation(
  stack: readonly PaneLocation[],
  next: { roster?: boolean; conv?: string | null },
): PaneLocation[] {
  const cur = stack[stack.length - 1];
  const loc: PaneLocation = {
    roster: next.roster ?? cur.roster,
    conv: 'conv' in next ? next.conv : cur.conv,
  };
  if (loc.roster === cur.roster && loc.conv === cur.conv) return stack as PaneLocation[];
  const grown = [...stack, loc];
  return grown.length > MAX_DEPTH ? grown.slice(grown.length - MAX_DEPTH) : grown;
}

/** Step back one. The first entry is the floor — the pane always has to be
 * somewhere. */
export function popLocation(stack: readonly PaneLocation[]): PaneLocation[] {
  return stack.length > 1 ? stack.slice(0, -1) : (stack as PaneLocation[]);
}

/** Complete the entries that never got an opening conversation. Only ever
 * FILLS IN: a location that already names one was chosen by something, and
 * that choice outranks a fetch that was in flight at the time. */
export function fillPending(stack: readonly PaneLocation[], id: string | null): PaneLocation[] {
  if (!stack.some((l) => l.conv === undefined)) return stack as PaneLocation[];
  return stack.map((l) => (l.conv === undefined ? { ...l, conv: id } : l));
}

export function useLeftPaneHistory(enabled: boolean): {
  here: PaneLocation;
  /** Go somewhere. Omitted fields keep their current value; pushing the place
   * you're already standing is a no-op, so tapping a tab twice doesn't stack. */
  push: (next: { roster?: boolean; conv?: string | null }) => void;
  back: () => void;
  canGoBack: boolean;
  /** Read the same flag from inside an event handler that was bound once —
   * the DOM listener in usePaneSwipeBack outlives any single render. */
  canGoBackRef: RefObject<boolean>;
} {
  const [stack, setStack] = useState<PaneLocation[]>([{ roster: true, conv: undefined }]);
  const here = stack[stack.length - 1];
  const canGoBack = stack.length > 1;

  const canGoBackRef = useRef(canGoBack);
  canGoBackRef.current = canGoBack;

  // Resolves the opening conversation, once.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fill = (id: string | null) => {
      if (!cancelled) setStack((prev) => fillPending(prev, id));
    };
    getSessions()
      .then(({ sessions }) => fill(sessions.find((s) => s.pinned)?.id ?? sessions[0]?.id ?? null))
      // Roster unreachable — a fresh compose still works, and its first send
      // creates the session.
      .catch(() => fill(null));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const push = useCallback((next: { roster?: boolean; conv?: string | null }) => {
    setStack((prev) => pushLocation(prev, next));
  }, []);

  const back = useCallback(() => {
    setStack(popLocation);
  }, []);

  return useMemo(
    () => ({ here, push, back, canGoBack, canGoBackRef }),
    [here, push, back, canGoBack],
  );
}
