/**
 * panelTabs.ts — the things a panel has open, as data.
 *
 * A panel's tab bar is three groups, in this order and always in this order so
 * the live things never move around under her:
 *
 *   ANCHORS   the pinned sections (tabSets.ts) — always there, never age out
 *   LIVE      sessions working right now, or stopped and waiting on her
 *   OPEN      things she opened herself, while they're still recent
 *
 * WHAT AGEING OUT MEANS, exactly. An open tab she hasn't touched in an hour
 * drops off the bar. It does NOT end the session, and the session doesn't
 * leave the Observatory — the tab is a view, and only the view goes. Clicking
 * it in the roster brings it straight back. That's what keeps the bar honest
 * without her ever tidying it: "anything I've been ignoring drops from the
 * tabs until I interact with it again."
 *
 * LIVE TABS ARE NOT STORED. They're computed from the roster every render, so
 * a session that starts appears on its own and one that finishes stops being
 * live without anything here having to be told. Only the OPEN ones are hers to
 * keep, so only those are saved.
 *
 * A session that is both open and live appears ONCE, in the live group — two
 * tabs for one conversation would be two mounted views of it, which is exactly
 * the thing queueOwner.ts had to be written for.
 *
 * Everything here is pure and returns the SAME array when nothing changed, so
 * a poll that finds no news can't cause a re-render (panelTabs.test.ts).
 *
 * Touches: TabBar.tsx (draws these), layoutTree.ts (stores the open ones),
 * sections.ts (what a url means).
 *
 * Prompt that produced it: "i want tabs for open and running both... the open
 * ones that have been used in the past hour to also display... anything that
 * i've been ignoring just drops from the tabs until i interact with it again.
 * it doesn't close in the observatory, just in the tabs up top."
 */

/** How long an untouched open tab stays on the bar. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/** Something she opened. `at` is when she last had it in front of her. */
export interface OpenTab {
  url: string;
  at: number;
}

/** What a live tab knows about itself. */
export interface LiveTab {
  convId: string;
  title: string;
  /** A turn is executing right now. */
  running: boolean;
  /** It stopped and asked her something — grouped with live, coloured apart. */
  awaiting: boolean;
}

/* ---------- the open ones ---------- */

/** Open `url`, or mark it as just-used if it's already open. Moving an
 *  existing tab to the front of nothing — order is by when it was opened, not
 *  by recency, so the bar doesn't rearrange itself while she reads. */
export function openTab(tabs: OpenTab[], url: string, now: number): OpenTab[] {
  const i = tabs.findIndex((t) => t.url === url);
  if (i === -1) return [...tabs, { url, at: now }];
  if (tabs[i].at === now) return tabs;
  const next = [...tabs];
  next[i] = { ...next[i], at: now };
  return next;
}

export function closeTab(tabs: OpenTab[], url: string): OpenTab[] {
  const next = tabs.filter((t) => t.url !== url);
  return next.length === tabs.length ? tabs : next;
}

/**
 * She's looking at it — restart its hour.
 *
 * Only for a tab that is ALREADY open: touching is not opening. Conflating the
 * two meant that merely rendering the bar, which touches whatever the panel is
 * showing, opened a tab for it — including for a section's own front page,
 * which then sat beside its own anchor saying the same word twice.
 */
export function touchTab(tabs: OpenTab[], url: string, now: number): OpenTab[] {
  const i = tabs.findIndex((t) => t.url === url);
  if (i === -1 || tabs[i].at === now) return tabs;
  const next = [...tabs];
  next[i] = { ...next[i], at: now };
  return next;
}

/**
 * Drop what she's been ignoring.
 *
 * `keep` is spared whatever its age: it holds the url the panel is actually
 * showing, and the sessions that are live. Ageing out the page in front of her
 * because she read it for an hour without clicking would be absurd, and a live
 * session is by definition not being ignored.
 */
export function pruneStale(
  tabs: OpenTab[],
  now: number,
  keep: ReadonlySet<string>,
  maxAgeMs = STALE_AFTER_MS,
): OpenTab[] {
  const next = tabs.filter((t) => keep.has(t.url) || now - t.at < maxAgeMs);
  return next.length === tabs.length ? tabs : next;
}

export function isOpen(tabs: OpenTab[], url: string): boolean {
  return tabs.some((t) => t.url === url);
}

/* ---------- putting the bar together ---------- */

export type BarItem =
  | { kind: 'anchor'; sectionId: string }
  | { kind: 'live'; convId: string; url: string; title: string; running: boolean; awaiting: boolean }
  | { kind: 'open'; url: string };

/**
 * The bar, in order: anchors, then live, then whatever's open and recent that
 * isn't already showing as live.
 *
 * `liveUrlFor` is injected rather than imported so this stays a pure function
 * of its inputs — the url shape for a conversation lives in one place
 * (sections/panelIntents) and this file doesn't need a second opinion on it.
 */
export function buildBar(args: {
  anchors: string[];
  live: LiveTab[];
  open: OpenTab[];
  now: number;
  liveUrlFor: (convId: string) => string;
  maxAgeMs?: number;
}): BarItem[] {
  const { anchors, live, open, now, liveUrlFor, maxAgeMs = STALE_AFTER_MS } = args;

  const liveItems: BarItem[] = live.map((l) => ({
    kind: 'live',
    convId: l.convId,
    url: liveUrlFor(l.convId),
    title: l.title,
    running: l.running,
    awaiting: l.awaiting,
  }));
  const liveUrls = new Set(liveItems.map((i) => (i.kind === 'live' ? i.url : '')));

  const openItems: BarItem[] = open
    .filter((t) => !liveUrls.has(t.url) && now - t.at < maxAgeMs)
    .map((t) => ({ kind: 'open', url: t.url }));

  return [...anchors.map((sectionId): BarItem => ({ kind: 'anchor', sectionId })), ...liveItems, ...openItems];
}

/** Every url the bar is currently showing — what has to stay mounted, and what
 *  pruning must spare. */
export function urlsOnBar(items: BarItem[]): string[] {
  return items.flatMap((i) => (i.kind === 'anchor' ? [] : [i.url]));
}
