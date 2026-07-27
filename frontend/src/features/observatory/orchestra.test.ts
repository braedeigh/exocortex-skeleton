import { describe, expect, it } from 'vitest';
import { orchestraRows } from './orchestra';
import type { SessionMeta } from './api';
import type { TerrainData } from '../terrain/api';

const session = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: id,
  last_at: '2026-07-26T12:00:00Z',
  running: true,
  ...over,
});

// A minimal terrain payload — only the fields orchestraRows reads.
const terrain = (
  repos: Array<{
    id: string;
    files: Array<{
      path: string;
      sessions: Array<{ id: string; writes?: number; reads?: number; creates?: number }>;
    }>;
  }>,
): TerrainData =>
  ({
    generated_at: '',
    window_days: 90,
    file_cap: 350,
    repos: repos.map((r) => ({
      id: r.id,
      name: r.id,
      root: '/' + r.id,
      files_total: r.files.length,
      files: r.files.map((f) => ({
        path: f.path,
        touches: [],
        sessions: f.sessions.map((s) => ({
          id: s.id,
          title: s.id,
          writes: s.writes ?? 0,
          reads: s.reads ?? 0,
          creates: s.creates,
          last: null,
        })),
      })),
    })),
  }) as TerrainData;

describe('orchestraRows', () => {
  it('marries running sessions with the files they are writing', () => {
    const rows = orchestraRows(
      [session('a')],
      terrain([{ id: 'skeleton', files: [{ path: 'routes/x.py', sessions: [{ id: 'a', writes: 2 }] }] }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('a');
    expect(rows[0].fileCount).toBe(1);
    expect(rows[0].files[0]).toMatchObject({ repo: 'skeleton', path: 'routes/x.py', writes: 2 });
  });

  it('keeps a running session with no footprint yet (empty file list, not dropped)', () => {
    const rows = orchestraRows([session('a')], terrain([]));
    expect(rows).toHaveLength(1);
    expect(rows[0].fileCount).toBe(0);
  });

  it('ignores footprints from sessions that are not in the running roster', () => {
    const rows = orchestraRows(
      [session('a')],
      terrain([{ id: 'skeleton', files: [{ path: 'y.py', sessions: [{ id: 'ghost', writes: 5 }] }] }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fileCount).toBe(0);
  });

  it('drops pure reads — Orchestra shows work being produced, not glanced at', () => {
    const rows = orchestraRows(
      [session('a')],
      terrain([
        {
          id: 'skeleton',
          files: [
            { path: 'read-only.py', sessions: [{ id: 'a', reads: 9, writes: 0 }] },
            { path: 'written.py', sessions: [{ id: 'a', writes: 1 }] },
          ],
        },
      ]),
    );
    expect(rows[0].files.map((f) => f.path)).toEqual(['written.py']);
  });

  it('counts a create even when writes is not separately reported', () => {
    const rows = orchestraRows(
      [session('a')],
      terrain([{ id: 'skeleton', files: [{ path: 'fresh.py', sessions: [{ id: 'a', creates: 1, writes: 0 }] }] }]),
    );
    expect(rows[0].fileCount).toBe(1);
    expect(rows[0].files[0].creates).toBe(1);
  });

  it('sorts a session’s files most-active first, then by path', () => {
    const rows = orchestraRows(
      [session('a')],
      terrain([
        {
          id: 'skeleton',
          files: [
            { path: 'b.py', sessions: [{ id: 'a', writes: 1 }] },
            { path: 'a.py', sessions: [{ id: 'a', writes: 1 }] },
            { path: 'hot.py', sessions: [{ id: 'a', writes: 9 }] },
          ],
        },
      ]),
    );
    expect(rows[0].files.map((f) => f.path)).toEqual(['hot.py', 'a.py', 'b.py']);
  });

  it('preserves the roster order of the running sessions', () => {
    const rows = orchestraRows([session('b'), session('a')], terrain([]));
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('carries running + awaiting state onto each row', () => {
    const rows = orchestraRows(
      [
        session('run', { running: true }),
        session('ask', { running: false, awaiting_input: 'sqlite or postgres?' }),
      ],
      terrain([]),
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.run).toMatchObject({ running: true, awaiting: null });
    expect(byId.ask).toMatchObject({ running: false, awaiting: 'sqlite or postgres?' });
  });

  it('keeps an awaiting session that is no longer running (the ask outlives the turn)', () => {
    const rows = orchestraRows(
      [session('ask', { running: false, awaiting_input: 'which way?' })],
      terrain([]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].awaiting).toBe('which way?');
  });

  it('collects a session’s writes across both repos', () => {
    const rows = orchestraRows(
      [session('a')],
      terrain([
        { id: 'skeleton', files: [{ path: 's.py', sessions: [{ id: 'a', writes: 1 }] }] },
        { id: 'vault', files: [{ path: 'notes.md', sessions: [{ id: 'a', writes: 3 }] }] },
      ]),
    );
    expect(rows[0].files.map((f) => `${f.repo}:${f.path}`)).toEqual(['vault:notes.md', 'skeleton:s.py']);
  });

  it('tolerates an undefined terrain payload (still-loading)', () => {
    const rows = orchestraRows([session('a')], undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0].fileCount).toBe(0);
  });
});
