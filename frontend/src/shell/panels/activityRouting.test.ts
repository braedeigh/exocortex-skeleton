import { describe, expect, it } from 'vitest';
import type { LayoutNode, PanelNode } from './layoutTree';
import { activityUrl, routeActivity } from './activityRouting';
import { conversationUrl } from './conversationRouting';

/**
 * Where a session's Activity pane opens: already showing → reveal; another
 * activity panel → reuse it; otherwise a new pane beside the conversation.
 */

function panel(over: Partial<PanelNode> & { id: string }): PanelNode {
  return { type: 'panel', kind: 'route', ...over };
}

function row(...children: PanelNode[]): LayoutNode {
  return { type: 'split', id: 's', dir: 'row', sizes: children.map(() => 100 / children.length), children };
}

const CONV = 'abc123';

describe('routeActivity', () => {
  it('reveals a panel already showing this session’s activity', () => {
    const tree = row(panel({ id: 'a', url: activityUrl(CONV) }), panel({ id: 'p', kind: 'primary' }));
    expect(routeActivity(tree, CONV, '/todos')).toEqual({ kind: 'reveal', panelId: 'a' });
  });

  it('reuses an activity panel that shows another session', () => {
    const tree = row(panel({ id: 'a', url: activityUrl('other') }), panel({ id: 'p', kind: 'primary' }));
    expect(routeActivity(tree, CONV, '/todos')).toEqual({
      kind: 'show', panelId: 'a', isPrimary: false, url: activityUrl(CONV),
    });
  });

  it('splits beside the panel holding the conversation', () => {
    const tree = row(panel({ id: 'c', url: conversationUrl(CONV) }), panel({ id: 'p', kind: 'primary' }));
    expect(routeActivity(tree, CONV, '/todos')).toEqual({ kind: 'split', targetId: 'c', url: activityUrl(CONV) });
  });

  it('splits beside the primary panel when the conversation is nowhere in view', () => {
    const tree = row(panel({ id: 'm', url: '/terrain/files' }), panel({ id: 'p', kind: 'primary' }));
    expect(routeActivity(tree, CONV, '/todos')).toEqual({ kind: 'split', targetId: 'p', url: activityUrl(CONV) });
  });
});
