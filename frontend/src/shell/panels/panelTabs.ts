/**
 * panelTabs.ts — the things a panel has open, as data.
 *
 * A panel's tab bar is two groups, always in this order:
 *
 *   ANCHORS   the pinned sections (tabSets.ts) — always there, at the left
 *   OPEN      what she opened herself, in the order she arranged them
 *
 * THEY WORK LIKE BROWSER TABS. Arriving somewhere opens a tab for it
 * (Workspace.tsx rememberArrival). A tab stays until she closes it with its ×,
 * however long it sits there. Closing a tab closes the VIEW — a session behind
 * it keeps running and stays in the Observatory, and opening it again brings
 * the tab back.
 *
 * NOTHING APPEARS ON ITS OWN. A session that is running or waiting on her but
 * that she hasn't opened gets nothing on the bar — the roster is where those
 * show. A session she HAS opened still wears its state: its tab breathes
 * purple while it runs and turns amber while it waits on her. That state is
 * looked up from the roster every render (useLiveSessions.ts), never stored.
 *
 * Only the open list is saved (with the layout, per window — layoutTree.ts),
 * so tab order survives a reload.
 *
 * Everything here is pure and returns the SAME array when nothing changed, so
 * a poll that finds no news can't cause a re-render (panelTabs.test.ts).
 *
 * Touches: TabBar.tsx (draws these), layoutTree.ts (stores the open ones and
 * moves one between panels), Workspace.tsx (opens them), sections.ts (what a
 * url means).
 *
 * Prompt that produced it: "function basically like a browser tab except
 * clicking the x button doesn't close the actual session. i want to be able to
 * drag to rearrange them and i want it to automatically place those that i
 * open up there, but don't place them up there until i open it again."
 */

import { sectionForUrl } from './sections';

/** Something she opened. `at` is when she last arrived at it. Nothing reads
 *  it to decide what shows any more; it rides along in saved layouts. */
export interface OpenTab {
  url: string;
  at: number;
}

/** What a session's tab knows about the session behind it. */
export interface SessionState {
  /** A turn is executing right now. */
  running: boolean;
  /** It stopped and asked her something. */
  awaiting: boolean;
}

/* ---------- the open ones ---------- */

/** Open `url`, or mark it as just-used if it's already open. An open tab keeps
 *  its place — the bar doesn't rearrange itself because she looked at
 *  something; only her dragging moves a tab. */
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

export function isOpen(tabs: OpenTab[], url: string): boolean {
  return tabs.some((t) => t.url === url);
}

/** Drag one open tab to another position. Same contract as tabSets.reorder:
 *  out-of-range indexes are ignored rather than clamped, so a drop that landed
 *  nowhere leaves the bar alone. */
export function moveTab(tabs: OpenTab[], from: number, to: number): OpenTab[] {
  const n = tabs.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Where to go when the tab she's on is closed: the tab to its right, else the
 * one to its left, else null — the browser's rule. On null the caller falls
 * back to the section's front page (fallbackAfterClose).
 */
export function neighbourAfterClose(tabs: OpenTab[], url: string): string | null {
  const i = tabs.findIndex((t) => t.url === url);
  if (i === -1) return null;
  return tabs[i + 1]?.url ?? tabs[i - 1]?.url ?? null;
}

/** Where a panel goes when the tab it was showing is closed and no tab is
 *  left beside it: the front page of that tab's section, else the app's
 *  front page. Never the closed url itself, so the view really leaves. */
export function fallbackAfterClose(url: string): string {
  return sectionForUrl(url)?.home ?? '/';
}

/* ---------- putting the bar together ---------- */

export type BarItem =
  | { kind: 'anchor'; sectionId: string }
  | { kind: 'open'; url: string; running: boolean; awaiting: boolean };

/**
 * The bar, in order: anchors, then every open tab.
 *
 * `stateFor` is injected rather than imported so this stays a pure function
 * of its inputs — it answers "is the session behind this url running or
 * waiting?", and null for anything that isn't a live session.
 */
export function buildBar(args: {
  anchors: string[];
  open: OpenTab[];
  stateFor: (url: string) => SessionState | null;
}): BarItem[] {
  const { anchors, open, stateFor } = args;
  const openItems: BarItem[] = open.map((t) => {
    const state = stateFor(t.url);
    return { kind: 'open', url: t.url, running: state?.running ?? false, awaiting: state?.awaiting ?? false };
  });
  return [...anchors.map((sectionId): BarItem => ({ kind: 'anchor', sectionId })), ...openItems];
}

/** Every url the bar shows as an open tab. */
export function urlsOnBar(items: BarItem[]): string[] {
  return items.flatMap((i) => (i.kind === 'anchor' ? [] : [i.url]));
}
