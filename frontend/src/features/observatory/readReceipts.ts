/**
 * readReceipts.ts — single owner of the 'exo-bot-opened' localStorage map:
 * which conversations she's opened, and when. The read-receipt ledger behind
 * every unread dot. ObservatoryPage marks a conversation opened on load;
 * RosterPage reads the whole map to compare against each conversation's
 * last_at. (Live "which sessions are open right now" is presence.ts — a
 * different question with a different clock.)
 *
 * Opening isn't the only way a card goes read: setConversationRead lets her
 * say so by hand from the roster, in either direction — including putting a
 * card BACK to unread, which is the only way to re-raise something she opened
 * and then didn't deal with.
 *
 * (This file was openedStore.ts until 08-03 — renamed because it and the
 * presence store differed by two characters while meaning opposite things.
 * The localStorage key is untouched: her existing read state carries over.)
 */

/** Mark a conversation opened (the roster's unread dot compares this
 * against the index's last_at). Returns the PREVIOUS stamp for this
 * conversation (or null if it had none) — the caller needs that stamp to
 * decide, before overwriting it, whether THIS open is catching up on
 * unread activity (see isUnread below). */
export function markConversationOpened(convId: string): string | null {
  try {
    // 'exo-bot-opened' predates the observatory rename (07-24) — the
    // localStorage name is deliberately frozen so read state survives.
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

/** Set a conversation's read state by hand, from the roster's dot button.
 *
 * READ stamps now, exactly like opening it would have. UNREAD *deletes* the
 * stamp rather than backdating it — an absent entry is already "never opened",
 * which isUnread treats as unread for anything with activity, so the two ways
 * of being unread stay one case instead of two. It also means the flag can't
 * rot: whatever the session does next, the card is unread until she opens it.
 *
 * Prompt that produced it: "an option to unmark things as read somewhere". */
export function setConversationRead(convId: string, read: boolean): void {
  try {
    const raw = localStorage.getItem('exo-bot-opened');
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (read) map[convId] = new Date().toISOString();
    else delete map[convId];
    localStorage.setItem('exo-bot-opened', JSON.stringify(map));
  } catch {
    // storage disabled — the tap just doesn't stick
  }
}

/** True iff `lastAt` postdates `openedAt` — the one comparison behind both
 * the roster's unread dot and the observatory's open-at-unread scroll
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
    const raw = localStorage.getItem('exo-bot-opened');
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
