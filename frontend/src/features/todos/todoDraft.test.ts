import { describe, expect, it } from 'vitest';
import { diffDraftForSave, draftFromItem, draftToAddPayload, emptyDraft } from './todoDraft';
import type { TodoDraft } from './todoDraft';
import type { TodoItem } from './types';

function baseItem(overrides: Partial<TodoItem> = {}): TodoItem {
  return { id: 'a', text: 'Call the pharmacy', done: false, ...overrides };
}

function draft(overrides: Partial<TodoDraft> = {}): TodoDraft {
  return { ...emptyDraft('Now'), text: 'Call the pharmacy', ...overrides };
}

describe('emptyDraft', () => {
  it('starts blank, presets the section, and leaves snooze untouched', () => {
    const d = emptyDraft('Later');
    expect(d).toMatchObject({
      text: '',
      section: 'Later',
      notes: '',
      dueBy: '',
      fronts: [],
      durationMin: '',
      snoozeDays: null,
    });
  });
  it('applies prefill text/dueBy/fronts', () => {
    const d = emptyDraft('Now', { text: 'Buy milk', dueBy: '2026-08-01', fronts: ['errands'] });
    expect(d.text).toBe('Buy milk');
    expect(d.dueBy).toBe('2026-08-01');
    expect(d.fronts).toEqual(['errands']);
  });
});

describe('draftFromItem', () => {
  it('normalizes null/undefined fields to empty string/array and leaves snooze untouched', () => {
    const d = draftFromItem(baseItem(), 'Now');
    expect(d).toMatchObject({
      text: 'Call the pharmacy',
      section: 'Now',
      notes: '',
      dueBy: '',
      dueTime: '',
      afterDate: '',
      afterId: '',
      fronts: [],
      durationMin: '',
      snoozeDays: null,
    });
  });
  it('carries over populated fields, stringifying duration', () => {
    const item = baseItem({
      notes: 'ask about refills',
      due_by: '2026-08-01',
      due_time: '09:00',
      fronts: ['health', 'errands'],
      duration_min: 30,
      after_date: '2026-08-05',
      after_id: 'blocker-1',
    });
    const d = draftFromItem(item, 'Up Next');
    expect(d).toMatchObject({
      notes: 'ask about refills',
      dueBy: '2026-08-01',
      dueTime: '09:00',
      fronts: ['health', 'errands'],
      durationMin: '30',
      afterDate: '2026-08-05',
      afterId: 'blocker-1',
    });
  });
});

describe('diffDraftForSave — title', () => {
  it('reports newText when the trimmed title differs', () => {
    const item = baseItem();
    const d = draft({ text: 'Call the vet' });
    expect(diffDraftForSave(d, item, 'Now').newText).toBe('Call the vet');
  });
  it('omits newText when the title is unchanged', () => {
    const item = baseItem();
    const d = draft({ text: 'Call the pharmacy' });
    expect(diffDraftForSave(d, item, 'Now').newText).toBeUndefined();
  });
  it('omits newText for a whitespace-only title', () => {
    const item = baseItem();
    const d = draft({ text: '   ' });
    expect(diffDraftForSave(d, item, 'Now').newText).toBeUndefined();
  });
});

describe('diffDraftForSave — patch', () => {
  it('a cleared due date maps to patch.due_by === "" ', () => {
    const item = baseItem({ due_by: '2026-08-01' });
    const d = draftFromItem(item, 'Now');
    d.dueBy = '';
    expect(diffDraftForSave(d, item, 'Now').patch.due_by).toBe('');
  });
  it('an unchanged item diffs to an empty patch, no moveTo, no snoozeDays', () => {
    const item = baseItem({ notes: 'x', due_by: '2026-08-01', fronts: ['health'], duration_min: 15 });
    const d = draftFromItem(item, 'Now');
    const diff = diffDraftForSave(d, item, 'Now');
    expect(diff.patch).toEqual({});
    expect(diff.moveTo).toBeUndefined();
    expect(diff.snoozeDays).toBeUndefined();
  });
});

