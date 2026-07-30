/**
 * resumeAfterDecision — make her Approve/Deny tap actually restart the session.
 *
 * WHAT WAS BROKEN. When the act-vs-ask gate blocks a command, it writes the
 * command into the session's approvals sidecar and tells the agent to stop and
 * wait. The orange Approve/Deny card appears the instant that happens — which
 * is WHILE the agent is still finishing its turn (it has been told to stop, but
 * "stop" is a last message it still has to write, and the claude process only
 * exits after that). So the card is on screen a few seconds before the turn
 * actually ends.
 *
 * Tapping Approve in that window wrote the approval fine, then fired the resume
 * send straight into the server's one-turn-at-a-time guard, which answered 409
 * "a turn is already running in this conversation". The tap was swallowed, the
 * agent never got its retry cue, and the session just sat there — which is
 * exactly what "after I do an approval, it doesn't keep going" looked like.
 *
 * WHAT THIS DOES. Treats 409 as "not yet" instead of "no": retry the resume on
 * a short interval until the winding-down turn releases the conversation, then
 * send it. Any other failure is a real error and gives up immediately. If the
 * turn never releases (an agent that ignored the stop and kept working), we give
 * up after the budget below and report it, so she gets a visible failure and can
 * tap again — never a silent dead end.
 *
 * Touches: api.ts (SendError / isTurnBusy / streamSend) and SessionLane.tsx,
 * which owns the Approve/Deny buttons.
 *
 * Prompt: "after I do an approval, it doesn't keep going."
 */
import { isTurnBusy } from './api';

/**
 * How long to keep waiting for the blocked turn to wind down. A denied agent
 * normally emits its final message and exits within a few seconds; 30s is far
 * past that without hanging on an agent that never stops.
 */
export const RESUME_ATTEMPTS = 20;
export const RESUME_DELAY_MS = 1500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ResumeOptions {
  attempts?: number;
  delayMs?: number;
  /** Injected by the tests so they don't spend real seconds sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `send`, retrying only while the conversation is busy (409).
 *
 * Resolves once the send goes through. Rejects with the last error if the
 * conversation is still busy after the whole budget, or immediately on any
 * error that isn't "busy" — a 404 or a 500 will not get better by asking again.
 */
export async function resumeAfterDecision(
  send: () => Promise<unknown>,
  opts: ResumeOptions = {},
): Promise<void> {
  const attempts = opts.attempts ?? RESUME_ATTEMPTS;
  const delayMs = opts.delayMs ?? RESUME_DELAY_MS;
  const sleep = opts.sleep ?? wait;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await send();
      return;
    } catch (err) {
      lastErr = err;
      // Only a busy conversation is worth waiting on; everything else is real.
      if (!isTurnBusy(err)) throw err;
      // No sleep after the final attempt — nothing follows it.
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}
