import { describe, expect, it } from 'vitest';
import type { TerrainData } from '../api';
import type { FlowEvent } from '../flow/api';
import { agentWorkingSet, findSnippetRange, portholeWindow } from './workshopMath';

function terrain(files: {
  repo: string;
  path: string;
  sessions: { id: string; writes: number; reads?: number; creates?: number; last: string | null }[];
}[]): TerrainData {
  const byRepo = new Map<string, typeof files>();
  for (const f of files) {
    const list = byRepo.get(f.repo) ?? [];
    list.push(f);
    byRepo.set(f.repo, list);
  }
  return {
    generated_at: 'now',
    window_days: null,
    file_cap: null,
    repos: [...byRepo.entries()].map(([id, fs]) => ({
      id,
      name: id,
      root: `/${id}`,
      files_total: fs.length,
      files: fs.map((f) => ({
        path: f.path,
        touches: [],
        sessions: f.sessions.map((s) => ({ title: 'Agent', reads: 0, creates: 0, ...s })),
      })),
    })),
  };
}

function event(over: Partial<FlowEvent> & { repo: string; path: string; epoch: number }): FlowEvent {
  return {
    id: `${over.repo}:${over.path}:${over.epoch}`,
    conv: 'agent-1',
    title: 'Agent',
    bot: null,
    running: true,
    kind: 'edit',
    place: 'code',
    fronts: [],
    ts: null,
    snippet: null,
    snippet_total_lines: 0,
    ...over,
  };
}

describe('agentWorkingSet', () => {
  it('keeps only files this agent has written, newest first', () => {
    const data = terrain([
      { repo: 'skeleton', path: 'old.py', sessions: [{ id: 'agent-1', writes: 2, last: '2026-08-01T00:00:00' }] },
      { repo: 'skeleton', path: 'new.py', sessions: [{ id: 'agent-1', writes: 1, last: '2026-08-02T00:00:00' }] },
      { repo: 'skeleton', path: 'read-only.py', sessions: [{ id: 'agent-1', writes: 0, reads: 5, last: '2026-08-03T00:00:00' }] },
      { repo: 'skeleton', path: 'other-agent.py', sessions: [{ id: 'agent-2', writes: 9, last: '2026-08-03T00:00:00' }] },
    ]);
    const set = agentWorkingSet(data, 'agent-1', []);
    expect(set.map((f) => f.path)).toEqual(['new.py', 'old.py']);
  });

  it('a live event refreshes recency and carries the newest snippet', () => {
    const data = terrain([
      { repo: 'skeleton', path: 'a.py', sessions: [{ id: 'agent-1', writes: 1, last: '2026-08-01T00:00:00' }] },
      { repo: 'skeleton', path: 'b.py', sessions: [{ id: 'agent-1', writes: 1, last: '2026-08-02T00:00:00' }] },
    ]);
    const ev = event({ repo: 'skeleton', path: 'a.py', epoch: 4102444800, snippet: 'x = 1' });
    const set = agentWorkingSet(data, 'agent-1', [ev]);
    expect(set[0].path).toBe('a.py'); // the event outdates b.py's history
    expect(set[0].event?.snippet).toBe('x = 1');
  });

  it('an event on a file terrain has not attributed yet still joins the set', () => {
    const set = agentWorkingSet(terrain([]), 'agent-1', [
      event({ repo: 'skeleton', path: 'fresh.py', epoch: 100, kind: 'create' }),
    ]);
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ path: 'fresh.py', creates: 1 });
  });
});

describe('findSnippetRange', () => {
  const content = ['def a():', '    x = 1', '', 'def b():', '    x = 1', '    y = 2'].join('\n');

  it('anchors on the first line and prefers the spot where the rest also agrees', () => {
    // "x = 1" appears twice; only the second is followed by "y = 2".
    expect(findSnippetRange(content, '  x = 1\n  y = 2')).toEqual({ start: 4, end: 5 });
  });

  it('returns null when the text is no longer in the file', () => {
    expect(findSnippetRange(content, 'gone_forever()')).toBeNull();
    expect(findSnippetRange(content, '   \n  ')).toBeNull();
  });
});

describe('portholeWindow', () => {
  it('centres on the edit and clamps to the file', () => {
    expect(portholeWindow(100, { start: 50, end: 51 }, 20)).toEqual({ start: 40, end: 59 });
    expect(portholeWindow(100, { start: 0, end: 1 }, 20)).toEqual({ start: 0, end: 19 });
    expect(portholeWindow(100, { start: 99, end: 99 }, 20)).toEqual({ start: 80, end: 99 });
  });

  it('with no located edit shows the head — the file introducing itself', () => {
    expect(portholeWindow(100, null, 20)).toEqual({ start: 0, end: 19 });
    expect(portholeWindow(5, null, 20)).toEqual({ start: 0, end: 4 });
  });
});
