/**
 * events.ts — pure reducer turning the bot pipe's events into renderable
 * turns. One function handles BOTH sources: a conversation's history jsonl
 * (GET /api/observatory/conversation/<id>) and the live SSE stream of a send —
 * they're the same event vocabulary (routes/observatory.py relays claude's
 * stream-json and logs what it relays), so history replay and live streaming
 * can't drift apart.
 *
 * Event shapes handled (everything else is ignored on purpose):
 * - {type:'user', text, off_record?}           her message (history only —
 *                                              the live sender pushes it
 *                                              locally via userTurn()).
 *                                              off_record: said with the
 *                                              journal paused — shown here
 *                                              like anything else she said,
 *                                              just dashed
 * - {type:'decision', decision, command}       a gated command she approved or
 *                                              denied — shown with the command
 * - {type:'reminder', text, source}            a Coming up reminder the app
 *                                              sent at its set time — shown as
 *                                              System, never as her words;
 *                                              source = who set it (manual =
 *                                              her, keeper = a Keeper)
 * - {type:'peer', direction, id, from_conv,     a message between two agents —
 *    from_title, to_conv, to_title, text,       'out' in the sender's chat, 'in'
 *    mode, status, held_reason}                 in the recipient's; drawn as a
 *                                              colored card
 * - {type:'questions', questions, ts}         a set of questions the agent
 *                                              filed for her
 *                                              (request_input.py) — drawn as
 *                                              an orange block where it was
 *                                              asked, kept after she answers
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

export interface Turn {
  role: 'user' | 'assistant' | 'gap' | 'error' | 'decision' | 'reminder' | 'peer' | 'questions';
  /** user/error: the text. assistant: committed markdown (authoritative).
   * decision: the exact command she approved/denied. reminder: what it says. */
  text: string;
  /** reminder only: who set it — 'manual' (her), 'keeper', or 'job' (a
   * background job reporting back — scripts/run_detached.py). */
  source?: 'manual' | 'keeper' | 'job';
  /** assistant only: in-flight delta text not yet confirmed by a message. */
  buffer: string;
  /** assistant only: still streaming. */
  open: boolean;
  /** user only: sent with the journal paused — kept in the chat log and
   * rendered dashed, but never minted into the journal. */
  offRecord: boolean;
  /** assistant only: current tool activity label ("reading files…"). */
  tool: string | null;
  /** assistant only: this reply was tapped into the journal (K card). */
  journaled: boolean;
  /** decision only: which way she called the gated command. */
  decision?: 'approve' | 'deny';
  /** questions only: the set the agent filed, in its order. */
  questions?: string[];
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

function turn(role: Turn['role'], text = ''): Turn {
  return { role, text, buffer: '', open: false, offRecord: false, tool: null, journaled: false };
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
  const fresh = { ...turn('assistant'), open: true };
  turns.push(fresh);
  return fresh;
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
        turns.push(userTurn(e.text, e.off_record === true));
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
        : e.source === 'run_detached' ? 'job' : 'manual';
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
      return turns;
    }
    case 'result':
    case 'done': {
      const last = turns[turns.length - 1];
      if (last && last.role === 'assistant') {
        last.open = false;
        last.tool = null;
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
 * 'answered' once she's sent a message since, 'replaced' when the agent filed
 * a newer set before she did (filing replaces, never appends), else 'open'.
 * Her message wins over a later filing — it's what the set was answered by. */
export type QuestionsState = 'open' | 'answered' | 'replaced';

export function questionsState(turns: Turn[], index: number): QuestionsState {
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
  }
  return turns;
}
