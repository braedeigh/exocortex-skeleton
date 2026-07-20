import { describe, expect, it } from 'vitest';
import {
  bucketToLabel,
  buildTodoAdd,
  normalizePlaceId,
  todoDraftFromPayload,
  todoFinalForLedger,
} from './todoApproval';
import type { TodoDraft } from './todoApproval';

function draft(overrides: Partial<TodoDraft> = {}): TodoDraft {
  return {
    text: 'Call the vet',
    sectionLabel: 'Now',
    dueBy: '',
    dueTime: '',
    notes: '',
    fronts: [],
    placeId: '',
    durationMin: '',
    ...overrides,
  };
}

describe('bucketToLabel', () => {
  it('maps bucket keys to the labels /api/todos/add resolves sections by', () => {
    expect(bucketToLabel('now')).toBe('Now');
    expect(bucketToLabel('up_next')).toBe('Up Next');
    expect(bucketToLabel('later')).toBe('Later');
    expect(bucketToLabel('someday')).toBe('Someday');
  });

  it('passes unknown keys through raw (legacy `_BUCKET_LABELS[s] || s`)', () => {
    expect(bucketToLabel('inbox')).toBe('inbox');
  });
});

describe('todoDraftFromPayload', () => {
  it('prefills every native field from the staged payload', () => {
    const d = todoDraftFromPayload({
      text: 'Refill meds',
      bucket: 'up_next',
      due_by: '2026-07-12',
      due_time: '09:30',
      notes: 'pharmacy on 5th',
      fronts: ['health', 'connection'],
      place_id: 'p1',
      duration_min: 30,
    });
    expect(d).toEqual({
      text: 'Refill meds',
      sectionLabel: 'Up Next',
      dueBy: '2026-07-12',
      dueTime: '09:30',
      notes: 'pharmacy on 5th',
      fronts: ['health', 'connection'],
      placeId: 'p1',
      durationMin: '30',
    });
  });

  it('defaults a missing bucket to Now (legacy `p.bucket || "now"`)', () => {
    expect(todoDraftFromPayload({ text: 'x' }).sectionLabel).toBe('Now');
  });

  it('treats a legacy theme/category string as a one-front list (older staged items)', () => {
    expect(todoDraftFromPayload({ text: 'x', theme: 'health' }).fronts).toEqual(['health']);
    expect(todoDraftFromPayload({ text: 'x', category: 'body' }).fronts).toEqual(['body']);
    expect(todoDraftFromPayload({ text: 'x' }).fronts).toEqual([]);
    // the live fronts list wins over any legacy string riding along
    expect(todoDraftFromPayload({ text: 'x', fronts: ['job'], theme: 'health' }).fronts).toEqual(['job']);
  });
});

describe('buildTodoAdd', () => {
  it('requires non-blank text', () => {
    const r = buildTodoAdd(draft({ text: '   ' }));
    expect(r.ok).toBe(false);
  });

  it('maps the full field set onto the native /api/todos/add body', () => {
    const r = buildTodoAdd(
      draft({
        text: '  Call the vet ',
        sectionLabel: 'Later',
        dueBy: '2026-07-12',
        dueTime: '09:30',
        notes: ' bring records ',
        fronts: ['health', 'errands'],
        placeId: 'p1',
        durationMin: '45',
      }),
    );
    expect(r).toEqual({
      ok: true,
      value: {
        item: 'Call the vet',
        section: 'Later',
        due_by: '2026-07-12',
        notes: 'bring records',
        due_time: '09:30',
        place_id: 'p1',
        fronts: ['health', 'errands'],
        duration_min: 45,
      },
    });
  });

  it('omits duration when blank and numbers it otherwise', () => {
    const blank = buildTodoAdd(draft());
    expect(blank.ok && 'duration_min' in blank.value).toBe(false);
    const filled = buildTodoAdd(draft({ durationMin: ' 20 ' }));
    expect(filled.ok && filled.value.duration_min).toBe(20);
  });

  it('clears the "__new__" place sentinel (legacy guard)', () => {
    expect(normalizePlaceId('__new__')).toBe('');
    const r = buildTodoAdd(draft({ placeId: '__new__' }));
    expect(r.ok && r.value.place_id).toBe('');
  });
});

describe('todoFinalForLedger', () => {
  it('logs what was kept, with bucket carrying the section LABEL (legacy)', () => {
    const final = todoFinalForLedger(
      draft({ text: ' Call the vet ', sectionLabel: 'Up Next', durationMin: '15' }),
    );
    expect(final.text).toBe('Call the vet');
    expect(final.bucket).toBe('Up Next');
    expect(final.duration_min).toBe('15');
    expect(Object.keys(final).sort()).toEqual([
      'bucket',
      'due_by',
      'due_time',
      'duration_min',
      'fronts',
      'notes',
      'place_id',
      'text',
    ]);
  });
});
