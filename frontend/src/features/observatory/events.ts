/**
 * events.ts — pure reducer turning the bot pipe's events into renderable
 * turns. One function handles BOTH sources: a conversation's history jsonl
 * (GET /api/observatory/conversation/<id>) and the live SSE stream of a send —
 * they're the same event vocabulary (routes/observatory.py relays claude's
 * stream-json and logs what it relays), so history replay and live streaming
 * can't drift apart.
 *
 * Event shapes handled (everything else is ignored on purpose):
 * - {type:'user', text, off_record?, arrived?} her message (history only —
 *                                              the live sender pushes it
 *                                              locally via userTurn()).
 *                                              off_record: said with the
 *                                              journal paused — shown here
 *                                              like anything else she said,
 *                                              just dashed. arrived: one that
 *                                              waited in the mailbox says
 *                                              where it landed
 * - {type:'decision', decision, command}       a gated command she approved or
 *                                              denied — shown with the command
 * - {type:'reminder', text, source}            a Coming up reminder the app
 *                                              sent at its set time — shown as
 *                                              System, never as her words;
 *                                              source = who set it (manual =
 *                                              her, keeper = a Keeper). One
 *                                              with source 'helper-wake' is the
 *                                              app waking a helper because its
 *                                              room changed: it and the reply
 *                                              stay hidden unless the helper
 *                                              says something (see `silent`)
 * - {type:'peer', direction, id, from_conv,     a message between two agents —
 *    from_title, to_conv, to_title, text,       'out' in the sender's chat, 'in'
 *    mode, status, held_reason}                 in the recipient's; drawn as a
 *                                              colored card
 * - {type:'questions', questions, ts}         a set of questions the agent
 *                                              filed for her
 *                                              (request_input.py) — drawn as
 *                                              an orange block where it was
 *                                              asked, kept after she answers
 * - {type:'questions-withdrawn', questions,    the agent took its open set
 *    source, ts}                                down because her answer reached
 *                                              it by another route
 *                                              (request_input.py --answered) —
 *                                              marks the block above it
 *                                              answered elsewhere
 * - {type:'peer-status', id, status}           a held agent message she let
 *                                              through — updates its card
 * - {type:'off-record-gap'}                    a cue the app fired for her (a
 *                                              red card's resume nudge), plus
 *                                              every off-record turn logged
 *                                              before her words started being
 *                                              kept — still rendered as a hole
 * - {type:'stream_event', event}               token deltas / tool activity
 * - {type:'assistant', message}                authoritative message text
 * - {type:'user', message}                     claude's tool-result echo — not
 *                                              her; ignored
 * - {type:'result'} / {type:'done'}            turn closes
 * - {type:'error', error}                      surfaced as its own turn
 * - {type:'journal-mark', text}                a whole reply she tapped into
 *                                              the journal — matched by text
 * - {type:'journal-highlight', turn,start,end} a span she highlighted into the
 *                                              journal — matched by turn index
 */

import type { Arrival } from './queuedMessages';

export interface Turn {
  role: 'user' | 'assistant' | 'gap' | 'error' | 'decision' | 'reminder' | 'peer' | 'questions';
  /** user/error: the text. assistant: committed markdown (authoritative).
   * decision: the exact command she approved/denied. reminder: what it says. */
  text: string;
  /** reminder only: who set it — 'manual' (her), 'keeper', 'job' (a
   * background job reporting back — scripts/run_detached.py), 'watch' (a
   * helper's watch that fired — watches.py), 'wake' (the app waking a helper
   * because its room changed — helper_chat.py) or 'linear' (what someone else
   * did in Linear, handed to the Linear helper — linear_feed.py). */
  source?: 'manual' | 'keeper' | 'job' | 'notice' | 'watch' | 'wake' | 'linear';
  /** A helper's wake-up it had nothing to say to: set on the wake reminder and
   * on the reply after it, and cleared on both the moment the reply holds
   * anything but HELPER_SILENT. The page leaves a silent turn out. The turn
   * stays in the array, because journal highlights address turns by index. */
  silent?: boolean;
  /** assistant only: in-flight delta text not yet confirmed by a message. */
  buffer: string;
  /** assistant only: still streaming. */
  open: boolean;
  /** user only: sent with the journal paused — kept in the chat log and
   * rendered dashed, but never minted into the journal. */
  offRecord: boolean;
  /** user only: a message that waited in the mailbox, and where it landed
   * (read mid-turn after step N, sent now, or started the next turn). */
  arrived?: Arrival;
  /** assistant only: current tool activity label ("reading files…"). */
  tool: string | null;
  /** assistant only: this reply was tapped into the journal (K card). */
  journaled: boolean;
  /** decision only: which way she called the gated command. */
  decision?: 'approve' | 'deny';
  /** questions only: the set the agent filed, in its order. */
  questions?: string[];
  /** questions only: the agent withdrew this set because her answer reached it
   * by another route — this is where it said her answer came from. */
  answeredElsewhere?: string;
  /** peer only: the agent message this card draws. */
  peer?: PeerMessage;
  /** Spans of this turn she highlighted into the journal. Offsets are into the
   * turn's RENDERED text (what `textContent` reads), not its markdown source —
   * the selection that made them was a DOM selection, and re-lighting them is a
   * DOM walk (highlightMarks.ts). `quote` is what recovers the span when the
   * offsets drift; `card` is the journal card it minted. */
  highlights?: Highlight[];
}

