/**
 * botsApi.ts — typed calls for the bot surface (routes/bots.py).
 * Roster/conversation reads use the shared api client; the send is a raw
 * fetch because it streams: the endpoint answers with SSE frames and the
 * response body is read incrementally (EventSource can't POST).
 */
import { api } from '../../api/client';

export interface BotConvMeta {
  id: string;
  bot: string;
  title: string;
  started: string;
  last_at: string;
  cost_usd: number;
  claude_session_id: string | null;
  /** false = a non-diary session: logs to its own jsonl, never mints cards. */
  journal?: boolean;
}

export interface BotInfo {
  id: string;
  name: string;
  journal: boolean;
  conversations: BotConvMeta[];
}

export function getBots(signal?: AbortSignal): Promise<{ bots: BotInfo[] }> {
  return api.get('/api/bots', signal);
}

export function getConversation(
  id: string,
  signal?: AbortSignal,
): Promise<{ id: string; meta: BotConvMeta; events: unknown[] }> {
  return api.get(`/api/bots/conversation/${encodeURIComponent(id)}`, signal);
}

/** Create a named session ahead of its first message ('+ New session'). */
export function createConversation(
  bot: string,
  title: string,
  journal: boolean,
): Promise<{ ok: true; id: string }> {
  return api.post(`/api/bots/${encodeURIComponent(bot)}/conversations`, { title, journal });
}

export function renameConversation(id: string, title: string): Promise<{ ok: true; title: string }> {
  return api.post(`/api/bots/conversation/${encodeURIComponent(id)}/title`, { title });
}

export interface SendOptions {
  conversationId?: string;
  record: boolean;
  signal?: AbortSignal;
}

/**
 * Send one turn and stream its events. `onEvent` fires per SSE frame with the
 * parsed event object (the same vocabulary botEvents.ts reduces). Resolves
 * with the conversation id (fresh conversations get theirs from the first
 * 'conv' frame) when the stream ends; rejects on transport failure or an
 * error status — the caller restores the composer text on rejection.
 */
export async function streamSend(
  bot: string,
  text: string,
  opts: SendOptions,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<string | undefined> {
  const res = await fetch(`/api/bots/${encodeURIComponent(bot)}/send`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      text,
      record: opts.record,
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `send failed (${res.status})`);
  }

  let convId = opts.conversationId;
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
        convId = event.conversation_id;
      }
      onEvent(event);
    }
  }
  return convId;
}
