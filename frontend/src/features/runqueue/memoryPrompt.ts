/**
 * memoryPrompt.ts — the decisions behind the "not enough room" prompt.
 *
 * Plain English: this box has a fixed amount of memory and every Claude session
 * on it wants about 400MB, so there's a limit to how many can run at once. When
 * you're at that limit and try to start another, the app shows you a bar of
 * what's using the box and asks what you want to do. This file works out what
 * to show and which buttons to offer — no React in here, so the rules can be
 * tested on their own.
 *
 * Two situations, and telling them apart is the whole job:
 *   - You're at the concurrency cap but there IS free memory. The server would
 *     let this through; we ask first. So "Start anyway" is a real option.
 *   - The server actually refused (below its hard floor). Offering "Start
 *     anyway" there would be a button that can only fail, so it isn't offered.
 *
 * Talks to: routes/run_queue.py's /api/runqueue/headroom (the numbers) and
 * scripts/run_dispatcher.py (whose cap and floor those numbers come from).
 *
 * Prompt that produced it: "i want some kind of message to pop up with my
 * memory allocation bar if i want to start more than 3, then with an option to
 * just queue it if necessary."
 */

/** What /api/runqueue/headroom answers with. `available_mb`/`total_mb` are null
 * off Linux, where /proc/meminfo doesn't exist — every consumer here treats
 * that as "can't tell" rather than guessing a number. */
export interface Headroom {
  available_mb: number | null;
  total_mb: number | null;
  floor_mb: number;
  per_run_mb: number;
  cap: number;
  running: number;
  queued: number;
  would_admit: boolean;
  paused_until: string | null;
  pause_reason: string | null;
}

export type PromptAction = 'start' | 'queue' | 'cancel';

/**
 * Should we stop and ask before starting another session?
 *
 * Yes when the background runs are at their cap, when there isn't headroom for
 * one more, or when the queue is paused (a usage limit). No when we simply
 * can't read the memory — an unreadable /proc is not a reason to nag.
 */
export function shouldPrompt(h: Headroom | null | undefined): boolean {
  if (!h) return false;
  if (h.paused_until) return true;
  if (h.running >= h.cap) return true;
  if (h.available_mb === null) return false;
  return !h.would_admit;
}

/**
 * Which buttons the prompt offers. `serverRefused` is true when we're here
 * because a send came back 503 — the server has already said no, so the only
 * ways forward are queueing it or backing out.
 */
export function promptActions(
  h: Headroom | null | undefined,
  serverRefused: boolean,
): PromptAction[] {
  if (serverRefused) return ['queue', 'cancel'];
  // Being at the CAP is a soft stop — the server doesn't enforce it for her
  // own sessions, so starting anyway really works. Being out of MEMORY is a
  // hard one: the send would come straight back 503, so we don't offer a
  // button whose only outcome is failing.
  const outOfMemory = !!h && h.available_mb !== null && !h.would_admit && h.running < h.cap;
  if (outOfMemory) return ['queue', 'cancel'];
  return ['start', 'queue', 'cancel'];
}

/** One sentence saying why we stopped, in her words rather than the server's. */
export function promptReason(h: Headroom | null | undefined, serverRefused: boolean): string {
  if (!h) return 'There may not be room to start another session right now.';
  if (h.paused_until) {
    return h.pause_reason
      ? `Background runs are paused — ${h.pause_reason}.`
      : 'Background runs are paused for a cooling period.';
  }
  if (serverRefused) {
    return h.available_mb === null
      ? 'There isn’t enough memory to start another session.'
      : `Only ${h.available_mb}MB is free, which isn’t enough to start another session.`;
  }
  if (h.running >= h.cap) {
    return `${h.running} background runs are already going, which is the limit.`;
  }
  return 'Starting another session would eat into the memory kept free for the site.';
}

/**
 * The memory bar, as three widths that add to 100.
 *
 * `used` is everything already spoken for, `reserved` is the floor the
 * dispatcher never spends (so the site itself keeps running), and `free` is
 * what's genuinely available for another session. Returns null when the
 * memory can't be read — the prompt then shows its text without a bar rather
 * than drawing a made-up one.
 */
export function barSegments(
  h: Headroom | null | undefined,
): { used: number; reserved: number; free: number } | null {
  if (!h || h.available_mb === null || !h.total_mb) return null;
  const total = h.total_mb;
  const reservedMb = Math.min(h.floor_mb, h.available_mb);
  const freeMb = Math.max(0, h.available_mb - reservedMb);
  const usedMb = Math.max(0, total - h.available_mb);
  const pct = (mb: number) => Math.round((mb / total) * 1000) / 10;
  return { used: pct(usedMb), reserved: pct(reservedMb), free: pct(freeMb) };
}

/** "3 running · 2 waiting" — the queue in one line, with the plurals right. */
export function queueSummary(h: Headroom | null | undefined): string {
  if (!h) return '';
  const bits = [`${h.running} running`];
  if (h.queued > 0) bits.push(`${h.queued} waiting`);
  return bits.join(' · ');
}
