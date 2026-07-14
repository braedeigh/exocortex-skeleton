import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildTodoIndex,
  collectSnoozed,
  collectWaiting,
  collectUpNow,
  computeFocusCounts,
  focusMatch,
  fmtAddedDate,
  gateHides,
  inWindow,
  fmtDuration,
  fmtTime,
  isDoneSection,
  isOverdue,
  isSnoozed,
  isWaiting,
  withFocusTheme,
} from './todoHelpers';
import { frontLabel } from '../fronts/useFronts';
import type { Front } from '../fronts/useFronts';
import type { TodoItem, TodoSection } from './types';

const FRONTS: Front[] = [
  { id: 'job', name: 'Job' },
  { id: 'health', name: 'Health' },
];

const TODAY = '2026-07-08';

function item(overrides: Partial<TodoItem> = {}): TodoItem {
  return { id: 'a', text: 'Do a thing', done: false, ...overrides };
}

describe('isOverdue', () => {
  it('is overdue when due_by is before server_date', () => {
    expect(isOverdue('2026-07-07', TODAY)).toBe(true);
  });
  it('is not overdue when due today or in the future', () => {
    expect(isOverdue('2026-07-08', TODAY)).toBe(false);
    expect(isOverdue('2026-07-09', TODAY)).toBe(false);
  });
  it('is not overdue when unset', () => {
    expect(isOverdue(null, TODAY)).toBe(false);
  });
});

describe('isSnoozed', () => {
  it('is snoozed when snoozed_until is in the future and not done', () => {
    expect(isSnoozed(item({ snoozed_until: '2026-07-09' }), TODAY)).toBe(true);
  });
  it('is not snoozed once the wake date has passed', () => {
    expect(isSnoozed(item({ snoozed_until: '2026-07-08' }), TODAY)).toBe(false);
  });
  it('a done item is never snoozed', () => {
    expect(isSnoozed(item({ snoozed_until: '2026-07-09', done: true }), TODAY)).toBe(false);
  });
});

describe('focusMatch', () => {
  it('matches everything when theme is empty', () => {
    expect(focusMatch(item({ theme: 'job' }), '')).toBe(true);
  });
  it('__none__ matches only untagged items', () => {
    expect(focusMatch(item({ theme: undefined }), '__none__')).toBe(true);
    expect(focusMatch(item({ theme: 'job' }), '__none__')).toBe(false);
  });
  it('matches an exact theme', () => {
    expect(focusMatch(item({ theme: 'job' }), 'job')).toBe(true);
    expect(focusMatch(item({ theme: 'health' }), 'job')).toBe(false);
  });
  it('reads the fronts list (the live contract) too', () => {
    expect(focusMatch(item({ fronts: ['job', 'health'] }), 'job')).toBe(true);
    expect(focusMatch(item({ fronts: ['health'] }), 'job')).toBe(false);
    expect(focusMatch(item({ fronts: [] }), '__none__')).toBe(true);
    expect(focusMatch(item({ fronts: ['job'] }), '__none__')).toBe(false);
  });
});

describe('withFocusTheme', () => {
  it('stamps the active focus theme onto an add payload', () => {
    expect(withFocusTheme({ item: 'call Yan', section: 'Now' }, 'job')).toEqual({
      item: 'call Yan',
      section: 'Now',
      theme: 'job',
    });
  });
  it('stamps nothing on All or Other', () => {
    const payload = { item: 'call Yan', section: 'Now' };
    expect(withFocusTheme(payload, '')).toBe(payload);
    expect(withFocusTheme(payload, '__none__')).toBe(payload);
  });
  it('never overrides an explicit theme', () => {
    const payload = { item: 'call Yan', section: 'Now', theme: 'health' };
    expect(withFocusTheme(payload, 'job')).toBe(payload);
  });
});

