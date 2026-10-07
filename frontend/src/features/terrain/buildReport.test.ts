import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  groupCommitsByDay,
  isBackupCommit,
  spanLabel,
  summaryLine,
  type BuildCommit,
} from './buildReport';

/** A unix second from LOCAL wall time, so these tests read the same in any
 * timezone the suite runs in. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute).getTime() / 1000);
}

function commit(ts: number, subject: string, added = 1, removed = 0): BuildCommit {
  return { sha: subject, ts, author: 'Test', subject, files: 1, added, removed };
}

describe('groupCommitsByDay', () => {
  it('puts each commit on its own local day, newest day first, and sums the day', () => {
    const days = groupCommitsByDay([
      commit(at(2026, 10, 1, 11), 'Docs', 5, 1),
      commit(at(2026, 10, 1, 0, 1), 'Just after midnight', 2, 0),
      commit(at(2026, 9, 30, 23, 59), 'Just before midnight', 3, 4),
    ]);

    expect(days.map((d) => d.day)).toEqual(['2026-10-01', '2026-09-30']);
    expect(days[0].commits.map((c) => c.subject)).toEqual(['Docs', 'Just after midnight']);
    expect([days[0].added, days[0].removed]).toEqual([7, 1]);
    expect(days[1].commits.map((c) => c.subject)).toEqual(['Just before midnight']);
  });

  it('gives each day a range that holds exactly its own commits', () => {
    const commits = [
      commit(at(2026, 10, 1, 0, 0), 'first second'),
      commit(at(2026, 9, 30, 23, 59), 'last minute'),
    ];
    const [later, earlier] = groupCommitsByDay(commits);

    // The range is what a tap on the day hands to the map's date dial, so it
    // must take in the day's first second and stop short of the next day's.
    expect(later.from).toBe(at(2026, 10, 1, 0, 0));
    expect(later.to).toBe(at(2026, 10, 2, 0, 0) - 1);
    expect(earlier.to).toBeLessThan(later.from);
    expect(commits[1].ts).toBeGreaterThanOrEqual(earlier.from);
  });

  it('returns nothing for no commits', () => {
    expect(groupCommitsByDay([])).toEqual([]);
  });
});

describe('the labels', () => {
  it('names a day with its weekday', () => {
    expect(dayLabel('2026-10-01')).toBe('Thu 1 Oct 2026');
  });

  it('writes a span as one date, two dates, or two dates with both years', () => {
    expect(spanLabel(at(2026, 10, 1, 1), at(2026, 10, 1, 11))).toBe('1 Oct 2026');
    expect(spanLabel(at(2026, 9, 30), at(2026, 10, 1))).toBe('30 Sep – 1 Oct 2026');
    expect(spanLabel(at(2025, 12, 31), at(2026, 1, 2))).toBe('31 Dec 2025 – 2 Jan 2026');
    expect(spanLabel(null, null)).toBe('');
  });

  it('summarises a build in one line, and says so when there is no history', () => {
    expect(
      summaryLine({
        commits: 23, files: 153, first: at(2026, 10, 1, 1), last: at(2026, 10, 1, 11),
        added: 9000, removed: 120, days: 1,
      }),
    ).toBe('23 commits · 153 files · 1 Oct 2026');
    expect(
      summaryLine({ commits: 1, files: 1, first: at(2026, 10, 1), last: at(2026, 10, 1), added: 1, removed: 0, days: 1 }),
    ).toBe('1 commit · 1 file · 1 Oct 2026');
    expect(summaryLine(null)).toBe('No commits indexed yet');
  });
});

describe('isBackupCommit', () => {
  it('picks out the hourly backup and nothing a person wrote', () => {
    const subjects = [
      'Auto-backup 2026-10-06_2100',
      'Terrain: the main map gets the Report too',
      'Fix the Auto-backup script',
      '',
    ];
    expect(subjects.filter((subject) => isBackupCommit(commit(0, subject)))).toEqual([
      'Auto-backup 2026-10-06_2100',
    ]);
  });
});
