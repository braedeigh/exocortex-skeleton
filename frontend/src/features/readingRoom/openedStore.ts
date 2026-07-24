/**
 * openedStore.ts — single owner of the 'exo-bot-opened' localStorage map:
 * which conversations she's opened, and when. ReadingRoomPage marks a
 * conversation opened on load; RosterPage reads the whole map to compare
 * against each conversation's last_at for the unread dot.
 */

/** Mark a conversation opened (the roster's unread dot compares this
 * against the index's last_at). */
export function markConversationOpened(convId: string): void {
  try {
    // 'exo-bot-opened' predates the reading-room rename (07-24) — the
    // persona concept ("bot") stays, so this on-disk/localStorage name is
    // deliberately unchanged.
    const raw = localStorage.getItem('exo-bot-opened');
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[convId] = new Date().toISOString();
    localStorage.setItem('exo-bot-opened', JSON.stringify(map));
  } catch {
    // storage disabled — unread dots just stay conservative
  }
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