/** A message between two agents (peermail.py), as its card needs it. */
export interface PeerMessage {
  id: number;
  /** 'out' = this session sent it; 'in' = this session received it. */
  direction: 'in' | 'out';
  otherConv: string;
  otherTitle: string;
  mode: 'inject' | 'queue' | 'interrupt';
  status: 'waiting' | 'held' | 'delivered' | 'cancelled';
  heldReason: string;
}

export interface Highlight {
  start: number;
  end: number;
  quote: string;
  card: string;
}

/** What a helper replies, alone, when the app woke it and it has nothing to
 * say — the same words as helper_chat.SILENT. */
export const HELPER_SILENT = '(nothing to say)';

function turn(role: Turn['role'], text = ''): Turn {
  return { role, text, buffer: '', open: false, offRecord: false, tool: null, journaled: false };
}

function arrivalOf(raw: unknown): Arrival | undefined {
  const a = raw as { how?: unknown; after_step?: unknown } | null;
  if (!a || typeof a !== 'object') return undefined;
  if (a.how !== 'injected' && a.how !== 'interrupt' && a.how !== 'next-turn') return undefined;
  return typeof a.after_step === 'number' ? { how: a.how, after_step: a.after_step } : { how: a.how };
}

export function userTurn(text: string, offRecord: boolean): Turn {
  return { ...turn('user', text), offRecord };
}

/** The rendered markdown for an assistant turn: confirmed messages plus
 * whatever the current delta buffer holds. */
