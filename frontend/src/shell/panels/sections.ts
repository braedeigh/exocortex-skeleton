import { TAB_ROUTES, VALID_TABS } from '../tabs';

/**
 * sections.ts — what a tab stands for.
 *
 * A tab isn't a page, it's a SECTION: a family of pages with one front page
 * you can always get back to. The Observatory tab covers the roster and every
 * conversation under it; its front page is the roster. That's what makes the
 * rule work — a tab names its section, except the one you're currently inside,
 * which names what you're actually looking at, and clicking that one takes you
 * back up to the front page.
 *
 * WHICH SECTION A PAGE BELONGS TO is decided by longest match, not first
 * match. /terrain/pond has to land on Pond even though Terrain also claims
 * /terrain — and it does, because Pond's claim is longer. Getting this
 * backwards would make the Pond tab impossible to ever show as active.
 *
 * WHEN TWO CLAIMS ARE THE SAME LENGTH, the one listed first wins. That's why
 * Ecosystem, Kitchen and Money sit ABOVE Dashboard below: each shares an exact
 * claim with Dashboard, and if Dashboard came first their tabs could never light up. Move it and
 * sections.test.ts will say so.
 *
 * A section with NO claims is a pure shortcut: it can be pinned and clicked,
 * but it never lights up. The Keeper is one — it's a particular conversation
 * inside the Observatory rather than a place of its own, so while you're
 * reading it the tab that's active is Observatory, wearing that conversation's
 * name.
 *
 * Touches: tabSets.ts (which sections a bar holds), TabBar.tsx (draws them),
 * routes/tabsets.py (stores the ids, and never interprets them — adding a
 * section is a change to this file alone).
 */

export interface Section {
  id: string;
  label: string;
  icon: string;
  /** Where the tab goes: the section's front page. */
  home: string;
  /** Path prefixes this section owns. Empty = a shortcut that never lights up. */
  claims: string[];
}

export const SECTIONS: Section[] = [
  { id: 'observatory', label: 'Observatory', icon: '🔭', home: '/observatory', claims: ['/observatory'] },
  // A conversation, not a place — see the header note on shortcuts.
  // `?conv=latest` resolves to the pinned Keeper session server-side.
  { id: 'keeper', label: 'Keeper', icon: '🕯', home: '/observatory/session?conv=latest', claims: [] },
  { id: 'research', label: 'Research', icon: '🔎', home: '/research/claims', claims: ['/research'] },
  { id: 'terrain', label: 'Terrain', icon: '🗺', home: '/terrain/files', claims: ['/terrain'] },
  { id: 'pond', label: 'Pond', icon: '🐟', home: '/terrain/pond', claims: ['/terrain/pond'] },
  { id: 'flow', label: 'Flow', icon: '🫧', home: '/terrain/flow', claims: ['/terrain/flow'] },
  { id: 'workshop', label: 'Workshop', icon: '🛠', home: '/terrain/workshop', claims: ['/terrain/workshop'] },
  { id: 'activity', label: 'Activity', icon: '🧾', home: '/terrain/activity', claims: ['/terrain/activity'] },
  { id: 'journal', label: 'Journal', icon: '📓', home: '/journal', claims: ['/journal'] },
  // The Food area — the map, every food, one food's page, the review list —
  // as one tab. Its id stays 'ecosystem' because saved tab sets store it.
  // Has to stay ahead of Dashboard, which claims /food too (see the header);
  // /ecosystem is still claimed because it redirects here.
  // Prompts: "i want to be able to access my ecosystem map on my tabs on the
  // right side of the split screen"; then "remaking the frontend to be in one
  // place" — the map, food profiles and research as one Food area.
  { id: 'ecosystem', label: 'Food', icon: '🌱', home: '/food', claims: ['/food', '/ecosystem'] },
  // Kitchen, promoted the same way and for the same reason — it has to stay
  // ahead of Dashboard too. Prompt: "currently can't see my kitchen view from
  // the desktop. add a tab to the desktop please such that i can click into it
  // from there"
  { id: 'kitchen', label: 'Kitchen', icon: '🍳', home: '/kitchen', claims: ['/kitchen'] },
  // Money, promoted the same way — ahead of Dashboard for the same reason.
  // Prompt: "add my money tab to my dropdown menu on desktop"
  { id: 'money', label: 'Money', icon: '💰', home: '/money', claims: ['/money'] },
  // The dashboard is fifteen routes wearing one name (tabs.ts), and its own
  // sub-tab row is how you move between them. Ecosystem, Kitchen and Money are
  // claimed above too; they stay in this list so the Dashboard's sub-tab row still works there.
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: '☀',
    home: '/todos',
    claims: VALID_TABS.map((t) => TAB_ROUTES[t]),
  },
  { id: 'code', label: 'Code', icon: '📄', home: '/code', claims: ['/code'] },
  { id: 'threads', label: 'Threads', icon: '🧵', home: '/threads', claims: ['/threads'] },
  { id: 'transcripts', label: 'Transcripts', icon: '💬', home: '/transcripts', claims: ['/transcripts'] },
  { id: 'notes', label: 'Notes', icon: '📝', home: '/notes', claims: ['/notes'] },
  { id: 'files', label: 'Files', icon: '🗂️', home: '/files', claims: ['/files'] },
  { id: 'scratchpad', label: 'Scratchpad', icon: '✏️', home: '/scratchpad', claims: ['/scratchpad'] },
  { id: 'sql', label: 'SQL lab', icon: '🗃', home: '/sql', claims: ['/sql'] },
  { id: 'recordings', label: 'Recordings', icon: '🎙️', home: '/recordings', claims: ['/recordings'] },
  { id: 'build', label: 'Build', icon: '🔨', home: '/build', claims: ['/build'] },
  { id: 'settings', label: 'Settings', icon: '⚙️', home: '/settings', claims: ['/settings'] },
];

