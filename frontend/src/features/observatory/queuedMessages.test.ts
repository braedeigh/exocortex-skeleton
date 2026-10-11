/**
 * queuedMessages — the queue's survival across a closed PWA: round-trips,
 * key hygiene, tolerance for corrupt storage, and the new-conversation
 * migration. Then the row merge: a message the server never got stays on
 * screen, and one it did get isn't shown twice. Then what a waiting row says
 * about why it waits, and what her message says once it landed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { turnsFromHistory } from './events';
import {
  arrivedNote,
  loadQueued,
  mergeQueueRows,
  pruneSettled,
  rowsFromServer,
  saveQueued,
  waitReason,
  type QueuedRow,
} from './queuedMessages';

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

describe('why a queued message is waiting, and where it landed', () => {
  const running = { running: true, policy: 'open' };

  it('names the step it is stuck behind, how long that has run, and what it is running', () => {
    const [row] = rowsFromServer([{ id: 3, text: 'wrong branch', record: true, handed: true }]);
    expect(row.state).toBe('handed');
    const why = waitReason(row, { ...running, step: { name: 'Bash', target: 'pytest -q', seconds: 250 } });
    expect(why?.text).toBe('the agent is running a command (4 min so far) — it reads this when that step ends');
    expect(why?.detail).toBe('pytest -q');
  });

  it('says so plainly when there is no step, no turn, or a session that only takes mail between turns', () => {
    const [row] = rowsFromServer([{ id: 3, text: 'x', record: true }]);
    expect(waitReason(row, { ...running, step: null })?.text).toMatch(/thinking/);
    expect(waitReason(row, { running: false, step: null, policy: 'open' })?.text).toMatch(/new turn/);
    expect(waitReason(row, { running: true, step: null, policy: 'queue-only' })?.text).toMatch(/between turns/);
  });

  it('says send now is under way once she pressed it, and nothing for rows the server never had', () => {
    const [row] = rowsFromServer([{ id: 3, text: 'x', record: true, rushed: true }]);
    expect(waitReason(row, { ...running, step: null })?.text).toMatch(/sending now/);
    expect(waitReason({ state: 'failed' }, { ...running, step: null })).toBeNull();
  });

  it('carries where a message landed from the transcript to the note under it', () => {
    const turns = turnsFromHistory([
      { type: 'user', text: 'run the suite' },
      { type: 'user', text: 'use the other table', arrived: { how: 'injected', after_step: 14 } },
      { type: 'user', text: 'stop', arrived: { how: 'interrupt' } },
      { type: 'user', text: 'plain' },
    ]);
    expect(turns.map((t) => (t.arrived ? arrivedNote(t.arrived) : null))).toEqual([
      null,
      'arrived mid-turn, after step 14',
      'sent now — stopped the step it was on and started a new turn',
      null,
    ]);
  });
});