export function assistantText(t: Turn): string {
  return t.buffer ? (t.text ? `${t.text}\n\n${t.buffer}` : t.buffer) : t.text;
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null &&
      (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

/** Friendly label for a tool_use block — presence, not a debug trace. */
function toolLabel(name: unknown): string {
  const n = typeof name === 'string' ? name : '';
  if (/read|grep|glob|ls/i.test(n)) return 'looking through files…';
  if (/bash/i.test(n)) return 'running a command…';
  if (/write|edit/i.test(n)) return 'writing…';
  return n ? `using ${n}…` : 'working…';
}

/** Last turn if it's an open assistant turn, else a fresh one appended. */
function openAssistant(turns: Turn[]): Turn {
  const last = turns[turns.length - 1];
  if (last && last.role === 'assistant' && last.open) return last;
  const fresh: Turn = { ...turn('assistant'), open: true };
  // A reply to a wake-up starts hidden, and stays so until it says something.
  if (wakeBefore(turns, turns.length)) fresh.silent = true;
  turns.push(fresh);
  return fresh;
}

/** The wake reminder this place in the chat answers, if it answers one: the
 * reminder above it, when that is a wake-up and nothing but this same turn
 * lies between. A turn can hold several replies with agent-message cards
 * between them, so those cards and a reply still open are stepped over; a
 * reply already closed belongs to an earlier turn, and ends the search. */
function wakeBefore(turns: Turn[], index: number): Turn | null {
  for (let i = index - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === 'reminder') return t.source === 'wake' ? t : null;
    if (t.role !== 'peer' && !(t.role === 'assistant' && t.open)) return null;
  }
  return null;
}

/** Show a wake-up's reply once it says something. While its text could still
 * become HELPER_SILENT (it's empty, or the start of those words) it stays
 * hidden; the first other word reveals it and the wake reminder above it.
 * `closing`: the turn is over, so a half-written HELPER_SILENT counts as words. */
function revealIfSaid(turns: Turn[], closing = false): void {
  const index = turns.length - 1;
  const t = turns[index];
  if (!t || t.role !== 'assistant' || !t.silent) return;
  const said = assistantText(t).trim();
  if (closing ? said === '' || said === HELPER_SILENT : HELPER_SILENT.startsWith(said)) return;
  t.silent = false;
  const wake = wakeBefore(turns, index);
  if (wake) wake.silent = false;
}

/**
 * Apply one event. Mutates and returns `turns` — callers that need React to
 * re-render should copy the array reference afterward (the page does
 * `setTurns([...next])`); keeping the reducer allocation-free matters because
 * it runs per token delta.
 */
export function applyEvent(turns: Turn[], raw: unknown): Turn[] {
  if (typeof raw !== 'object' || raw === null) return turns;
  const e = raw as Record<string, unknown>;

  switch (e.type) {
    case 'user': {
      if (typeof e.text === 'string') {
        // History replay carries the off-record flag through, so a reload
        // shows the same dashed message the live send put on screen.
        const t = userTurn(e.text, e.off_record === true);
        const arrived = arrivalOf(e.arrived);
        if (arrived) t.arrived = arrived;
        turns.push(t);
      }
      // {type:'user', message} is claude echoing a tool result — ignored
      return turns;
    }
    case 'off-record-gap':
      turns.push(turn('gap'));
      return turns;
    case 'decision': {
      // She tapped Approve/Deny on a gated command. Off the record (never
      // journaled), but shown in the transcript with the actual command so
      // it's a visible record of what she did — not a blank "off the record".
      const t = turn('decision', typeof e.command === 'string' ? e.command : '');
      t.decision = e.decision === 'deny' ? 'deny' : 'approve';
      turns.push(t);
      return turns;
    }
    case 'reminder': {
      // A reminder the app sent into the chat at its set time. Its own turn
      // kind so it's drawn as System — the keeper's reply follows as usual.
      const t = turn('reminder', typeof e.text === 'string' ? e.text : '');
      t.source = e.source === 'keeper' ? 'keeper'
        : e.source === 'run_detached' ? 'job'
        : e.source === 'notice' ? 'notice'
        : e.source === 'helper-watch' ? 'watch'
        : e.source === 'linear-feed' ? 'linear'
        : e.source === 'helper-wake' ? 'wake' : 'manual';
      // A wake-up is hidden until the helper answers it with something to say.
      if (t.source === 'wake') t.silent = true;
      turns.push(t);
      return turns;
    }
    case 'peer': {
      // A message between two agents. Its own card, colored, so she can see
      // what her agents say to each other without it reading as her words or
      // the agent's reply.
      const out = e.direction === 'out';
      const t = turn('peer', typeof e.text === 'string' ? e.text : '');
      const mode = e.mode === 'queue' || e.mode === 'interrupt' ? e.mode : 'inject';
      const status =
        e.status === 'held' || e.status === 'delivered' || e.status === 'cancelled' ? e.status : 'waiting';
      t.peer = {
        id: typeof e.id === 'number' ? e.id : -1,
        direction: out ? 'out' : 'in',
        otherConv: String((out ? e.to_conv : e.from_conv) ?? ''),
        otherTitle: String((out ? e.to_title : e.from_title) ?? ''),
        mode,
        // Arriving is delivery, whatever the row said when it was written.
        status: out ? status : 'delivered',
        heldReason: typeof e.held_reason === 'string' ? e.held_reason : '',
      };
      turns.push(t);
      return turns;
    }
    case 'questions': {
      // The agent filed questions for her. The block lands where it was asked,
      // so the reply it interrupted is closed first: the words it writes after
      // filing open a fresh reply below the block, and the reply above doesn't
      // sit there showing "running a command…" forever (only the LAST turn is
      // closed when the turn ends).
      const list = Array.isArray(e.questions)
        ? e.questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
        : [];
      if (list.length === 0) return turns;
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') {
        last.open = false;
        last.tool = null;
      }
      const t = turn('questions');
      t.questions = list;
      turns.push(t);
      return turns;
    }
    case 'questions-withdrawn': {
      // The agent took its open questions down because her answer came by
      // another route. No new block: the newest set in the chat is the one
      // that was open, so it's marked answered elsewhere, with the source the
      // agent gave. A line with no source still settles the block.
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role !== 'questions') continue;
        turns[i].answeredElsewhere =
          typeof e.source === 'string' && e.source.trim() ? e.source.trim() : 'another route';
        break;
      }
      return turns;
    }
    case 'peer-status': {
      // A held message she released — update the card it belongs to.
      for (const t of turns) {
        if (t.peer && t.peer.id === e.id && t.peer.direction === 'out') {
          t.peer = { ...t.peer, status: 'waiting', heldReason: '' };
        }
      }
      return turns;
    }
    case 'stream_event': {
      const ev = e.event as Record<string, unknown> | undefined;
      if (!ev) return turns;
      if (ev.type === 'content_block_delta') {
        const delta = ev.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          const t = openAssistant(turns);
          t.buffer += delta.text;
          t.tool = null;
          revealIfSaid(turns);
        }
      } else if (ev.type === 'content_block_start') {
        const block = ev.content_block as { type?: string; name?: string } | undefined;
        if (block?.type === 'tool_use') {
          openAssistant(turns).tool = toolLabel(block.name);
        }
      }
      return turns;
    }
    case 'assistant': {
      const t = openAssistant(turns);
      // Fold what the deltas already put on screen, not the authoritative
      // message text: a multi-block message joins its blocks with '\n\n'
      // that the deltas never carried, and that reshaping shifts every
      // later character offset — remounting the word flow's spans mid-cool
      // (a cooled word suddenly flashes ember again). History replay logs
      // no deltas, so buffer is empty there and the message text is used.
      const text = t.buffer || messageText(e.message);
      t.buffer = '';
      if (text) t.text = t.text ? `${t.text}\n\n${text}` : text;
      revealIfSaid(turns);
      return turns;
    }
    case 'result':
    case 'done': {
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') {
        last.open = false;
        last.tool = null;
        revealIfSaid(turns, true);
      }
      return turns;
    }
    case 'error': {
      const text = typeof e.error === 'string' && e.error ? e.error : 'Something went wrong.';
      turns.push(turn('error', text));
      return turns;
    }
    case 'journal-mark': {
      // A reply she tapped into the journal — flag the newest assistant turn
      // whose text matches (the mark carries the full text; both sides read
      // the same log, so equality is exact).
      if (typeof e.text === 'string') {
        for (let i = turns.length - 1; i >= 0; i--) {
          const t = turns[i];
          if (t.role === 'assistant' && assistantText(t) === e.text) {
            t.journaled = true;
            break;
          }
        }
      }
      return turns;
    }
    case 'journal-highlight': {
      // A span she highlighted into the journal. Addressed by TURN INDEX, not
      // by text: history replays the same events in the same order, so the
      // index the client anchored on is the index it rebuilds to. A mark whose
      // turn has since gone (a log edited by hand) is dropped rather than
      // guessed at — a highlight lit on the wrong words would be worse than a
      // highlight that isn't lit.
      const i = e.turn;
      const start = e.start;
      const end = e.end;
      if (typeof i !== 'number' || typeof start !== 'number' || typeof end !== 'number') return turns;
      const t = turns[i];
      if (!t) return turns;
      t.highlights = [
        ...(t.highlights ?? []),
        {
          start,
          end,
          quote: typeof e.quote === 'string' ? e.quote : '',
          card: typeof e.card === 'string' ? e.card : '',
        },
      ];
      return turns;
    }
    default:
      return turns;
  }
}

