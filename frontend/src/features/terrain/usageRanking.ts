/**
 * usageRanking.ts — turns the raw usage record into a ranked list of places.
 *
 * The app already counts three separate things per tab, per day, into
 * feature_usage.json (routes/usage.py): `tabs` = how many times a place was
 * opened, `time` = seconds spent there, `clicks` = taps on tracked controls.
 * GET /api/usage serves the whole record. Nothing read it ACROSS places until
 * now — the existing heat view (ui/usageHeat.ts) tints controls *within*
 * /journal and /todos and never compares one place to another. This module is
 * that missing cross-place read; TerrainUsagePanel.tsx draws what it returns.
 *
 * Keeping the three counts separate all the way through is deliberate, not
 * laziness about blending them into one score. They answer different questions —
 * opened it / stayed in it / did something in it — and a place can rank high on
 * one and near-zero on another. Collapsing them to a single "usage" number
 * hides exactly the thing the panel exists to show.
 *
 * The one part that isn't arithmetic: the record keys on the ROUTE SEGMENT
 * (usageBeacon.ts posts the first path segment of the URL). Route segments are
 * not feature-directory names, and they are not stable across renames. One room
 * has worn FOUR of them — `bots` → `reading-room` → `observatory`, plus `atlas`
 * — so four keys sit in the record describing one place. ALIASES folds them
 * together; LABELS gives each key the name it wears in the UI. Without the fold
 * a renamed room appears several times at a fraction of its real size, which is
 * exactly how the observatory's trend was misread before this module existed.
 *
 * A label without an alias is the trap here: it names the row convincingly and
 * still leaves it split off from the room it belongs to. `reading-room` sat in
 * LABELS alone for two weeks and hid 4.9 hours and 114 opens from the panel
 * built to surface them — invisible by default because TerrainUsageView opens on
 * a 7-day window and that key's last data is 2026-07-27. If you add a key here,
 * add it to BOTH tables or to neither.
 *
 * This table is the CLIENT-SIDE half of a fix that belongs at the source: the
 * beacon should record a stable feature id beside the display key. Once it does,
 * this table becomes a one-time migration instead of a permanent translation
 * layer. Note the fix cannot be written as "log the feature id" today — there is
 * no id namespace anywhere in the repo to log. The Burn does NOT depend on this:
 * it units on `features/<name>/` + `routes/<name>.py` and reads usage_rollup's
 * per-feature api counts, never these tab keys.
 *
 * Prompt that produced it: "build a simple visualizer that lives in terrain,
 * with what I already have" — a view of which places actually get used.
 */

/** One day's slice of the record. `clicks` is per-control in the live data,
 * but an older/simpler shape stored a bare total — both are accepted. */
export interface UsageDay {
  tabs?: Record<string, number>;
  time?: Record<string, number>;
  clicks?: Record<string, Record<string, number> | number>;
}

export interface UsageRecord {
  days?: Record<string, UsageDay>;
}

export interface PlaceUsage {
  /** The canonical route segment, after alias folding. */
  key: string;
  label: string;
  /** Times the place was opened. */
  visits: number;
  /** Seconds of dwell. */
  seconds: number;
  /** Taps on tracked controls inside it. */
  taps: number;
}

/**
 * Renamed or retired route segments → the segment they should count as.
 * Only renames belong here: two keys that were genuinely the same room.
 */
export const ALIASES: Readonly<Record<string, string>> = {
  // Renamed with the surface itself (see shell/TopTabs.tsx). Two hops, not one:
  // bots → reading-room → observatory. All three keys are in the live record.
  bots: 'observatory',
  'reading-room': 'observatory',
  // Retired: /atlas is now a bare redirect into the Observatory's archive.
  atlas: 'observatory',
};

/**
 * Display names for route segments whose name in the UI isn't just the
 * segment title-cased. Anything absent falls back to the segment itself, so
 * a new route shows up correctly-ish without an edit here.
 */
const LABELS: Readonly<Record<string, string>> = {
  todos: 'To Do',
  map: 'Life Map',
  // Two different surfaces, and they used to share a label wrongly. /code is
  // Terrain's read-only single-file viewer (routes/code.tsx renders
  // features/terrain/FileCodePage — it's where an Observatory card sends a
  // tapped file); /vscode launches code-server, which is the actual VS Code.
  code: 'File Viewer',
  vscode: 'VS Code',
  runqueue: 'Run Queue',
  nightcrew: 'Night Crew',
  devnotes: 'Dev Notes',
  scratchpad: 'Scratchpad',
};

export function labelFor(key: string): string {
  const canonical = ALIASES[key] ?? key;
  return (
    LABELS[canonical] ??
    canonical.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Total of a day's click entry, which may be per-control or a bare number. */
function clickTotal(entry: Record<string, number> | number | undefined): number {
  if (typeof entry === 'number') return entry;
  if (!entry) return 0;
  let total = 0;
  for (const n of Object.values(entry)) {
    if (typeof n === 'number' && Number.isFinite(n)) total += n;
  }
  return total;
}

/**
 * The dates to sum over: the last `days` dates that actually have records,
 * newest last. Slicing the record's own sorted keys — rather than counting
 * back from the clock — keeps this pure and free of timezone edges, and it
 * degrades honestly when a day is missing (a gap costs a row, not a shift).
 * `days = null` means every day on file.
 */
export function windowDates(record: UsageRecord | null, days: number | null): string[] {
  const all = Object.keys(record?.days ?? {}).sort();
  if (days === null || days >= all.length) return all;
  return all.slice(Math.max(0, all.length - days));
}

/**
 * Rank places by dwell time, descending. Ties break on visits, then on name
 * so the order is stable between renders. Places with no signal at all are
 * dropped — an empty row teaches nothing.
 */
export function rankPlaces(record: UsageRecord | null, days: number | null): PlaceUsage[] {
  const dates = windowDates(record, days);
  const byKey = new Map<string, PlaceUsage>();

  const bucket = (rawKey: string): PlaceUsage => {
    const key = ALIASES[rawKey] ?? rawKey;
    let place = byKey.get(key);
    if (!place) {
      place = { key, label: labelFor(key), visits: 0, seconds: 0, taps: 0 };
      byKey.set(key, place);
    }
    return place;
  };

  for (const date of dates) {
    const day = record?.days?.[date];
    if (!day) continue;
    for (const [k, n] of Object.entries(day.tabs ?? {})) {
      if (typeof n === 'number' && Number.isFinite(n)) bucket(k).visits += n;
    }
    for (const [k, n] of Object.entries(day.time ?? {})) {
      if (typeof n === 'number' && Number.isFinite(n)) bucket(k).seconds += n;
    }
    for (const [k, entry] of Object.entries(day.clicks ?? {})) {
      bucket(k).taps += clickTotal(entry);
    }
  }

  return [...byKey.values()]
    .filter((p) => p.seconds > 0 || p.visits > 0 || p.taps > 0)
    .sort((a, b) => b.seconds - a.seconds || b.visits - a.visits || a.key.localeCompare(b.key));
}

/** Compact dwell: under an hour reads in minutes, above it in hours. Under a
 * minute is "<1m" rather than "0m" — a place you touched isn't a place you
 * didn't. */
export function formatDwell(seconds: number): string {
  if (seconds <= 0) return '—';
  const minutes = seconds / 60;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}