describe('diffDraftForSave — fronts', () => {
  it('adding a front produces a patch with the new set', () => {
    const item = baseItem({ fronts: ['health'] });
    const d = draftFromItem(item, 'Now');
    d.fronts = ['health', 'errands'];
    expect(diffDraftForSave(d, item, 'Now').patch.fronts).toEqual(['health', 'errands']);
  });
  it('removing a front produces a patch with the smaller set', () => {
    const item = baseItem({ fronts: ['health', 'errands'] });
    const d = draftFromItem(item, 'Now');
    d.fronts = ['health'];
    expect(diffDraftForSave(d, item, 'Now').patch.fronts).toEqual(['health']);
  });
  it('clearing all fronts sends an empty array', () => {
    const item = baseItem({ fronts: ['health'] });
    const d = draftFromItem(item, 'Now');
    d.fronts = [];
    expect(diffDraftForSave(d, item, 'Now').patch.fronts).toEqual([]);
  });
  it('reordering the same set is not a change', () => {
    const item = baseItem({ fronts: ['a', 'b'] });
    const d = draftFromItem(item, 'Now');
    d.fronts = ['b', 'a'];
    expect(diffDraftForSave(d, item, 'Now').patch).not.toHaveProperty('fronts');
  });
});

describe('diffDraftForSave — section/snooze', () => {
  it('a section change reports moveTo', () => {
    const item = baseItem();
    const d = draftFromItem(item, 'Now');
    d.section = 'Later';
    expect(diffDraftForSave(d, item, 'Now').moveTo).toBe('Later');
  });
  it('snoozeDays 0 (explicit clear) is passed through', () => {
    const item = baseItem();
    const d = draftFromItem(item, 'Now');
    d.snoozeDays = 0;
    expect(diffDraftForSave(d, item, 'Now').snoozeDays).toBe(0);
  });
  it('snoozeDays N is passed through', () => {
    const item = baseItem();
    const d = draftFromItem(item, 'Now');
    d.snoozeDays = 3;
    expect(diffDraftForSave(d, item, 'Now').snoozeDays).toBe(3);
  });
  it('snoozeDays null (untouched) is omitted', () => {
    const item = baseItem();
    const d = draftFromItem(item, 'Now');
    expect(diffDraftForSave(d, item, 'Now').snoozeDays).toBeUndefined();
  });
});

describe('diffDraftForSave — duration', () => {
  it('setting a duration from none sends the parsed int', () => {
    const item = baseItem();
    const d = draftFromItem(item, 'Now');
    d.durationMin = '45';
    expect(diffDraftForSave(d, item, 'Now').patch.duration_min).toBe(45);
  });
  it('clearing a duration sends 0', () => {
    const item = baseItem({ duration_min: 45 });
    const d = draftFromItem(item, 'Now');
    d.durationMin = '';
    expect(diffDraftForSave(d, item, 'Now').patch.duration_min).toBe(0);
  });
  it('round-trips: set then unset nets no residual patch key when back to original', () => {
    const item = baseItem({ duration_min: 45 });
    const d = draftFromItem(item, 'Now');
    expect(diffDraftForSave(d, item, 'Now').patch).not.toHaveProperty('duration_min');
  });
});

describe('draftToAddPayload', () => {
  it('maps text to item and omits empty optional keys', () => {
    const d = draft({ text: '  Buy milk  ' });
    expect(draftToAddPayload(d)).toEqual({ item: 'Buy milk', section: 'Now' });
  });
  it('includes only the fields that carry a value', () => {
    const d = draft({
      text: 'Buy milk',
      dueBy: '2026-08-01',
      dueTime: '09:00',
      notes: 'skim',
      afterDate: '2026-08-02',
      afterId: 'blocker-1',
      fronts: ['errands'],
      durationMin: '20',
    });
    expect(draftToAddPayload(d)).toEqual({
      item: 'Buy milk',
      section: 'Now',
      due_by: '2026-08-01',
      due_time: '09:00',
      notes: 'skim',
      after_date: '2026-08-02',
      after_id: 'blocker-1',
      fronts: ['errands'],
      duration_min: 20,
    });
  });
  it('a non-positive duration is treated as unset', () => {
    const d = draft({ durationMin: '0' });
    expect(draftToAddPayload(d)).not.toHaveProperty('duration_min');
  });
});

describe('draftFromItem -> diffDraftForSave round-trip', () => {
  it('a fresh draft from an item diffs back to an empty diff (sanity check)', () => {
    const item = baseItem({
      notes: 'ask about refills',
      due_by: '2026-08-01',
      due_time: '09:00',
      fronts: ['health', 'errands'],
      duration_min: 30,
      after_date: '2026-08-05',
      after_id: 'blocker-1',
    });
    const d = draftFromItem(item, 'Up Next');
    const diff = diffDraftForSave(d, item, 'Up Next');
    expect(diff).toEqual({ patch: {} });
  });
});
