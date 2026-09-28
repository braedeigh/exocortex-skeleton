/**
 * queuedMessages — the queue's survival across a closed PWA: round-trips,
 * key hygiene, tolerance for corrupt storage, and the new-conversation
 * migration. Then the row merge: a message the server never got stays on
 * screen, and one it did get isn't shown twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadQueued, mergeQueueRows, pruneSettled, rowsFromServer, saveQueued, type QueuedRow } from './queuedMessages';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('save/load round-trip', () => {
  it('persists a queue per conversation and restores it', () => {
    saveQueued('keeper', 'conv-1', [{ text: 'first', offRecord: false }, { text: 'second', offRecord: true }]);
    expect(loadQueued('keeper', 'conv-1')).toEqual([
      { text: 'first', offRecord: false },
      { text: 'second', offRecord: true },
    ]);
    // a different conversation sees nothing
    expect(loadQueued('keeper', 'conv-2')).toEqual([]);
  });

  it('removes the key when the queue empties', () => {
    saveQueued('keeper', 'conv-1', [{ text: 'hi', offRecord: false }]);
    saveQueued('keeper', 'conv-1', []);
    expect(localStorage.getItem('exo-bot-queue:conv-1')).toBeNull();
  });

  it('stages an id-less conversation under the per-bot new key', () => {
    saveQueued('keeper', undefined, [{ text: 'hi', offRecord: false }]);
    expect(localStorage.getItem('exo-bot-queue:new-keeper')).not.toBeNull();
    expect(loadQueued('keeper')).toEqual([{ text: 'hi', offRecord: false }]);
  });
});

describe('corrupt or hostile storage', () => {
  it('returns an empty queue for malformed JSON', () => {
    localStorage.setItem('exo-bot-queue:conv-1', '{not json');
    expect(loadQueued('keeper', 'conv-1')).toEqual([]);
  });

  it('drops entries without a text string, defaults offRecord to false', () => {
    localStorage.setItem(
      'exo-bot-queue:conv-1',
      JSON.stringify([{ text: 'ok' }, { text: 42 }, null, 'plain', { offRecord: true }]),
    );
    expect(loadQueued('keeper', 'conv-1')).toEqual([{ text: 'ok', offRecord: false }]);
  });

  it('survives storage being unavailable entirely', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadQueued('keeper', 'conv-1')).toEqual([]);
    expect(() => saveQueued('keeper', 'conv-1', [{ text: 'hi', offRecord: false }])).not.toThrow();
  });
});

describe('queued rows: server list plus what the browser still holds', () => {
  const local = (key: string, state: QueuedRow['state'], extra: Partial<QueuedRow> = {}): QueuedRow => ({
    key,
    text: key,
    offRecord: false,
    state,
    ...extra,
  });

  it('keeps a row the server refused after a read that does not list it', () => {
    const rows = mergeQueueRows([], pruneSettled([local('l1', 'failed')], 1000));
    expect(rows.map((r) => r.key)).toEqual(['l1']);
  });

  it('keeps staged and still-sending rows through a read', () => {
    const kept = pruneSettled([local('l1', 'staged'), local('l2', 'sending')], 1000);
    expect(kept.map((r) => r.key)).toEqual(['l1', 'l2']);
  });

  it('does not show a confirmed row twice when the server lists it too', () => {
    const server = rowsFromServer([{ id: 7, text: 'hi', record: true }]);
    const rows = mergeQueueRows(server, [local('l1', 'sending', { id: 7, confirmedAt: 2000 })]);
    expect(rows.map((r) => r.key)).toEqual(['s7']);
  });

  it('keeps a confirmed row through a read that started before the confirmation', () => {
    const kept = pruneSettled([local('l1', 'sending', { id: 7, confirmedAt: 2000 })], 1500);
    expect(kept.map((r) => r.key)).toEqual(['l1']);
  });

  it('lets a later read speak for a confirmed row — gone once the agent took it', () => {
    expect(pruneSettled([local('l1', 'sending', { id: 7, confirmedAt: 2000 })], 2500)).toEqual([]);
  });

  it('carries the record flag over from the server as offRecord', () => {
    expect(rowsFromServer([{ id: 1, text: 'x', record: false }])[0].offRecord).toBe(true);
  });
});
