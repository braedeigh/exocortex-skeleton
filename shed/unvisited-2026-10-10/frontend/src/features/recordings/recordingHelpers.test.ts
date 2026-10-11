import { describe, expect, it } from 'vitest';
import {
  attachmentSummary,
  filterRecordings,
  formatBytes,
  formatClock,
  formatDuration,
  formatRecordingDate,
  presentKinds,
} from './recordingHelpers';
import type { Recording } from './types';

function rec(overrides: Partial<Recording> = {}): Recording {
  return {
    id: 'a',
    title: 'Lab training',
    date: '2026-08-05',
    kind: 'training',
    source: '',
    notes: '',
    duration: '',
    tags: [],
    audio: null,
    transcript: null,
    ...overrides,
  };
}

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('drops the decimal once MB get big, and says nothing for nothing', () => {
    expect(formatBytes(40 * 1024 * 1024)).toBe('40 MB');
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(undefined)).toBe('');
  });
});

describe('formatDuration', () => {
  it('reads as hours and minutes for a long recording', () => {
    expect(formatDuration(3600 * 2 + 60 * 14)).toBe('2h 14m');
  });

  it('drops seconds once there is an hour on the clock', () => {
    // Seconds are noise on a long training; they are not on a short memo.
    expect(formatDuration(3600 + 45)).toBe('1h 0m');
    expect(formatDuration(119)).toBe('1m 59s');
  });

  it('keeps seconds for short memos and stays empty on garbage', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(200)).toBe('3m 20s');
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });
});

describe('formatClock', () => {
  it('is mm:ss and never rounds up past the audio clock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(119.9)).toBe('1:59');
    expect(formatClock(3661)).toBe('1:01:01');
  });
});

describe('formatRecordingDate', () => {
  it('says so when there is no date', () => {
    expect(formatRecordingDate('')).toBe('No date');
  });

  it('passes an unparseable string through rather than inventing a day', () => {
    expect(formatRecordingDate('sometime in June')).toBe('sometime in June');
  });
});

describe('attachmentSummary', () => {
  it('names what is actually attached', () => {
    expect(attachmentSummary(rec())).toBe('Nothing attached yet');
    expect(
      attachmentSummary(rec({ transcript: { filename: 't.txt', bytes: 10, added_at: '', words: 4200 } })),
    ).toBe('Transcript · 4,200 words');
  });

  it('folds duration and size into the audio half', () => {
    const summary = attachmentSummary(
      rec({ duration: '2h 14m', audio: { filename: 'a.m4a', bytes: 40 * 1024 * 1024, added_at: '' } }),
    );
    expect(summary).toBe('Audio · 2h 14m · 40 MB');
  });
});

describe('filterRecordings', () => {
  const items = [
    rec({ id: '1', title: 'Lab training', kind: 'training', tags: ['wgs'] }),
    rec({ id: '2', title: 'Doctor visit', kind: 'appointment', notes: 'follow up' }),
    rec({ id: '3', title: 'Voice note', kind: 'voice-memo', source: 'iPhone' }),
  ];
  const ids = (list: Recording[]) => list.map((r) => r.id);

  it('matches title, tags, notes and source', () => {
    expect(ids(filterRecordings(items, 'wgs', 'all'))).toEqual(['1']);
    expect(ids(filterRecordings(items, 'follow', 'all'))).toEqual(['2']);
    expect(ids(filterRecordings(items, 'iphone', 'all'))).toEqual(['3']);
  });

  it('narrows by kind, and combines with the query', () => {
    expect(ids(filterRecordings(items, '', 'training'))).toEqual(['1']);
    expect(ids(filterRecordings(items, 'lab', 'appointment'))).toEqual([]);
  });

  it('does NOT reach into transcripts — that is the server search', () => {
    const withText = [
      rec({ id: '1', title: 'Lab training', transcript: { filename: 't.txt', bytes: 1, added_at: '', preview: 'beads on the magnet' } }),
    ];
    expect(filterRecordings(withText, 'magnet', 'all')).toEqual([]);
  });

  it('returns everything for an empty query', () => {
    expect(ids(filterRecordings(items, '   ', 'all'))).toEqual(['1', '2', '3']);
  });
});

describe('presentKinds', () => {
  it('lists only the kinds actually on the shelf, sorted', () => {
    const items = [rec({ kind: 'training' }), rec({ kind: 'appointment' }), rec({ kind: 'training' })];
    expect(presentKinds(items)).toEqual(['appointment', 'training']);
  });
});
