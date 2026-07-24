/**
 * api.ts — typed calls for the reading room (routes/reading_room.py).
 * Roster/conversation reads use the shared api client; the send is a raw
 * fetch because it streams: the endpoint answers with SSE frames and the
 * response body is read incrementally (EventSource can't POST).
 *
 * Session-first (07-24): the "bot" persona concept dissolved server-side —
 * a session carries its own config now instead of belonging to one of a
 * handful of named bots. GET /api/reading-room's `bots` key is legacy and
 * unused here; `sessions` is the flat roster.
 */
import { api } from '../../api/client';

export interface SessionMeta {
  id: string;
  title: string;
  last_at: string;
  /** false = a non-diary session: logs to its own jsonl, never mints cards. */
  journal?: boolean;
  /** Pinned sessions sort first (the Keeper session lives at the top). */
  pinned?: boolean;
  /** Cached Haiku one-liner of what the session is working on. */
  summary?: string;
  /** A turn is running server-side right now — turns outlive their HTTP
   * connection, so a re-attaching client polls this to know whether to
   * keep waiting. */
  running?: boolean;
  /** A staged first message, set server-side (e.g. by an automation that
   * wants her to fire it herself) — a non-empty draft prefills the compose
   * box once on open (see ReadingRoomPage's draft-prefill effect). */
  draft?: string;
}

export function getSessions(signal?: AbortSignal): Promise<{ sessions: SessionMeta[] }> {
  return api.get('/api/reading-room', signal);
}

export function getConversation(
  id: string,
  signal?: AbortSignal,
): Promise<{ id: string; meta: SessionMeta; events: unknown[] }> {
  return api.get(`/api/reading-room/conversation/${encodeURIComponent(id)}`, signal);
}

/** Create a session ahead of its first message — the roster's '+ New
 * session', and the reading room's own blank-compose first send (the old
 * create-implicitly-on-send flow is gone; the client drives it explicitly
 * now). The server picks the rest of the config (cwd/tools) itself. */
export function createSession(title: string, journal: boolean): Promise<{ ok: true; id: string }> {
  return api.post('/api/reading-room/conversations', { title, journal });
}

/** Put one keeper reply into the journal (a K card) — the tap gesture.
 * Works in any session regardless of its journal switch. */
export function journalOutput(convId: string, text: string): Promise<{ ok: true }> {
  return api.post(`/api/reading-room/conversation/${encodeURIComponent(convId)}/journal-output`, { text });
}

/** Close (archive) a session — it leaves the roster; its log stays. The
 * pinned Keeper session refuses (400). */
export function closeConversation(id: string): Promise<{ ok: true }> {
  return api.post(`/api/reading-room/conversation/${encodeURIComponent(id)}/close`, {});
}

/** Stop a running turn on purpose — the stop button's door. This is the only
 * thing that kills a turn now; a dropped connection never does. */
export function stopConversation(convId: string): Promise<{ ok: true }> {
  return api.post(`/api/reading-room/conversation/${encodeURIComponent(convId)}/stop`, {});
}

export function updateConversation(
  id: string,
  patch: { title?: string; journal?: boolean },
): Promise<{ ok: true; conversation: SessionMeta }> {
  return api.post(`/api/reading-room/conversation/${encodeURIComponent(id)}/settings`, patch);
}

export interface SendOptions {
  record: boolean;
  signal?: AbortSignal;
}

/**
 * Send one turn on an existing conversation and stream its events. `onEvent`
 * fires per SSE frame with the parsed event object (the same vocabulary
 * events.ts reduces). Resolves with the conversation id (echoed back on the
 * first 'conv' frame) when the stream ends; rejects on transport failure or
 * an error status — the caller restores the composer text on rejection.
 *
 * The conversation must already exist (createSession first) — the old
 * implicit-create-on-send is gone; this only ever sends into a known id.
 */
export async function streamSend(
  convId: string,
  text: string,
  opts: SendOptions,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<string | undefined> {
  const res = await fetch(`/api/reading-room/conversation/${encodeURIComponent(convId)}/send`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({ text, record: opts.record }),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `send failed (${res.status})`);
  }

  let convIdOut: string | undefined = convId;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    // SSE frames are blank-line separated; keep the trailing partial frame.
    const frames = pending.split('\n\n');
    pending = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data: ')) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
      } catch {
        continue; // torn frame — the next one resyncs us
      }
      if (event.type === 'conv' && typeof event.conversation_id === 'string') {
        convIdOut = event.conversation_id;
      }
      onEvent(event);
    }
  }
  return convIdOut;
}
