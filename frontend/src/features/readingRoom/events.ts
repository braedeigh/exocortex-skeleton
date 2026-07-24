/**
 * events.ts — pure reducer turning the bot pipe's events into renderable
 * turns. One function handles BOTH sources: a conversation's history jsonl
 * (GET /api/reading-room/conversation/<id>) and the live SSE stream of a send —
 * they're the same event vocabulary (routes/reading_room.py relays claude's
 * stream-json and logs what it relays), so history replay and live streaming
 * can't drift apart.
 *
 * Event shapes handled (everything else is ignored on purpose):
 * - {type:'user', text}                        her message (history only —
 *                                              the live sender pushes it
 *                                              locally via userTurn())
 * - {type:'off-record-gap'}                    deliberate hole in the record
 * - {type:'stream_event', event}               token deltas / tool activity
 * - {type:'assistant', message}                authoritative message text
 * - {type:'user', message}                     claude's tool-result echo — not
 *                                              her; ignored
 * - {type:'result'} / {type:'done'}            turn closes
 * - {type:'error', error}                      surfaced as its own turn
 */

export interface Turn {
  role: 'user' | 'assistant' | 'gap' | 'error';
  /** user/error: the text. assistant: committed markdown (authoritative). */
  text: string;
  /** assistant only: in-flight delta text not yet confirmed by a message. */
  buffer: string;
  /** assistant only: still streaming. */
  open: boolean;
  /** user only: sent off the record (rendered dashed, never persisted). */
  offRecord: boolean;
  /** assistant only: current tool activity label ("reading files…"). */
  tool: string | null;
  /** assistant only: this reply was tapped into the journal (K card). */
  journaled: boolean;
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
        turns.push(userTurn(e.text, false));
      }
      // {type:'user', message} is claude echoing a tool result — ignored
      return turns;
    }
    case 'off-record-gap':
      turns.push(turn('gap'));
      return turns;
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
    default:
      return turns;
  }
}

/** Index of the last user turn, or -1 if she's never sent one. The open-at-
 * unread scroll anchor (ReadingRoomPage's history-load effect) needs this:
 * catching up on unread activity means landing on HER last message, not the
 * conversation's last turn (which is usually the reply she hasn't read). */
export function lastUserTurnIndex(turns: Turn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return i;
  }
  return -1;
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
