/**
 * vscodeMath.ts — pure logic ported from templates/vscode_launcher.html:
 * the memory-gauge math (percent, low threshold, MB formatting), the warn
 * copy, and the launcher's timing constants. All side-effect free — tested
 * in vscodeMath.test.ts.
 */

import type { VscodeStatus } from './types';

/** Old page polled /api/vscode/status every 1s — but only after Start was
 * clicked; the idle page never polled. */
export const STATUS_POLL_MS = 1000;

/** Delay between "running — opening…" appearing and the redirect. */
export const REDIRECT_DELAY_MS = 400;

/** Old stop handler waited 800ms after POST /api/vscode/stop before
 * re-checking status (gives systemd time to actually kill it). */
export const STOP_SETTLE_MS = 800;

/** The code-server reverse proxy. The trailing slash is load-bearing: this
 * is NOT the SPA /files route — it leaves the SPA entirely, so navigation
 * must be a full window.location assignment. */
export const EDITOR_URL = '/files/';

/** Gauge fill percent — old page: Math.min(100, Math.round(avail/total*100)).
 * Guarded against zero/garbage totals (old page would render NaN%). */
export function memPercent(availableMb: number, totalMb: number): number {
  if (!Number.isFinite(availableMb) || !Number.isFinite(totalMb) || totalMb <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((availableMb / totalMb) * 100)));
}

/** The backend reports whole megabytes; the old page printed them raw. */
export function formatMb(mb: number): string {
  return `${mb} MB`;
}

/** The gauge's value line: "1234 MB / 3921 MB". */
export function formatMemText(availableMb: number, totalMb: number): string {
  return `${formatMb(availableMb)} / ${formatMb(totalMb)}`;
}

/** Gauge threshold — the fill turns red exactly when the server says memory
 * is too low to start AND the editor isn't already running (old page:
 * memFill.classList.toggle("low", !s.ok_to_start && !s.running)). */
export function isMemLow(status: Pick<VscodeStatus, 'ok_to_start' | 'running'>): boolean {
  return !status.ok_to_start && !status.running;
}

/** Low-RAM warning visibility — same condition as isMemLow, but named for
 * the branch it drives (old render(): the not-running, not-ok else arm). */
export function showLowMemWarning(
  status: Pick<VscodeStatus, 'ok_to_start' | 'running'>,
): boolean {
  return !status.running && !status.ok_to_start;
}

/** Warning body copy, verbatim from the old page. */
export function warnDetail(thresholdMb: number): string {
  return `Need ~${thresholdMb} MB free. Close some of these to make room:`;
}
