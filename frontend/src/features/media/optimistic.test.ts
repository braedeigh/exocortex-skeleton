import { describe, expect, it } from 'vitest';
import { applyMediaAdd, applyMediaRemove, applyMediaUpdate } from './optimistic';
import type { MediaData, MediaItem } from './types';

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'a1',
    title: 'Piranesi',
    type: 'book',
    author: 'Susanna Clarke',
    recommended_by: 'Dee',
    notes: 'weird and lovely',
    date: '2026-07-01',
    done: false,
    ...overrides,
  };
}

function data(items: MediaItem[]): MediaData {
  return { media: { items }, server_date: '2026-07-09' };
}

describe('applyMediaAdd', () => {
  it('appends the new item and keeps other response keys', () => {
    const next = applyMediaAdd(data([item()]), item({ id: 'b2', title: 'Arrival' }));
    expect(next.media?.items?.map((it) => it.id)).toEqual(['a1', 'b2']);
    expect(next.server_date).toBe('2026-07-09');
  });

  it('tolerates a response with no media slice yet', () => {
    const next = applyMediaAdd({}, item());
    expect(next.media?.items).toHaveLength(1);
  });
});

describe('applyMediaUpdate', () => {
  it('only changes fields present in the patch (done toggle keeps the rest)', () => {
    const next = applyMediaUpdate(data([item()]), { id: 'a1', done: true });
    const it0 = next.media?.items?.[0];
    expect(it0?.done).toBe(true);
    expect(it0?.title).toBe('Piranesi');
    expect(it0?.notes).toBe('weird and lovely');
  });

  it('stores an empty date as null, like the server', () => {
    const next = applyMediaUpdate(data([item()]), { id: 'a1', date: '' });
    expect(next.media?.items?.[0].date).toBeNull();
  });

  it('leaves other items untouched and unknown ids a no-op', () => {
    const start = data([item(), item({ id: 'b2', title: 'Arrival' })]);
    const next = applyMediaUpdate(start, { id: 'b2', title: 'Arrival (2016)' });
    expect(next.media?.items?.[0]).toEqual(start.media?.items?.[0]);
    expect(next.media?.items?.[1].title).toBe('Arrival (2016)');
    expect(applyMediaUpdate(start, { id: 'zzz', title: 'x' }).media?.items).toEqual(
      start.media?.items,
    );
  });
});

describe('applyMediaRemove', () => {
  it('removes exactly the matching id', () => {
    const next = applyMediaRemove(data([item(), item({ id: 'b2' })]), 'a1');
    expect(next.media?.items?.map((it) => it.id)).toEqual(['b2']);
  });
});