/** Index of the last user turn, or -1 if she's never sent one. The open-at-
 * unread scroll anchor (ObservatoryPage's history-load effect) needs this:
 * catching up on unread activity means landing on HER last message, not the
 * conversation's last turn (which is usually the reply she hasn't read). */
export function lastUserTurnIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return i;
  }
  return -1;
}

/** Where a filed question set stands, read off what came after it in the chat:
 * 'elsewhere' when the agent withdrew it because her answer reached it by
 * another route, 'answered' once she's sent a message since, 'replaced' when
 * the agent filed a newer set before she did (filing replaces, never appends),
 * else 'open'. Her message wins over a later filing — it's what the set was
 * answered by. */
export type QuestionsState = 'open' | 'answered' | 'elsewhere' | 'replaced';

export function questionsState(turns: Turn[], index: number): QuestionsState {
  if (turns[index]?.answeredElsewhere) return 'elsewhere';
  for (let i = index + 1; i < turns.length; i++) {
    if (turns[i].role === 'user') return 'answered';
    if (turns[i].role === 'questions') return 'replaced';
  }
  return 'open';
}

/** Reduce a full history into turns (conversation GET). */
export function turnsFromHistory(events: unknown[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of events) applyEvent(turns, e);
  // History never leaves a turn hanging open — if the log ends mid-stream
  // (crash), close it so the UI doesn't show a forever-writing ghost.
  const last = turns[turns.length - 1];
  if (last && last.role === 'assistant') {
    last.open = false;
    last.tool = null;
    revealIfSaid(turns, true);
  }
  return turns;
}
