/**
 * sessionStatus.ts — the roster's status dot, one source of truth for three
 * things she can't otherwise tell at a glance: a turn is running server-side
 * (busy), it finished with activity she hasn't opened yet (ready), or there's
 * nothing new (idle). `openedAt` is read from the same `exo-bot-opened`
 * localStorage map RosterPage's unread accent already uses
 * (markConversationOpened in openedStore.ts writes it) — this doesn't
 * read storage itself so the roster stays the only place that touches it.
 */

export type SessionStatus = 'busy' | 'ready' | 'idle';

export interface SessionStatusMeta {
  running?: boolean;
  last_at?: string;
}

export function sessionStatus(meta: SessionStatusMeta, openedAt: string | undefined): SessionStatus {
  // A `running` flag here is already the server's effective value (routes/
  // observatory.py resolves staleness before this ever reaches the client)
  // — busy wins outright, regardless of last_at.
  if (meta.running) return 'busy';

  if (!meta.last_at) return 'idle';
  const last = Date.parse(meta.last_at);
  if (Number.isNaN(last)) return 'idle';

  if (!openedAt) return 'ready'; // never opened, but something's there
  const seen = Date.parse(openedAt);
  if (Number.isNaN(seen)) return 'ready';

  return last > seen ? 'ready' : 'idle';
}
