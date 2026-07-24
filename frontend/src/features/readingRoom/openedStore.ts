/**
 * openedStore.ts — single owner of the 'exo-bot-opened' localStorage map:
 * which conversations she's opened, and when. ReadingRoomPage marks a
 * conversation opened on load; RosterPage reads the whole map to compare
 * against each conversation's last_at for the unread dot.
 */

/** Mark a conversation opened (the roster's unread dot compares this
 * against the index's last_at). Returns the PREVIOUS stamp for this
 * conversation (or null if it had none) — the caller needs that stamp to
 * decide, before overwriting it, whether THIS open is catching up on
 * unread activity (see isUnread below). */
export function markConversationOpened(convId: string): string | null {
  try {
    // 'exo-bot-opened' predates the reading-room rename (07-24) — the
    // persona concept ("bot") stays, so this on-disk/localStorage name is
    // deliberately unchanged.
    const raw = localStorage.getItem('exo-bot-opened');
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const prev = map[convId] ?? null;
    map[convId] = new Date().toISOString();
    localStorage.setItem('exo-bot-opened', JSON.stringify(map));
    return prev;
  } catch {
    // storage disabled — unread dots just stay conservative
    return null;
  }
}

/** True iff `lastAt` postdates `openedAt` — the one comparison behind both
 * the roster's unread dot and the reading room's open-at-unread scroll
 * anchor, kept in one place so they can't drift apart. A conversation with
 * no last_at is never unread; one never opened is unread the moment it has
 * any activity at all. Date.parse, NOT string order: the server stamps
 * last_at in zoneless local time while this store stamps UTC-with-Z —
 * lexically incomparable, but Date.parse reads both onto the same clock. */
export function isUnread(lastAt: unknown, openedAt: string | null | undefined): boolean {
  if (typeof lastAt !== 'string' || !lastAt) return false;
  if (!openedAt) return true;
  return Date.parse(lastAt) > Date.parse(openedAt);
}

export function openedMap(): Record<string, string> {
  try {
    // 'exo-bot-opened' predates the reading-room rename (07-24) — the
    // persona concept ("bot") stays, so this on-disk/localStorage name is
    // deliberately unchanged.
    const raw = localStorage.getItem('exo-bot-opened');
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
