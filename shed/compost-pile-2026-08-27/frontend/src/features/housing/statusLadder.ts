/**
 * statusLadder.ts — pure logic for the housing status ladder.
 *
 * Port of the constants at the top of static/js/housing.js (HOUSING_STATUSES,
 * HOUSING_STATUS_COLOR, _HOUSING_RANK), kept in one place so the ladder
 * order, labels, accent colors and display ranking can't drift apart.
 * Backend source of truth for valid values: routes/housing.py STATUSES.
 */

/** Ladder in progression order — found → … → got_it. */
export const HOUSING_STATUSES = [
  'found',
  'contacted',
  'touring',
  'toured',
  'applied',
  'passed',
  'got_it',
] as const;

export type HousingStatus = (typeof HOUSING_STATUSES)[number];

/** Dropdown options in ladder order; only got_it has a shouty display label. */
export const STATUS_OPTIONS: ReadonlyArray<{ value: HousingStatus; label: string }> =
  HOUSING_STATUSES.map((value) => ({ value, label: value === 'got_it' ? 'GOT IT' : value }));

export function isHousingStatus(value: unknown): value is HousingStatus {
  return typeof value === 'string' && (HOUSING_STATUSES as readonly string[]).includes(value);
}

/** Unknown/legacy values collapse to the ladder's start — matches the
 * backend's `status if status in STATUSES else "found"`. */
export function normalizeStatus(value: string | null | undefined): HousingStatus {
  return isHousingStatus(value) ? value : 'found';
}

/** status → accent color (theme custom properties, so sky-theming applies). */
const STATUS_COLOR: Record<HousingStatus, string> = {
  found: 'var(--text-muted)',
  contacted: 'var(--text)',
  touring: 'var(--ongoing)',
  toured: 'var(--ongoing)',
  applied: 'var(--orange)',
  passed: 'var(--red)',
  got_it: 'var(--green)',
};

export function statusColorVar(status: string | null | undefined): string {
  return isHousingStatus(status) ? STATUS_COLOR[status] : 'var(--text-muted)';
}

/** Display order: GOT IT pinned up top, active search states next, passed
 * sinks, anything unknown last. (old _HOUSING_RANK) */
const DISPLAY_RANK: Record<HousingStatus, number> = {
  got_it: 0,
  applied: 1,
  toured: 2,
  touring: 3,
  contacted: 4,
  found: 5,
  passed: 6,
};

export function statusRank(status: string | null | undefined): number {
  return isHousingStatus(status) ? DISPLAY_RANK[status] : 9;
}

/** Non-mutating stable sort by rank — entries with the same status keep
 * their stored (insertion) order, like the old `.slice().sort()`. */
export function sortEntriesForDisplay<T extends { status: string }>(entries: readonly T[]): T[] {
  return entries.slice().sort((a, b) => statusRank(a.status) - statusRank(b.status));
}
