import { describe, expect, it } from 'vitest';
import {
  buildBar,
  closeTab,
  moveTab,
  neighbourAfterClose,
  openTab,
  type OpenTab,
  type SessionState,
} from './panelTabs';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const convUrl = (id: string) => `/observatory/session?conv=${id}`;

/** The roster's answer, as TabBar wires it: a running c1, a waiting c2. */
const roster = new Map<string, SessionState>([
  [convUrl('c1'), { running: true, awaiting: false }],
  [convUrl('c2'), { running: false, awaiting: true }],
]);
const stateFor = (url: string) => roster.get(url) ?? null;
const bar = (open: OpenTab[], anchors: string[] = ['observatory']) => buildBar({ anchors, open, stateFor });
const urls = (items: ReturnType<typeof bar>) => items.map((i) => (i.kind === 'anchor' ? `#${i.sectionId}` : i.url));

describe('the bar holds the anchors and what she opened — nothing else', () => {
  it('a running or waiting session she never opened is not on it', () => {
    expect(urls(bar([{ url: '/code?path=a.py', at: T0 }]))).toEqual(['#observatory', '/code?path=a.py']);
  });

  it('a session she did open wears its state, and other tabs wear none', () => {
    const items = bar([
      { url: convUrl('c1'), at: T0 },
      { url: convUrl('c2'), at: T0 },
      { url: '/code?path=a.py', at: T0 },
    ]);
    expect(items.slice(1).map((i) => (i.kind === 'open' ? [i.running, i.awaiting] : null))).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it('a tab is still there days later — nothing ages off', () => {
    // The age is in the saved tab, not the bar's inputs; there is no clock to
    // drop it by.
    const tabs = openTab([], convUrl('c9'), T0 - 5 * DAY);
    expect(urls(bar(tabs))).toEqual(['#observatory', convUrl('c9')]);
  });

  it('a closed tab stays off until she opens it again, and comes back at the end', () => {
    let tabs = openTab(openTab(openTab([], '/a', T0), '/b', T0), '/c', T0);
    tabs = closeTab(tabs, '/a');
    expect(urls(bar(tabs, []))).toEqual(['/b', '/c']);
    // Arriving there again is what reopens it (Workspace.rememberArrival).
    tabs = openTab(tabs, '/a', T0 + 1);
    expect(urls(bar(tabs, []))).toEqual(['/b', '/c', '/a']);
  });

  it('opening one already open neither duplicates nor moves it', () => {
    const tabs = openTab(openTab([], '/a', T0), '/b', T0);
    const again = openTab(tabs, '/a', T0 + 500);
    expect(again.map((t) => t.url)).toEqual(['/a', '/b']);
    expect(openTab(again, '/a', T0 + 500)).toBe(again);
    expect(closeTab(again, '/nope')).toBe(again);
  });
});

describe('dragging to rearrange', () => {
  const tabs: OpenTab[] = ['/a', '/b', '/c', '/d'].map((url) => ({ url, at: T0 }));

  it('moves one tab and leaves every other in its order, both directions', () => {
    expect(moveTab(tabs, 0, 2).map((t) => t.url)).toEqual(['/b', '/c', '/a', '/d']);
    expect(moveTab(tabs, 3, 1).map((t) => t.url)).toEqual(['/a', '/d', '/b', '/c']);
  });

  it('a drop that lands nowhere, or where it started, leaves the same list', () => {
    expect(moveTab(tabs, 1, 1)).toBe(tabs);
    expect(moveTab(tabs, -1, 2)).toBe(tabs);
    expect(moveTab(tabs, 0, 4)).toBe(tabs);
  });
});

describe('where closing the tab she is on lands her', () => {
  const tabs: OpenTab[] = ['/a', '/b', '/c'].map((url) => ({ url, at: T0 }));

  it('on the tab to the right, or the left one at the end of the row', () => {
    expect(neighbourAfterClose(tabs, '/b')).toBe('/c');
    expect(neighbourAfterClose(tabs, '/a')).toBe('/b');
    expect(neighbourAfterClose(tabs, '/c')).toBe('/b');
  });

  it('nowhere when it was the only tab, so the caller goes to the front page', () => {
    expect(neighbourAfterClose([{ url: '/a', at: T0 }], '/a')).toBeNull();
    expect(neighbourAfterClose(tabs, '/not-open')).toBeNull();
  });
});
