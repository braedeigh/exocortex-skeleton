import { describe, expect, it } from 'vitest';
import { buildContactLog, contactDraftFromPayload } from './contactApproval';

const TODAY = '2026-07-09';

describe('contactDraftFromPayload', () => {
  it('prefills from the staged payload, lowercasing the method', () => {
    expect(
      contactDraftFromPayload({ name: 'June', method: 'FaceTime', date: '2026-07-07' }, TODAY),
    ).toEqual({ name: 'June', method: 'facetime', date: '2026-07-07' });
  });

  it('falls back to call for a missing or unknown method (legacy select behavior)', () => {
    expect(contactDraftFromPayload({ name: 'June' }, TODAY).method).toBe('call');
    expect(contactDraftFromPayload({ name: 'June', method: 'carrier pigeon' }, TODAY).method).toBe(
      'call',
    );
  });

  it('defaults the date to today when the payload has none', () => {
    expect(contactDraftFromPayload({ name: 'June' }, TODAY).date).toBe(TODAY);
  });
});

describe('buildContactLog', () => {
  it('requires a non-blank name (legacy focused the name input)', () => {
    expect(buildContactLog({ name: '  ', method: 'call', date: TODAY }).ok).toBe(false);
  });

  it('builds the exact /api/contacts/log body — the same triple feeds the undo', () => {
    expect(buildContactLog({ name: ' June ', method: 'text', date: '2026-07-07' })).toEqual({
      ok: true,
      value: { name: 'June', method: 'text', date: '2026-07-07' },
    });
  });
});
