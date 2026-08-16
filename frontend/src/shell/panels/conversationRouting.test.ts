import { describe, expect, it } from 'vitest';
import type { LayoutNode, PanelNode } from './layoutTree';
import { conversationUrl, routeConversation, windowAcceptsConversations } from './conversationRouting';

/**
 * The owner's rule for where a conversation opens, checked in order:
 * visible → reveal; a background tab → switch; an observatory panel → new tab
 * there; nowhere observatory → a new pane. Plus the gate: a window with no
 * observatory presence at all doesn't claim conversations.
 */

function panel(over: Partial<PanelNode> & { id: string }): PanelNode {
  return { type: 'panel', kind: 'route', ...over };
}

function row(...children: PanelNode[]): LayoutNode {
  return {
    type: 'split',
    id: 's',
    dir: 'row',
    sizes: children.map(() => 100 / children.length),
    children,
  };
}

const CONV = 'abc123';
const CONV_URL = conversationUrl(CONV);

describe('the window gate', () => {
  it('a pure watching window (terrain + flow) does not claim conversations', () => {
    const tree = row(
      panel({ id: 'map', url: '/terrain/map' }),
      panel({ id: 'p', kind: 'primary' }),
    );
    expect(windowAcceptsConversations(tree, '/terrain/flow')).toBe(false);
  });

  it('an observatory panel, a conversation panel, or even just an observatory tab qualifies', () => {
    const roster = row(panel({ id: 'o', url: '/observatory' }), panel({ id: 'p', kind: 'primary' }));
    expect(windowAcceptsConversations(roster, '/todos')).toBe(true);

    const viaPrimary = row(panel({ id: 'c', url: '/code' }), panel({ id: 'p', kind: 'primary' }));
    expect(windowAcceptsConversations(viaPrimary, conversationUrl('zzz'))).toBe(true);

    const viaTab = row(
      panel({ id: 'c', url: '/code', tabs: [{ url: conversationUrl('zzz'), at: 1 }] }),
      panel({ id: 'p', kind: 'primary' }),
    );
    expect(windowAcceptsConversations(viaTab, '/todos')).toBe(true);
  });
});

describe('rule 1 — already visible: open nothing, point at it', () => {
  it('finds it in a route panel', () => {
    const tree = row(panel({ id: 'o', url: CONV_URL }), panel({ id: 'p', kind: 'primary' }));
    expect(routeConversation(tree, CONV, '/todos')).toEqual({ kind: 'reveal', panelId: 'o' });
  });

  it('finds it in the primary panel via the real address', () => {
    const tree = row(panel({ id: 'o', url: '/observatory' }), panel({ id: 'p', kind: 'primary' }));
    expect(routeConversation(tree, CONV, CONV_URL)).toEqual({ kind: 'reveal', panelId: 'p' });
  });
});

describe('rule 2 — a background tab: that panel switches to it', () => {
  it('reuses the tab own url, params intact', () => {
    const tabUrl = `${CONV_URL}&scroll=42`;
    const tree = row(
      panel({ id: 'o', url: '/observatory', tabs: [{ url: tabUrl, at: 1 }] }),
      panel({ id: 'p', kind: 'primary' }),
    );
    expect(routeConversation(tree, CONV, '/todos')).toEqual({
      kind: 'show',
      panelId: 'o',
      isPrimary: false,
      url: tabUrl,
    });
  });
});

describe('rule 3 — an observatory panel takes it as a new tab', () => {
  it('prefers a roster panel over one reading another conversation, and the primary last', () => {
    const tree = row(
      panel({ id: 'reading', url: conversationUrl('other') }),
      panel({ id: 'roster', url: '/observatory' }),
      panel({ id: 'p', kind: 'primary' }),
    );
    expect(routeConversation(tree, CONV, '/observatory')).toEqual({
      kind: 'show',
      panelId: 'roster',
      isPrimary: false,
      url: CONV_URL,
    });
  });

  it('falls to the primary when it alone shows the observatory', () => {
    const tree = row(panel({ id: 'c', url: '/code' }), panel({ id: 'p', kind: 'primary' }));
    expect(routeConversation(tree, CONV, '/observatory')).toEqual({
      kind: 'show',
      panelId: 'p',
      isPrimary: true,
      url: CONV_URL,
    });
  });
});

describe('rule 4 — nowhere observatory: a new pane is born', () => {
  it('splits off the primary', () => {
    // Qualification is the caller's gate (windowAcceptsConversations); the
    // router itself still answers for a window with, say, only an
    // observatory tab somewhere — the conversation must not evict that
    // panel's current page, so it gets its own pane.
    const tree = row(
      panel({ id: 'c', url: '/code', tabs: [{ url: conversationUrl('zzz'), at: 1 }] }),
      panel({ id: 'p', kind: 'primary' }),
    );
    expect(routeConversation(tree, CONV, '/todos')).toEqual({
      kind: 'split',
      targetId: 'p',
      url: CONV_URL,
    });
  });
});

describe('the reading room is not this rule s business', () => {
  it('a pane panel is ignored even when it exists', () => {
    const tree = row(
      { type: 'panel', id: 'rr', kind: 'pane' },
      panel({ id: 'p', kind: 'primary' }),
    );
    expect(routeConversation(tree, CONV, '/observatory')).toEqual({
      kind: 'show',
      panelId: 'p',
      isPrimary: true,
      url: CONV_URL,
    });
  });
});
