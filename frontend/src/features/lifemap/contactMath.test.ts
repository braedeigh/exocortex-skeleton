import { describe, expect, it } from 'vitest';
import {
  cleanContactSnoozes,
  contactStatus,
  historyByDate,
  lastMethodOn,
} from './contactMath';
import type { Contact } from './types';

function contact(days_since: number | null, threshold_days = 14): Contact {
  return { name: 'Dad', threshold_days, days_since };
}

describe('contactStatus', () => {
  it('never contacted -> red', () => {
    expect(contactStatus(contact(null))).toEqual({ color: 'var(--red)', statusText: 'Never contacted' });
  });

  it('today -> green "Today"', () => {
    expect(contactStatus(contact(0))).toEqual({ color: 'var(--green)', statusText: 'Today' });
  });

  it('under a week -> green with singular/plural days', () => {
    expect(contactStatus(contact(1))).toEqual({ color: 'var(--green)', statusText: '1 day ago' });
    expect(contactStatus(contact(6))).toEqual({ color: 'var(--green)', statusText: '6 days ago' });
  });

  it('a week+ but under threshold -> yellow', () => {
    expect(contactStatus(contact(9))).toEqual({ color: 'var(--yellow)', statusText: '9 days ago' });
  });

  it('at/over threshold -> red', () => {
    expect(contactStatus(contact(14))).toEqual({ color: 'var(--red)', statusText: '14 days ago' });
    expect(contactStatus(contact(30))).toEqual({ color: 'var(--red)', statusText: '30 days ago' });
  });
});

describe('historyByDate / lastMethodOn', () => {
  it('groups by date keeping order; last method wins for the dot', () => {
    const byDate = historyByDate([
      { date: '2026-07-01', method: 'call' },
      { date: '2026-07-01', method: 'text' },
      { date: '2026-07-03', method: 'visit' },
    ]);
    expect(byDate['2026-07-01']).toEqual(['call', 'text']);
    expect(lastMethodOn(byDate, '2026-07-01')).toBe('text');
    expect(lastMethodOn(byDate, '2026-07-02')).toBeNull();
  });
});

describe('cleanContactSnoozes', () => {
  it('keeps only snoozes set today', () => {
    const cleaned = cleanContactSnoozes(
      { Dad: '2026-07-09', Mom: '2026-07-08', Sis: '2026-07-09' },
      '2026-07-09',
    );
    expect(cleaned).toEqual({ Dad: '2026-07-09', Sis: '2026-07-09' });
  });

  it('handles empty/missing maps', () => {
    expect(cleanContactSnoozes(null, '2026-07-09')).toEqual({});
  });
});
