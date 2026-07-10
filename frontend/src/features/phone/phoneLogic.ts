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
