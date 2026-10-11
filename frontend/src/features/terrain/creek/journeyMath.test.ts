import { describe, expect, it } from 'vitest';
import type { CreekFile } from './api';
import type { TraceDetail } from '../wiring/api';
import { journeySets, ribbonKey } from './journeyMath';

const files: CreekFile[] = [
  { path: 'routes/todos.py', area: 'routes', calls: [
    { line: 1, verb: 'mutate', collection: 'todos', snippet: '' },
    { line: 2, verb: 'read', collection: 'profile', snippet: '' },
  ] },
  { path: 'routes/quiet.py', area: 'routes', calls: [{ line: 1, verb: 'write', collection: 'todos', snippet: '' }] },
] as unknown as CreekFile[];

const span = (dst: string, src: string | null = null) => ({
  seq: 0, depth: 0, src_repo: src ? 'skeleton' : null, src, src_func: null,
  dst_repo: 'skeleton', dst, dst_func: 'f', t0_us: 0, t1_us: 1,
});

const trace = {
  id: 'j', kind: 'journey', spans: [], parts: [
    { id: 'j.b', kind: 'browser', spans: [span('frontend/x.tsx')] },
    { id: 'j.r', kind: 'http', spans: [span('routes/todos.py'), span('store.py', 'routes/todos.py')] },
  ],
  writes: [{ collection: 'todos' }, { collection: 'feature_usage' }],
} as unknown as TraceDetail;

describe('journeySets', () => {
  it('lights a write ribbon only when the trace ran the file AND the journal saw the collection change', () => {
    const s = journeySets(trace, files)!;
    expect(s.ribbons.get(ribbonKey('routes/todos.py', 'todos', 'write'))).toBe('exact');
    expect(s.ribbons.has(ribbonKey('routes/quiet.py', 'todos', 'write'))).toBe(false);
  });

  it('marks a read ribbon as only possible — reads leave no journal entry', () => {
    expect(journeySets(trace, files)!.ribbons.get(ribbonKey('routes/todos.py', 'profile', 'read'))).toBe('possible');
  });

  it('ignores the browser part and keeps unattributed writes separately', () => {
    const s = journeySets(trace, files)!;
    expect(s.files.has('frontend/x.tsx')).toBe(false);
    expect(s.files.has('store.py')).toBe(true);
    expect(s.unattributed).toEqual(['feature_usage']);
  });

  it('is null with no trace', () => {
    expect(journeySets(null, files)).toBeNull();
  });
});
