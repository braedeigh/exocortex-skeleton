/**
 * queuedMessages.ts — the browser-side staging for her queued sends.
 * Her queued messages live on the server now (the session's mailbox —
 * useMessageQueue.ts). This is only the holding pen for the one case the
 * server can't take yet: the very first turn of a blank compose, before the
 * conversation has an id. Those stage under a per-bot `new-` key in
 * localStorage and move to the server when the id arrives. It also reads the
 * per-conversation keys the old browser-side queue left behind, so nothing
 * typed under the old version is lost.
 *
 * It also holds the pure rule for which rows the page shows (mergeQueueRows):
 * the server's waiting list, plus the ones the browser still holds — staged,
 * on their way, or refused. That second half is what keeps a message the
 * server never got on screen instead of letting the next read wipe it.
 *
 * And the two sentences she reads about a queued message: why it's still
 * waiting (waitReason — the step the agent is stuck in, and for how long) and,
 * once the agent has it, where it landed (arrivedNote — "arrived after step
 * 14"). The server supplies the facts (routes/observatory.py _inbox_status and
 * the `arrived` field on her transcript line); these only word them.
 *
 * Prompt that produced the last part: "show why it's waiting, a send now
 * button, and when each one landed."
 */

import type { InboxStatus } from './api';

export interface QueuedMessage {
  text: string;
  offRecord: boolean;
}

// 'exo-bot-queue:*' predates the observatory rename (07-24) — the persona
// concept ("bot") stays, so this on-disk/localStorage key prefix is
// deliberately unchanged.
const queueKey = (botId: string, convId?: string) => `exo-bot-queue:${convId ?? `new-${botId}`}`;

export function loadQueued(botId: string, convId?: string): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(queueKey(botId, convId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (q): q is { text: string; offRecord?: unknown } =>
          typeof q === 'object' && q !== null && typeof (q as { text?: unknown }).text === 'string',
      )
      .map((q) => ({ text: q.text, offRecord: q.offRecord === true }));
  } catch {
    return []; // storage disabled or corrupt — the queue just doesn't persist
  }
}

export function saveQueued(
  botId: string,
  convId: string | undefined,
  queued: QueuedMessage[],
): void {
  try {
    const key = queueKey(botId, convId);
    if (queued.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(queued));
  } catch {
    // storage disabled — nothing to do
  }
}

/** Where a queued row stands. `staged`: no conversation id to send it to yet.
 * `sending`: posted, answer not back. `failed`: the server never took it.
 * `waiting`: the server has it and the agent hasn't picked it up. `handed`:
 * written into the running agent, which reads it when its current step ends —
 * it can't be taken back any more, only sent now. */
export type QueuedState = 'staged' | 'sending' | 'failed' | 'waiting' | 'handed';

/** One queued row as the page draws it. `key` is stable for React; `id` is
 * the server's, once it has one. `confirmedAt` marks when the browser learned
 * the server took it — the next read started after that is the one that can
 * speak for it. */
export interface QueuedRow extends QueuedMessage {
  key: string;
  state: QueuedState;
  id?: number;
  confirmedAt?: number;
  /** She pressed send now; the turn is being stopped for it. */
  rushed?: boolean;
}

/** The server's waiting list as rows. */
export function rowsFromServer(
  waiting: { id: number; text: string; record: boolean; handed?: boolean; rushed?: boolean }[],
): QueuedRow[] {
  return waiting.map((w) => ({
    key: `s${w.id}`,
    id: w.id,
    text: w.text,
    offRecord: !w.record,
    state: w.handed ? 'handed' : 'waiting',
    rushed: w.rushed === true,
  }));
}

/** Drop the browser's copy of rows the server has now spoken for: ones it
 * confirmed before this read started. Whether the read listed them (still
 * waiting) or not (the agent took them), the server's list is the truth for
 * them from here. Rows still staged, sending or failed are kept. */
export function pruneSettled(local: QueuedRow[], readStartedAt: number): QueuedRow[] {
  return local.filter((r) => r.confirmedAt === undefined || r.confirmedAt > readStartedAt);
}

/** What the page shows: the server's rows, then the browser's own that the
 * server's list doesn't already carry (matched by id). */
export function mergeQueueRows(server: QueuedRow[], local: QueuedRow[]): QueuedRow[] {
  const onServer = new Set(server.map((r) => r.id));
  return [...server, ...local.filter((r) => r.id === undefined || !onServer.has(r.id))];
}

/** A step's tool in words, for "the agent is ___". Same idea as events.ts's
 * toolLabel, phrased to finish that sentence. */
export function stepLabel(name: string): string {
  if (/^bash$/i.test(name)) return 'running a command';
  if (/read|grep|glob|^ls$/i.test(name)) return 'looking through files';
  if (/write|edit/i.test(name)) return 'writing a file';
  if (/^(task|agent)$/i.test(name)) return 'working with a subagent';
  if (/web/i.test(name)) return 'reading the web';
  return name ? `using ${name}` : 'working';
}

/** How long, said plainly: "40s", "4 min", "1 h 5 min". */
export function spokenDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

/** Why one of her rows is still waiting, or null when there's nothing to say
 * (staged, on its way, refused, or no word from the server yet). `detail` is
 * what the step is working on — the command, the file — shown beside it. */
export function waitReason(
  row: Pick<QueuedRow, 'state' | 'rushed'>,
  status: InboxStatus | null | undefined,
): { text: string; detail: string | null } | null {
  if ((row.state !== 'waiting' && row.state !== 'handed') || !status) return null;
  if (row.rushed) return { text: 'sending now — stopping the step it was on', detail: null };
  if (!status.running) return { text: 'starts a new turn as soon as there’s room', detail: null };
  if (row.state === 'waiting' && status.policy === 'queue-only') {
    return { text: 'this session takes messages only between turns', detail: null };
  }
  const step = status.step;
  if (!step) return { text: 'the agent is thinking — it reads this at its next step', detail: null };
  const soFar = step.seconds != null ? ` (${spokenDuration(step.seconds)} so far)` : '';
  return {
    text: `the agent is ${stepLabel(step.name)}${soFar} — it reads this when that step ends`,
    detail: step.target || null,
  };
}

/** Where one of her mailbox messages landed, as the transcript line records
 * it (routes/observatory.py _arrival). */
export interface Arrival {
  how: 'injected' | 'interrupt' | 'next-turn';
  after_step?: number;
}

/** The note under her message in the chat saying where it landed. */
export function arrivedNote(arrived: Arrival): string {
  if (arrived.how === 'interrupt') return 'sent now — stopped the step it was on and started a new turn';
  if (arrived.how === 'next-turn') return 'waited for the turn to end, then started a new one';
  const step = arrived.after_step ?? 0;
  return step > 0 ? `arrived mid-turn, after step ${step}` : 'arrived mid-turn, before its first step';
}