describe('formatting helpers', () => {
  it('fmtTime converts 24h to 12h with am/pm', () => {
    expect(fmtTime('09:05')).toBe('9:05am');
    expect(fmtTime('13:30')).toBe('1:30pm');
    expect(fmtTime('00:00')).toBe('12:00am');
    expect(fmtTime(null)).toBe('');
  });

  it('fmtDuration renders minutes, hours, and mixed', () => {
    expect(fmtDuration(45)).toBe('45m');
    expect(fmtDuration(60)).toBe('1h');
    expect(fmtDuration(90)).toBe('1h30');
    expect(fmtDuration(0)).toBe('');
    expect(fmtDuration(null)).toBe('');
  });

  it('fmtAddedDate renders a short month/day label', () => {
    expect(fmtAddedDate('2026-07-08')).toBe('Jul 8');
    expect(fmtAddedDate(null)).toBe('');
  });
});

describe('addDays', () => {
  it('adds days and clears/handles month rollover', () => {
    expect(addDays('2026-07-08', 3)).toBe('2026-07-11');
    expect(addDays('2026-07-30', 3)).toBe('2026-08-02');
  });
});

describe('inWindow', () => {
  it('plain window: start inclusive, end exclusive', () => {
    const win = { start: '06:00', end: '17:00' };
    expect(inWindow(win, '06:00')).toBe(true);
    expect(inWindow(win, '12:30')).toBe(true);
    expect(inWindow(win, '17:00')).toBe(false);
    expect(inWindow(win, '05:59')).toBe(false);
  });
  it('start > end wraps past midnight', () => {
    const win = { start: '15:00', end: '06:00' };
    expect(inWindow(win, '15:00')).toBe(true);
    expect(inWindow(win, '23:45')).toBe(true);
    expect(inWindow(win, '02:00')).toBe(true);
    expect(inWindow(win, '06:00')).toBe(false);
    expect(inWindow(win, '12:00')).toBe(false);
  });
  it('degenerate windows never hide', () => {
    expect(inWindow({ start: '', end: '' }, '12:00')).toBe(true);
    expect(inWindow({ start: '09:00', end: '09:00' }, '12:00')).toBe(true);
  });
});

describe('gateHides', () => {
  // Bradie's real config: job shows 6am–5pm, everything else 3pm–6am.
  const rules = {
    windows: {
      job: { start: '06:00', end: '17:00' },
      '*': { start: '15:00', end: '06:00' },
    },
  };
  const MORNING = '09:00';
  const EVENING = '19:00';

  it('no rules = nothing hidden', () => {
    expect(gateHides(item({ theme: 'job' }), 'Later', undefined, EVENING, TODAY)).toBe(false);
    expect(gateHides(item({ theme: 'job' }), 'Later', {}, EVENING, TODAY)).toBe(false);
  });
  it('job hides in the evening, shows in the morning', () => {
    expect(gateHides(item({ theme: 'job' }), 'Later', rules, EVENING, TODAY)).toBe(true);
    expect(gateHides(item({ theme: 'job' }), 'Later', rules, MORNING, TODAY)).toBe(false);
  });
  it('life stuff (other fronts + untagged fall to *) hides in the morning, shows in the evening', () => {
    expect(gateHides(item({ theme: 'health' }), 'Later', rules, MORNING, TODAY)).toBe(true);
    expect(gateHides(item({}), 'Later', rules, MORNING, TODAY)).toBe(true);
    expect(gateHides(item({ theme: 'health' }), 'Later', rules, EVENING, TODAY)).toBe(false);
  });
  it('the Now section always punches through', () => {
    expect(gateHides(item({ theme: 'job' }), 'Now', rules, EVENING, TODAY)).toBe(false);
  });
  it('overdue and due-today punch through; future due dates do not', () => {
    expect(gateHides(item({ theme: 'job', due_by: '2026-07-01' }), 'Later', rules, EVENING, TODAY)).toBe(false);
    expect(gateHides(item({ theme: 'job', due_by: TODAY }), 'Later', rules, EVENING, TODAY)).toBe(false);
    expect(gateHides(item({ theme: 'job', due_by: '2026-08-01' }), 'Later', rules, EVENING, TODAY)).toBe(true);
  });
  it('a front with no window of its own and no * is never hidden', () => {
    const jobOnly = { windows: { job: { start: '06:00', end: '17:00' } } };
    expect(gateHides(item({ theme: 'health' }), 'Later', jobOnly, MORNING, TODAY)).toBe(false);
  });
  it('fronts list: any active window keeps the item visible', () => {
    // job window is active in the morning, so job+health shows even though
    // health (via *) is out of window.
    expect(gateHides(item({ fronts: ['job', 'health'] }), 'Later', rules, MORNING, TODAY)).toBe(false);
    expect(gateHides(item({ fronts: ['job', 'health'] }), 'Later', rules, EVENING, TODAY)).toBe(false);
    expect(gateHides(item({ fronts: ['health'] }), 'Later', rules, MORNING, TODAY)).toBe(true);
  });
});