export function sectionById(id: string): Section | undefined {
  return SECTIONS.find((s) => s.id === id);
}

/** Strip the query and any trailing slash — everything here matches on path. */
export function pathOf(url: string): string {
  return url.split('?')[0].replace(/\/$/, '') || '/';
}

/** True when `path` is inside `claim` — the claim itself, or a page under it.
 *  The boundary check is what stops /codex being counted as part of /code. */
function owns(claim: string, path: string): boolean {
  return path === claim || path.startsWith(claim + '/');
}

/** Which section this page belongs to. Longest claim wins (see the header). */
export function sectionForUrl(url: string): Section | null {
  const path = pathOf(url);
  let best: Section | null = null;
  let bestLen = -1;
  for (const s of SECTIONS) {
    for (const claim of s.claims) {
      if (owns(claim, path) && claim.length > bestLen) {
        best = s;
        bestLen = claim.length;
      }
    }
  }
  return best;
}

/**
 * The best name for the page itself, without asking the server anything.
 *
 * Used for the active tab, which wears where you actually are rather than the
 * section's name. A file gets its filename; anything the URL can't describe
 * falls back to the section. A conversation is the case the URL genuinely
 * can't answer — TabBar fills that one in from the roster it already has
 * loaded, and until then this is what shows.
 */
export function pageLabel(url: string): string {
  const path = pathOf(url);
  const section = sectionForUrl(url);

  if (path === '/code') {
    const file = new URLSearchParams(url.split('?')[1] ?? '').get('path');
    if (file) return file.split('/').filter(Boolean).pop() ?? file;
  }
  if (section) {
    // Sitting on the front page — the section's own name is the right answer.
    if (pathOf(section.home) === path) return section.label;
    // A named room under a section (/terrain/usage, /observatory/archive).
    const tail = path.slice(pathOf(section.claims[0] ?? '').length).replace(/^\//, '');
    const first = tail.split('/')[0];
    if (first && !first.startsWith('$')) {
      return first.charAt(0).toUpperCase() + first.slice(1);
    }
    return section.label;
  }
  const last = path.split('/').filter(Boolean).pop();
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : 'Page';
}

/** The conversation this url is showing, if it is showing one. TabBar swaps
 *  the roster's title in for it. */
export function convIdOf(url: string): string | null {
  if (!pathOf(url).startsWith('/observatory/')) return null;
  const conv = new URLSearchParams(url.split('?')[1] ?? '').get('conv');
  return conv && conv !== 'latest' ? conv : null;
}
