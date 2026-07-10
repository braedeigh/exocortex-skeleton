import { describe, expect, it } from 'vitest';
import { collectGenericPayload, genericFieldsFromPayload, labelize } from './genericApproval';

describe('labelize', () => {
  it('turns snake_case keys into readable labels (legacy _label)', () => {
    expect(labelize('due_by')).toBe('Due by');
    expect(labelize('text')).toBe('Text');
  });
});

describe('genericFieldsFromPayload', () => {
  it('types bucket as a dropdown, numbers as numeric, everything else as text', () => {
    const fields = genericFieldsFromPayload({ bucket: 'later', count: 3, text: 'hi', gone: null });
    expect(fields.map((f) => [f.key, f.kind, f.initial])).toEqual([
      ['bucket', 'bucket', 'later'],
      ['count', 'number', '3'],
      ['text', 'text', 'hi'],
      ['gone', 'text', ''],
    ]);
  });
});

describe('collectGenericPayload', () => {
  const fields = genericFieldsFromPayload({ bucket: 'later', count: 3, text: 'hi' });

  it('coerces edited numeric fields back to Number (legacy dataset.numeric)', () => {
    const out = collectGenericPayload(fields, { bucket: 'now', count: '7', text: 'bye' });
    expect(out).toEqual({ bucket: 'now', count: 7, text: 'bye' });
  });

  it('leaves an emptied numeric field as "" (legacy `v !== ""` guard)', () => {
    const out = collectGenericPayload(fields, { bucket: 'later', count: '', text: 'hi' });
    expect(out.count).toBe('');
  });

  it('falls back to the initial value when a field was never touched', () => {
    const out = collectGenericPayload(fields, {});
    expect(out).toEqual({ bucket: 'later', count: 3, text: 'hi' });
  });
});