describe('collectUpNow', () => {
  it('gathers overdue + due-today, skips done/snoozed/waiting/future, soonest first', () => {
    const sections: TodoSection[] = [
      section('Now', [
        item({ id: 'today', due_by: TODAY }),
        item({ id: 'future', due_by: '2026-08-01' }),
      ]),
      section('Later', [
        item({ id: 'overdue', due_by: '2026-07-01' }),
        item({ id: 'done', due_by: '2026-07-01', done: true }),
        item({ id: 'snoozed', due_by: '2026-07-01', snoozed_until: '2026-07-20' }),
        item({ id: 'waiting', due_by: '2026-07-01', after_date: '2026-08-01' }),
      ]),
      section('Done', [item({ id: 'in-done', due_by: '2026-07-01' })]),
    ];
    expect(collectUpNow(sections, TODAY).map((i) => i.id)).toEqual(['overdue', 'today']);
  });
});

describe('frontLabel', () => {
  it('resolves a known front id to emoji + name', () => {
    expect(frontLabel(FRONTS, 'job')).toBe('💼 Job');
  });
  it('resolves __none__ to Other', () => {
    expect(frontLabel(FRONTS, '__none__')).toBe('🏷️ Other');
  });
  it('falls back to the raw key for unknown fronts', () => {
    expect(frontLabel(FRONTS, 'mystery')).toBe('mystery');
  });
});

describe('isDoneSection', () => {
  it('matches Done regardless of case or trailing annotation', () => {
    expect(isDoneSection('Done')).toBe(true);
    expect(isDoneSection('done — archived')).toBe(true);
    expect(isDoneSection('Now')).toBe(false);
  });
});

function section(name: string, items: TodoItem[], manual_order = false): TodoSection {
  return { name, items, manual_order };
}

describe('computeFocusCounts', () => {
  it('counts live items by theme, excluding done, snoozed, and the Done section', () => {
    const sections: TodoSection[] = [
      section('Now', [
        item({ id: '1', theme: 'job' }),
        item({ id: '2', theme: 'job', done: true }),
        item({ id: '3', theme: 'health', snoozed_until: '2026-07-09' }),
        item({ id: '4' }),
      ]),
      section('Done', [item({ id: '5', theme: 'job', done: true })]),
    ];
    const counts = computeFocusCounts(sections, TODAY);
    expect(counts.total).toBe(2);
    expect(counts.byTheme.job).toBe(1);
    expect(counts.none).toBe(1);
    expect(counts.byTheme.health).toBeUndefined();
  });
});

describe('collectSnoozed', () => {
  it('gathers snoozed items across sections, sorted by wake date', () => {
    const sections: TodoSection[] = [
      section('Now', [item({ id: '1', snoozed_until: '2026-07-20' })]),
      section('Later', [item({ id: '2', snoozed_until: '2026-07-10' })]),
      section('Done', [item({ id: '3', snoozed_until: '2026-07-01', done: true })]),
    ];
    const snoozed = collectSnoozed(sections, TODAY);
    expect(snoozed.map((i) => i.id)).toEqual(['2', '1']);
  });

  it('excludes an item that is also waiting — Waiting wins over Snoozed', () => {
    const sections: TodoSection[] = [
      section('Now', [item({ id: '1', snoozed_until: '2026-07-20', after_date: '2026-08-01' })]),
    ];
    expect(collectSnoozed(sections, TODAY)).toEqual([]);
  });
});

