/**
 * sendFailure.ts — what to do with her message when a send doesn't start a turn.
 *
 * What this does, in plain English: by the time a send can fail, the page has
 * already emptied the message box and drawn her message in the chat. So every
 * way a send can fail has to say where her words go next, or they are simply
 * gone. This file names the three cases and nothing else; ObservatoryPage.tsx
 * (sendMessage's catch) acts on them.
 *
 *   - 'busy'    — the server refused because a turn is already running that
 *                 this page hadn't seen: one the app started (a watch firing,
 *                 a finished job's wake, a room notice, an agent's mail), or
 *                 one sent from another device. Her message goes to the
 *                 session's mailbox (useMessageQueue.ts), which hands it to
 *                 that turn or starts the next one with it.
 *   - 'refused' — the server answered with any other "no". No turn started
 *                 and none will: her words go back in the box, with the reason.
 *   - 'unknown' — no answer at all (the connection dropped). The turn may or
 *                 may not have started, so the page goes and reads the record,
 *                 and gives her words back only if the record doesn't have
 *                 them (messageWasRecorded).
 *
 * The bug this came from: a watch fired in a chat she had open, she sent a
 * message six seconds into the turn it started, the server answered 409, and
 * the page treated that as 'unknown' — it re-read the record, which replaced
 * her drawn message with the watch's turn. Her words were in neither the box,
 * the chat, nor the server.
 *
 * Touches: api.ts (SendError, and the `busy` mark routes/observatory.py
 * begin_turn puts on that refusal), events.ts (Turn), ObservatoryPage.tsx.
 *
 * Prompt that produced it: "When a watch fires, it kills my input." and
 * "When your watch fires it overwrites what I say".
 */
import { SendError } from './api';
import type { Turn } from './events';

export type SendFailure = 'busy' | 'refused' | 'unknown';

/** Sort a failed send into one of the three cases above. Only an answer from
 * the server (a SendError) can be 'busy' or 'refused'; anything else thrown
 * means the request's fate isn't known. */
export function sendFailureKind(err: unknown): SendFailure {
  if (!(err instanceof SendError)) return 'unknown';
  return err.status === 409 && err.busy === true ? 'busy' : 'refused';
}

/** Is her message in the record? `turns` is the chat as re-read from the
 * server, `sentAt` the place the page drew her message at. Looks from a
 * little before that place to the end (the record can hold a line or two the
 * live page didn't, or the other way round), for a message of hers with the
 * same words. */
export function messageWasRecorded(turns: Turn[], sentAt: number, text: string): boolean {
  const wanted = text.trim();
  return turns
    .slice(Math.max(0, sentAt - SLACK_TURNS))
    .some((t) => t.role === 'user' && t.text.trim() === wanted);
}

// How far before her message's drawn place the search starts.
const SLACK_TURNS = 4;
