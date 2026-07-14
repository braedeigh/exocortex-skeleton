// rosterLogic.ts — the pure client-side brains of the People tab, ported 1:1
// from static/js/people.js (binning / sorting / filtering, relative labels,
// localStorage persistence). The server just hands over each person's entry
// dates + latest note; everything below is a client concept.

import type { RosterPerson, SortMode, TierKey } from './types';

export const SORT_CYCLE: readonly SortMode[] = ['recent', 'most', 'alpha'];
export const SORT_LABELS: Record<SortMode, string> = {
  recent: 'Recent',
  most: 'Most mentioned',
  alpha: 'A–Z',
};

export const TIER_ORDER: readonly TierKey[] = ['week', 'month', 'earlier', 'quiet', 'none'];
export const TIER_LABEL: Record<TierKey, string> = {
  week: 'This week',
  month: 'This month',
  earlier: 'Earlier',
  quiet: 'Quiet',
  none: 'No mentions yet',
};

/** Sentinel "tag" for people with no tags at all (the Untagged chip). */
export const UNTAGGED = '__untagged__';

/** The sort chip cycles recent → most → alpha → recent. */
export function nextSort(sort: SortMode): SortMode {
  const idx = SORT_CYCLE.indexOf(sort);
  return SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
}

/** "Mon YYYY" — e.g. "Feb 2026". */
export function monthYear(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** "Mon D" — e.g. "Jun 2". */
export function monthDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function daysSince(dateStr: string, now: Date): number {
  const d = new Date(dateStr + 'T12:00:00');
  return Math.floor((now.getTime() - d.getTime()) / 86400000);
}

/** "3d", "2w", "4mo", "1y" — coarser as the gap grows, same spirit as
 * GitHub's relative timestamps. */
export function relLabel(days: number): string {
  if (days <= 0) return 'today';
  if (days < 7) return days + 'd';
  if (days < 31) return Math.max(1, Math.round(days / 7)) + 'w';
  if (days < 365) return Math.max(1, Math.round(days / 30)) + 'mo';
  return Math.max(1, Math.round(days / 365)) + 'y';
}

export function lastDateOf(p: RosterPerson): string | null {
  return p.dates.length ? p.dates[p.dates.length - 1] : null;
}

/** Every tag across the roster, lowercased, deduped, sorted. */
export function computeAllTags(people: readonly RosterPerson[]): string[] {
  const set = new Set<string>();
  people.forEach((p) => (p.tags || []).forEach((t) => set.add(t.toLowerCase())));
  return [...set].sort();
}

/** No selection = everyone. Tagless people only match via the Untagged
 * sentinel; otherwise any-of over the person's lowercased tags. */
export function matchesTags(p: RosterPerson, selected: ReadonlySet<string>): boolean {
  if (!selected.size) return true;
  const tags = (p.tags || []).map((t) => t.toLowerCase());
  if (!tags.length) return selected.has(UNTAGGED);
  return tags.some((t) => selected.has(t));
}

/** Tag-filter then sort. 'alpha' = name; 'most' = mention-day count desc,
 * name tiebreak; 'recent' = last mention date desc, dateless people last,
 * name tiebreak. */
export function filterAndSort(
  people: readonly RosterPerson[],
  sort: SortMode,
  selected: ReadonlySet<string>,
): RosterPerson[] {
  const list = people.filter((p) => matchesTags(p, selected));
  if (sort === 'alpha') {
    return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sort === 'most') {
    return list.slice().sort((a, b) => b.dates.length - a.dates.length || a.name.localeCompare(b.name));
  }
  return list.slice().sort((a, b) => {
    const ad = lastDateOf(a);
    const bd = lastDateOf(b);
    if (!ad && !bd) return a.name.localeCompare(b.name);
    if (!ad) return 1;
    if (!bd) return -1;
    if (ad === bd) return a.name.localeCompare(b.name);
    return bd.localeCompare(ad); // newest first — ISO dates compare lexically
  });
}

/** Recency bins for the 'recent' sort: ≤7 days this week, ≤31 this month,
 * ≤90 earlier, older quiet, never-mentioned none. Preserves list order
 * within each bin (the list is already recency-sorted). */
export function binByRecency(list: readonly RosterPerson[], now: Date): Record<TierKey, RosterPerson[]> {
  const groups: Record<TierKey, RosterPerson[]> = { week: [], month: [], earlier: [], quiet: [], none: [] };
  list.forEach((p) => {
    const last = lastDateOf(p);
    if (!last) {
      groups.none.push(p);
      return;
    }
    const days = daysSince(last, now);
    if (days <= 7) groups.week.push(p);
    else if (days <= 31) groups.month.push(p);
    else if (days <= 90) groups.earlier.push(p);
    else groups.quiet.push(p);
  });
  return groups;
}

/** "12 days · since Feb 2026" — the expanded row's stats line. */
export function statsLine(p: RosterPerson): string {
  if (!p.dates.length) return '';
  const n = p.dates.length;
  return `${n} day${n === 1 ? '' : 's'} · since ${monthYear(p.dates[0])}`;
}

// --- localStorage persistence: same keys as the old page, so sort/filter
// state carries straight over from the legacy tab. ---

const SORT_KEY = 'peopleRosterSort';
const TAGS_KEY = 'peopleRosterTags';

export function readStoredSort(): SortMode {
  try {
    const s = localStorage.getItem(SORT_KEY);
    if (s && (SORT_CYCLE as readonly string[]).includes(s)) return s as SortMode;
  } catch {
    // localStorage unavailable — fall through to the default
  }
  return 'recent';
}

export function writeStoredSort(sort: SortMode): void {
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // sort just won't persist across visits
  }
}

export function readStoredTags(): Set<string> {
  try {
    const t: unknown = JSON.parse(localStorage.getItem(TAGS_KEY) || '[]');
    if (Array.isArray(t)) return new Set(t.filter((x): x is string => typeof x === 'string'));
  } catch {
    // bad JSON / localStorage unavailable — start unfiltered
  }
  return new Set();
}

export function writeStoredTags(tags: ReadonlySet<string>): void {
  try {
    localStorage.setItem(TAGS_KEY, JSON.stringify([...tags]));
  } catch {
    // filters just won't persist across visits
  }
}

/** Roster previews render as plain text, but blurbs/notes are authored in
 * markdown — strip inline syntax so one-liners don't show raw ** and [](). */
export function stripInlineMd(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/([*_])([^*_]+)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1');
}