describe('isWaiting', () => {
  it('blocks while after_date is in the future', () => {
    const sections: TodoSection[] = [section('Now', [item({ id: '1', after_date: '2026-08-01' })])];
    const index = buildTodoIndex(sections);
    expect(isWaiting(item({ id: '1', after_date: '2026-08-01' }), TODAY, index)).toBe(true);
  });

  it('unblocks once the date arrives', () => {
    const index = buildTodoIndex([]);
    expect(isWaiting(item({ after_date: TODAY }), TODAY, index)).toBe(false);
    expect(isWaiting(item({ after_date: '2026-07-01' }), TODAY, index)).toBe(false);
  });

  it('blocks while the referenced to-do exists and is not done', () => {
    const sections: TodoSection[] = [
      section('Now', [item({ id: 'blocker', done: false }), item({ id: 'a', after_id: 'blocker' })]),
    ];
    const index = buildTodoIndex(sections);
    expect(isWaiting(item({ id: 'a', after_id: 'blocker' }), TODAY, index)).toBe(true);
  });

  it('unblocks once the referenced to-do is done', () => {
    const sections: TodoSection[] = [
      section('Done', [item({ id: 'blocker', done: true })]),
      section('Now', [item({ id: 'a', after_id: 'blocker' })]),
    ];
    const index = buildTodoIndex(sections);
    expect(isWaiting(item({ id: 'a', after_id: 'blocker' }), TODAY, index)).toBe(false);
  });

  it('unblocks when the referenced to-do no longer exists', () => {
    const index = buildTodoIndex([section('Now', [item({ id: 'a', after_id: 'gone' })])]);
    expect(isWaiting(item({ id: 'a', after_id: 'gone' }), TODAY, index)).toBe(false);
  });

  it('with both fields set, unblocking is OR: still waiting only while both still block', () => {
    const sections: TodoSection[] = [
      section('Now', [item({ id: 'blocker', done: false })]),
    ];
    const index = buildTodoIndex(sections);
    const both = item({ id: 'a', after_date: '2026-08-01', after_id: 'blocker' });
    expect(isWaiting(both, TODAY, index)).toBe(true);

    // Date has arrived but blocker still open — unblocked (OR).
    const dateArrived = item({ id: 'a', after_date: '2026-07-01', after_id: 'blocker' });
    expect(isWaiting(dateArrived, TODAY, index)).toBe(false);

    // Blocker done but date still in the future — unblocked (OR).
    const doneIndex = buildTodoIndex([section('Done', [item({ id: 'blocker', done: true })])]);
    const blockerDone = item({ id: 'a', after_date: '2026-08-01', after_id: 'blocker' });
    expect(isWaiting(blockerDone, TODAY, doneIndex)).toBe(false);
  });

  it('a done item is never waiting', () => {
    const index = buildTodoIndex([]);
    expect(isWaiting(item({ after_date: '2026-08-01', done: true }), TODAY, index)).toBe(false);
  });
});

describe('collectWaiting', () => {
  it('collects waiting items with a human reason, excluding done sections', () => {
    const sections: TodoSection[] = [
      section('Now', [
        item({ id: '1', text: 'Unpack boxes', after_date: '2026-08-01' }),
        item({ id: 'blocker', text: 'Finish the move', done: false }),
        item({ id: '2', text: 'Celebrate', after_id: 'blocker' }),
        item({ id: '3', text: 'Not waiting' }),
      ]),
      section('Done', [item({ id: '4', after_date: '2026-08-01', done: true })]),
    ];
    const waiting = collectWaiting(sections, TODAY);
    expect(waiting.map((w) => w.item.id)).toEqual(['2', '1']);
    expect(waiting.find((w) => w.item.id === '1')?.reason).toBe('after Aug 1');
    expect(waiting.find((w) => w.item.id === '2')?.reason).toBe('after: Finish the move');
  });
});
