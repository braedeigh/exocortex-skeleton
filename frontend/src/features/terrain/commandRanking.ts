/**
 * commandRanking.ts — turns the slash-command ledger into rows the Skills room
 * can draw.
 *
 * GET /api/usage/commands (routes/usage.py → commandstore.py) hands back one
 * entry per command that was run, already counted: how many times, on how many
 * distinct days, in how many sessions, and the first and last day it was seen.
 * It also hands back `cold` — the commands installed in ~/.claude/commands that
 * have no runs at all in the window, which is the list that can't be derived
 * from the counts, because a skill that was never called has no row to appear
 * in. This module is the arithmetic between that payload and the drawing;
 * TerrainCommandsView.tsx renders what it returns.
 *
 * The one real decision here: **recency is a first-class measure, not a
 * footnote.** For pages, "how long did you stay" is the question, so the
 * attention room next door ranks by dwell. For skills it isn't — a voice you
 * built and called twice in June is a different fact from one you call every
 * week, and both can show the same small number of runs. So every row carries
 * `staleDays` (days since it was last run) and the room shows it beside the
 * count. `cold` entries are folded in as rows with zero runs and no last day,
 * rather than shown in a separate list, so the ranking answers "what do I
 * actually reach for" in one pass, top to bottom.
 *
 * `today` is a parameter rather than read from the clock inside, so the
 * staleness maths is testable without freezing time.
 */

export type CommandRow = {
  name: string;
  kind: string;
  runs: number;
  days: number;
  sessions: number;
  first_day: string;
  last_day: string;
  with_args: number;
};

export type CommandsRecord = {
  commands: CommandRow[];
  by_day: { day: string; name: string; runs: number }[];
  by_hour: { hour: number; runs: number }[];
  cold: string[];
  days: number | null;
  kind: string;
};

export type RankedCommand = {
  name: string;
  runs: number;
  days: number;
  sessions: number;
  withArgs: number;
  lastDay: string | null;
  /** Whole days between `lastDay` and today; null when it has never run. */
  staleDays: number | null;
};

/** Midnight-to-midnight day difference between two YYYY-MM-DD strings. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Every command as one row, run ones first (by count), then the never-run ones
 * alphabetically. The never-run tail is deliberately kept in the same list: it
 * is the answer to "what did I build and abandon", and a separate footnote is
 * where that question goes to be ignored.
 */
export function rankCommands(record: CommandsRecord | null, today: string): RankedCommand[] {
  if (!record) return [];
  const ran: RankedCommand[] = (record.commands ?? []).map((c) => ({
    name: c.name,
    runs: c.runs,
    days: c.days,
    sessions: c.sessions,
    withArgs: c.with_args,
    lastDay: c.last_day,
    staleDays: c.last_day ? daysBetween(c.last_day, today) : null,
  }));
  ran.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));

  const cold: RankedCommand[] = [...(record.cold ?? [])]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      runs: 0,
      days: 0,
      sessions: 0,
      withArgs: 0,
      lastDay: null,
      staleDays: null,
    }));

  return [...ran, ...cold];
}

/** "today" / "3d" / "5w" / "never" — short enough to sit in a table column. */
export function staleLabel(staleDays: number | null): string {
  if (staleDays === null) return 'never';
  if (staleDays <= 0) return 'today';
  if (staleDays === 1) return 'yesterday';
  if (staleDays < 14) return `${staleDays}d`;
  if (staleDays < 70) return `${Math.round(staleDays / 7)}w`;
  return `${Math.round(staleDays / 30)}mo`;
}

/**
 * The busiest local hour, as a label — the room's one-line answer to "when".
 * Returns null when nothing has run, so the caller can leave the line out
 * rather than print a confident "midnight".
 */
export function peakHour(record: CommandsRecord | null): number | null {
  const hours = record?.by_hour ?? [];
  let best: number | null = null;
  let most = 0;
  for (const h of hours) {
    if (h.runs > most) {
      most = h.runs;
      best = h.hour;
    }
  }
  return best;
}

/** 0 → "12a", 9 → "9a", 13 → "1p". */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'a' : 'p';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${suffix}`;
}
