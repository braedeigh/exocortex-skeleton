/**
 * codeMentions.ts — "open this file where it names THAT", as a type and as a
 * pair of URL search params.
 *
 * A file opened from a SQL table's card isn't opened to be read from the top;
 * it's opened to see where it touches that table. That destination has to
 * survive three different journeys — straight into the pane beside the map,
 * across the window bus into another tile, and out into a popped-out browser
 * tab — and the last two are URLs. So the shape and its spelling live here,
 * in one file, rather than being written out at each end and drifting:
 *
 *   /code?repo=…&path=…&mentions=4,9,30&of=todos
 *
 * Read by FileCodeBody.tsx (which lights the lines and steps between them),
 * routes/code.tsx (validates the params), FileCodePage.tsx, shell/solo.ts
 * (the popped-out tab) and shell/panels/panelIntents.ts (the window bus).
 * The numbers themselves come from tableMentions.ts.
 */

/** Every line in one file that names one thing, and what to call it. */
export interface CodeMentions {
  /** What was searched for — a SQL table's name, shown in the strip. */
  label: string;
  /** The 1-based lines it was found on, ascending. */
  lines: readonly number[];
}

/** What a valid `mentions` param looks like: line numbers, comma-separated.
 * Anything else collapses to "no mentions" rather than crashing the page —
 * the same contract `lines` has. */
export const MENTIONS_PATTERN = /^\d+(,\d+)*$/;

/** The most lines one URL will carry. The server already caps what it
 * reports per file; this keeps a pathological one out of the address bar. */
const MENTIONS_MAX = 200;

/** Turn mentions into the search params that carry them. Empty when there's
 * nothing to carry, so a caller can always spread the result. */
export function mentionsToSearch(mentions?: CodeMentions): Record<string, string> {
  if (!mentions || mentions.lines.length === 0) return {};
  return {
    mentions: mentions.lines.slice(0, MENTIONS_MAX).join(','),
    of: mentions.label,
  };
}

/** Read mentions back off the params — undefined when there are none, or
 * when what arrived isn't a list of line numbers. */
export function mentionsFromSearch(mentions?: string, of?: string): CodeMentions | undefined {
  if (!mentions || !MENTIONS_PATTERN.test(mentions)) return undefined;
  const lines = mentions.split(',').map(Number).filter((n) => n >= 1);
  if (lines.length === 0) return undefined;
  return { label: of ?? '', lines };
}

/**
 * Step from one mention to another, wrapping at both ends.
 *
 * Wrapping rather than stopping so she can keep pressing one arrow and go
 * round the file instead of hitting a wall and having to find the other
 * button. `at` is clamped first, because the list can shrink under a stored
 * index — a different file opened from the same card.
 */
export function stepMention(at: number, by: number, total: number): number {
  if (total <= 0) return 0;
  const from = Math.min(Math.max(at, 0), total - 1);
  return (((from + by) % total) + total) % total;
}
