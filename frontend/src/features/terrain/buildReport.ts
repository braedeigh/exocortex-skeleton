/**
 * buildReport.ts — the shapes of a Terrain build and its report, and the small
 * pieces of arithmetic that turn a list of commits into something readable.
 *
 * A BUILD is one of the owner's other git folders (a project built in its own
 * directory, or a repo cloned from GitHub) that Terrain maps on its own page.
 * Its REPORT is the written half of that page: a few summary numbers, the
 * sessions that worked in it, and its commits. The server sends the commits as
 * one flat list, newest first (routes/terrain_builds.py); grouping them into
 * days happens here, because which day a commit falls on depends on the
 * reader's clock.
 *
 * Pure functions only — no fetching (buildsApi.ts) and no drawing
 * (BuildReport.tsx, TerrainBuildsView.tsx). Tested in buildReport.test.ts.
 *
 * Prompt that produced it: "I want to be able to view other folders in my
 * terrain view so I can basically see a report of what happened … see when it
 * was built or edited."
 */

/** One build's history in a handful of numbers. `first`/`last` are the oldest
 * and newest commit as unix seconds; null for a build with nothing indexed. */
export interface BuildSummary {
  commits: number;
  files: number;
  first: number | null;
  last: number | null;
  added: number;
  removed: number;
  /** How many distinct days had a commit. */
  days: number;
}

/** A build as the Builds room lists it. `state` is read off the disk on every
 * request: ready (the folder is there), cloning (a GitHub clone is still
 * arriving), failed (the clone ended in an error — `detail` is git's own
 * words), missing (no folder, and nothing fetching one). */
export interface BuildInfo {
  id: string;
  name: string;
  root: string;
  /** The GitHub address it was cloned from; null for a local folder. */
  source: string | null;
  added: string | null;
  state: 'ready' | 'cloning' | 'failed' | 'missing';
  detail: string | null;
  summary: BuildSummary | null;
}

export interface BuildCommit {
  sha: string;
  /** When it was authored, unix seconds. */
  ts: number;
  author: string;
  subject: string;
  /** How many files it changed, and its line counts summed over them. */
  files: number;
  added: number;
  removed: number;
}

/** One session that touched the build, with what it did THERE — not across
 * everything it ever worked on. `last` is an ISO string, like every session
 * stamp in the terrain payload. */
export interface BuildSession {
  id: string;
  title: string;
  lane: string | null;
  running: boolean;
  last: string | null;
  files: number;
  writes: number;
  reads: number;
  creates: number;
}

export interface BuildReportData {
  build: BuildInfo;
  summary: BuildSummary | null;
  sessions: BuildSession[];
  /** Newest first, cut to the newest few thousand. */
  commits: BuildCommit[];
  /** How many commits there are in all — more than `commits.length` only for
   * a very long history. */
  commits_total: number;
}

/** One day of a build's commits. `from`/`to` are that local day's first and
 * last second, so a tap on the day can hand them straight to the map's date
 * range. */
export interface CommitDay {
  /** Local date, YYYY-MM-DD. */
  day: string;
  from: number;
  to: number;
  commits: BuildCommit[];
  added: number;
  removed: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The local calendar day a unix second falls on, as YYYY-MM-DD. */
export function localDay(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Group commits into local days, newest day first, each day's commits kept in
 * the order they arrived (newest first).
 *
 * The day's `from`/`to` come from the calendar rather than from adding 86,400
 * seconds, so a day that is 23 or 25 hours long (a clock change) still starts
 * and ends at its own midnights.
 */
export function groupCommitsByDay(commits: readonly BuildCommit[]): CommitDay[] {
  const byDay = new Map<string, CommitDay>();
  for (const commit of commits) {
    const day = localDay(commit.ts);
    let entry = byDay.get(day);
    if (!entry) {
      const d = new Date(commit.ts * 1000);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      entry = {
        day,
        from: Math.floor(start.getTime() / 1000),
        to: Math.floor(next.getTime() / 1000) - 1,
        commits: [],
        added: 0,
        removed: 0,
      };
      byDay.set(day, entry);
    }
    entry.commits.push(commit);
    entry.added += commit.added;
    entry.removed += commit.removed;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** "2026-10-01" → "Thu 1 Oct 2026". */
export function dayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const d = new Date(year, month - 1, date);
  return `${WEEKDAYS[d.getDay()]} ${date} ${MONTHS[month - 1]} ${year}`;
}

/** A unix second as a local clock time, "09:05". */
export function clockLabel(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortDate(unixSeconds: number, withYear: boolean): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

/**
 * When a build was worked on, as a span of dates: "1 Oct 2026" when it all
 * happened on one day, "30 Sep – 1 Oct 2026" within a year, and both years
 * spelled out when it crosses one. Empty for a build with no commits.
 */
export function spanLabel(first: number | null, last: number | null): string {
  if (first === null || last === null) return '';
  if (localDay(first) === localDay(last)) return shortDate(last, true);
  const sameYear = new Date(first * 1000).getFullYear() === new Date(last * 1000).getFullYear();
  return `${shortDate(first, !sameYear)} – ${shortDate(last, true)}`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** The one line a build wears on its card: "23 commits · 153 files · 1 Oct
 * 2026". Says so plainly when there is no history to summarise. */
export function summaryLine(summary: BuildSummary | null): string {
  if (!summary || summary.commits === 0) return 'No commits indexed yet';
  return [
    plural(summary.commits, 'commit'),
    plural(summary.files, 'file'),
    spanLabel(summary.first, summary.last),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "+1,204 −88" — a commit's or a day's size in lines. */
export function linesLabel(added: number, removed: number): string {
  return `+${added.toLocaleString('en-US')} −${removed.toLocaleString('en-US')}`;
}
