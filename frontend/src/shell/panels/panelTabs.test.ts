import { describe, expect, it } from 'vitest';
import {
  STALE_AFTER_MS,
  buildBar,
  closeTab,
  isOpen,
  openTab,
  pruneStale,
  touchTab,
  urlsOnBar,
  type LiveTab,
  type OpenTab,
} from './panelTabs';

const T0 = 1_700_000_000_000;
const HOUR = STALE_AFTER_MS;
const convUrl = (id: string) => `/observatory/session?conv=${id}`;

describe('opening and closing', () => {
  it('adds a tab at the end, keeping the order she opened them in', () => {
    let tabs: OpenTab[] = [];
    tabs = openTab(tabs, '/a', T0);
    tabs = openTab(tabs, '/b', T0 + 1);
    expect(tabs.map((t) => t.url)).toEqual(['/a', '/b']);
  });

  it('re-opening an open tab does not duplicate it or move it', () => {
    let tabs = openTab(openTab([], '/a', T0), '/b', T0);
    tabs = openTab(tabs, '/a', T0 + 500);
    expect(tabs.map((t) => t.url)).toEqual(['/a', '/b']);
    expect(tabs[0].at).toBe(T0 + 500);
  });

  it('returns the same array when nothing changed', () => {
    const tabs = openTab([], '/a', T0);
    expect(openTab(tabs, '/a', T0)).toBe(tabs);
    expect(closeTab(tabs, '/nope')).toBe(tabs);
  });

  it('closes, and reports what is open', () => {
    const tabs = openTab(openTab([], '/a', T0), '/b', T0);
    expect(isOpen(tabs, '/a')).toBe(true);
    expect(isOpen(closeTab(tabs, '/a'), '/a')).toBe(false);
  });
});

describe('what she has been ignoring drops off', () => {
  it('drops a tab untouched for an hour', () => {
    const tabs = openTab([], '/a', T0);
    expect(pruneStale(tabs, T0 + HOUR + 1, new Set())).toEqual([]);
  });

  it('touching something that is not open does not open it', () => {
    // Rendering the bar touches whatever the panel is showing. If that opened
    // a tab, every front page would get one beside its own anchor.
    const tabs = openTab([], '/a', T0);
    expect(touchTab(tabs, '/not-open', T0 + 5)).toBe(tabs);
  });

  it('keeps one touched inside the hour', () => {
    let tabs = openTab([], '/a', T0);
    tabs = touchTab(tabs, '/a', T0 + HOUR - 1);
    expect(pruneStale(tabs, T0 + HOUR + 1, new Set()).map((t) => t.url)).toEqual(['/a']);
  });

  it('never drops what the panel is actually showing', () => {
    // Reading one page for over an hour must not close it out from under her.
    const tabs = openTab([], '/a', T0);
    expect(pruneStale(tabs, T0 + HOUR * 5, new Set(['/a'])).map((t) => t.url)).toEqual(['/a']);
  });

  it('never drops a live session — being live is not being ignored', () => {
    const tabs = openTab([], convUrl('c1'), T0);
    expect(pruneStale(tabs, T0 + HOUR * 5, new Set([convUrl('c1')]))).toHaveLength(1);
  });
});

describe('building the bar', () => {
  const anchors = ['observatory'];
  const live: LiveTab[] = [
    { convId: 'c1', title: 'nightcrew triage', running: true, awaiting: false },
    { convId: 'c2', title: 'spark', running: false, awaiting: true },
  ];

  it('orders it anchors, then live, then open', () => {
    const bar = buildBar({
      anchors,
      live,
      open: [{ url: '/code?path=a.py', at: T0 }],
      now: T0,
      liveUrlFor: convUrl,
    });
    expect(bar.map((i) => i.kind)).toEqual(['anchor', 'live', 'live', 'open']);
  });

  it('groups awaiting-input with the live ones, flagged apart', () => {
    const bar = buildBar({ anchors: [], live, open: [], now: T0, liveUrlFor: convUrl });
    const items = bar.filter((i) => i.kind === 'live');
    expect(items).toHaveLength(2);
    expect(items.map((i) => (i.kind === 'live' ? [i.running, i.awaiting] : []))).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('shows a session that is both open and live exactly once', () => {
    // Twice would mean two mounted views of one conversation — the thing the
    // queue-ownership work exists to survive.
    const bar = buildBar({
      anchors: [],
      live: [live[0]],
      open: [{ url: convUrl('c1'), at: T0 }],
      now: T0,
      liveUrlFor: convUrl,
    });
    expect(bar).toHaveLength(1);
    expect(bar[0].kind).toBe('live');
  });

  it('leaves a stale open tab off without needing it pruned first', () => {
    const bar = buildBar({
      anchors: [],
      live: [],
      open: [{ url: '/code?path=a.py', at: T0 }],
      now: T0 + HOUR + 1,
      liveUrlFor: convUrl,
    });
    expect(bar).toEqual([]);
  });

  it('lists every url on the bar, so they can be kept mounted', () => {
    const bar = buildBar({
      anchors,
      live,
      open: [{ url: '/code?path=a.py', at: T0 }],
      now: T0,
      liveUrlFor: convUrl,
    });
    expect(urlsOnBar(bar)).toEqual([convUrl('c1'), convUrl('c2'), '/code?path=a.py']);
  });

  it('an anchor-only bar is still a bar', () => {
    const bar = buildBar({ anchors, live: [], open: [], now: T0, liveUrlFor: convUrl });
    expect(bar).toEqual([{ kind: 'anchor', sectionId: 'observatory' }]);
  });
});
