/**
 * queuedMessages — the queue's survival across a closed PWA: round-trips,
 * key hygiene, tolerance for corrupt storage, and the new-conversation
 * migration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadQueued, migrateNewQueue, saveQueued } from './queuedMessages';

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

describe('migrateNewQueue', () => {
  it('moves staged messages to the conversation key and clears the stage', () => {
    saveQueued('keeper', undefined, [{ text: 'staged', offRecord: false }]);
    migrateNewQueue('keeper', 'conv-9');
    expect(loadQueued('keeper', 'conv-9')).toEqual([{ text: 'staged', offRecord: false }]);
    expect(loadQueued('keeper')).toEqual([]);
  });

  it('appends after anything already queued on the conversation', () => {
    saveQueued('keeper', 'conv-9', [{ text: 'earlier', offRecord: false }]);
    saveQueued('keeper', undefined, [{ text: 'staged', offRecord: true }]);
    migrateNewQueue('keeper', 'conv-9');
    expect(loadQueued('keeper', 'conv-9')).toEqual([
      { text: 'earlier', offRecord: false },
      { text: 'staged', offRecord: true },
    ]);
  });

  it('is a no-op when nothing is staged', () => {
    saveQueued('keeper', 'conv-9', [{ text: 'earlier', offRecord: false }]);
    migrateNewQueue('keeper', 'conv-9');
    expect(loadQueued('keeper', 'conv-9')).toEqual([{ text: 'earlier', offRecord: false }]);
  });
});
