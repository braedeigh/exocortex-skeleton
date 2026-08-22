/**
 * phoneLogic.ts — pure logic behind the mobile phone terminal (PhoneTerminal),
 * extracted verbatim from templates/phone.html's inline script so it can be
 * unit-tested: the swipe→tmux-scroll math, the toolbar's special-key table,
 * the message textarea's autosize cap, and the upload overlay/paste strings.
 */

export type ScrollDirection = 'up' | 'down';

export interface SwipeScroll {
  direction: ScrollDirection;
  lines: number;
}

/**
 * Translate a completed touch drag (deltaY = end − start, px) into a tmux
 * scroll command — phone.html's touchend handler, numbers unchanged:
 * drags under 50px are taps/noise and do nothing; a downward drag (positive
 * deltaY) scrolls the buffer UP (finger pulls history down); 1 line per 15px,
 * clamped to 1..30. There was no momentum in the old code — one swipe, one
 * scroll command.
 */
export function swipeToScroll(deltaY: number): SwipeScroll | null {
  if (Math.abs(deltaY) < 50) return null;
  return {
    direction: deltaY > 0 ? 'up' : 'down',
    lines: Math.min(Math.max(Math.floor(Math.abs(deltaY) / 15), 1), 30),
  };
}

/**
 * The toolbar's special-key buttons, in order — labels as rendered, keys as
 * tmux `send-keys` names (routes/terminal.py allowlists [A-Za-z0-9_-]).
 */
export const SPECIAL_KEYS = [
  { label: 'ret', key: 'Enter' },
  { label: 'esc', key: 'Escape' },
  { label: '^C', key: 'C-c' },
  { label: '^O', key: 'C-o' },
  { label: '▲', key: 'Up' },
  { label: '▼', key: 'Down' },
] as const;

/**
 * Auto-grow height for the message textarea: track content (scrollHeight) up
 * to phone.html's 100px cap. The bottom bar is absolutely positioned, so
 * growing expands upward over the terminal without resizing the ttyd iframe.
 */
export function autosizeHeight(scrollHeight: number, max = 100): number {
  return Math.min(scrollHeight, max);
}

/**
 * Before measuring a textarea, does its height need resetting to 'auto'?
 *
 * The reset is what lets a box SHRINK: scrollHeight can never report content
 * shorter than the height already set, so without it a box that grew once
 * never comes back down. It's also the expensive half of measuring — that
 * write throws away the page's layout, so the scrollHeight read after it has
 * to rebuild the layout synchronously before it can answer. On a page with a
 * long transcript under the composer that stall is big enough to feel as
 * typing lag.
 *
 * So: skip it while the text is strictly GROWING, which is what plain typing
 * does — a taller box is something scrollHeight reports fine on its own. Reset
 * whenever it isn't growing, which covers deletes and the same-length replace
 * that re-wraps to fewer lines (rare, and cheap to be safe about).
 *
 * `force` is for the paths that write into the box themselves, where the
 * previous length says nothing about what changed.
 */
export function needsAutoReset(length: number, lastLength: number, force = false): boolean {
  return force || length <= lastLength;
}

/** Upload-overlay label — singular/plural exactly as phone.html spelled it. */
export function uploadingLabel(count: number): string {
  return count === 1 ? 'Uploading photo…' : `Uploading ${count} photos…`;
}

/**
 * The text typed into the terminal after a photo upload: one
 * `[uploaded: <path>]` ref per file, newline-joined (phone.html:365).
 */
export function uploadedPathsMessage(paths: string[]): string {
  return paths.map((p) => `[uploaded: ${p}]`).join('\n');
}

/** ttyd iframe URL for a tmux session (same shape TerminalFrames uses). */
export function terminalSrc(session: string): string {
  return `/terminal/?arg=${encodeURIComponent(session)}`;
}
