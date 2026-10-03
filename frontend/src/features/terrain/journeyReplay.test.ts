import { describe, expect, it } from 'vitest';
import type { TraceDetail } from './wiring/api';
import { beatNodeIds, buildJourneyBeats, scheduleFrames } from './journeyReplay';

const span = (o: Partial<TraceDetail['spans'][number]>) => ({
  seq: 0, depth: 0, src_repo: null, src: null, src_func: null,
  dst_repo: 'skeleton', dst: 'server.py', dst_func: 'f', t0_us: 0, t1_us: 100, ...o,
});
const head = (o: Record<string, unknown>) => ({
  id: 'x', label: '', kind: 'http', entry: '', started_at: '2026-08-28T10:00:00.000+00:00',
  duration_us: 0, span_count: 0, truncated: 0, pid: null, parent_id: null, spans: [], tree: [], ...o,
});

const journey = head({
  id: 'j1', kind: 'journey', entry: 'journey',
  parts: [
    head({
      id: 'j1.browser', kind: 'browser', parent_id: 'j1',
      started_at: '2026-08-28T10:00:00.000+00:00',
      spans: [
        span({ seq: 0, src_repo: 'browser', src: 'Composer < Page', src_func: 'click',
          dst_repo: 'skeleton', dst: 'frontend/src/Composer.tsx', dst_func: 'Send', t0_us: 500_000, t1_us: 500_000 }),
        span({ seq: 1, src_repo: 'browser', src: null, src_func: 'fetch',
          dst_repo: 'browser', dst: '/api/send', dst_func: 'POST /api/send', t0_us: 510_000, t1_us: 900_000 }),
      ],
    }),
    head({
      id: 'j1.r1', kind: 'http', entry: 'POST /api/send', parent_id: 'j1',
      started_at: '2026-08-28T10:00:00.520+00:00',
      spans: [
        span({ seq: 0, dst: 'routes/observatory.py', dst_func: 'send' }),
        span({ seq: 1, depth: 1, src_repo: 'skeleton', src: 'routes/observatory.py', src_func: 'send',
          dst: 'store.py', dst_func: 'mutate', t0_us: 2_000, t1_us: 3_000 }),
      ],
    }),
    head({
      id: 'j1.r1.turn', kind: 'turn', entry: 'turn c1', parent_id: 'j1.r1',
      started_at: '2026-08-28T10:00:01.000+00:00',
      spans: [span({ seq: 0, dst: 'scripts/turn_host.py', dst_func: 'main' })],
      agent_calls: [
        { seq: 0, name: 'Edit', path: '/opt/x/skeleton/store.py', repo: 'skeleton', rel: 'store.py', ts: 0, t0_us: 4_000_000 },
        { seq: 1, name: 'Bash', path: 'ls', repo: null, rel: null, ts: 0, t0_us: 5_000_000 },
      ],
    }),
  ],
}) as unknown as TraceDetail;

describe('buildJourneyBeats', () => {
  it('places every part on the root clock and sorts by time', () => {
    const beats = buildJourneyBeats(journey);
    expect(beats.map((b) => Math.round(b.atMs))).toEqual([500, 510, 520, 522, 1000, 5000, 6000]);
  });

  it('threads a browser fetch to the entry file of the request it became', () => {
    const fetch = buildJourneyBeats(journey).find((b) => b.label === 'POST /api/send')!;
    expect(fetch.fromId).toBe('skeleton:file:frontend/src/Composer.tsx');
    expect(fetch.nodeId).toBe('skeleton:file:routes/observatory.py');
  });

  it('turns a python hop into dot + thread from its caller', () => {
    const hop = buildJourneyBeats(journey).find((b) => b.label === 'mutate')!;
    expect(hop.fromId).toBe('skeleton:file:routes/observatory.py');
    expect(hop.nodeId).toBe('skeleton:file:store.py');
    expect(hop.kind).toBe('http');
  });

  it('lands agent tool calls on their file, threaded from the turn host, and keeps ones with no dot', () => {
    const agent = buildJourneyBeats(journey).filter((b) => b.kind === 'agent');
    expect(agent[0].nodeId).toBe('skeleton:file:store.py');
    expect(agent[0].fromId).toBe('skeleton:file:scripts/turn_host.py');
    expect(agent[1].nodeId).toBeNull();
    expect(agent[1].label).toBe('Bash ls');
  });

  it('a single-request trace (no journey) still plays', () => {
    const solo = head({ id: 't1', spans: [span({})], parts: [] }) as unknown as TraceDetail;
    expect(buildJourneyBeats(solo)).toHaveLength(1);
  });
});

describe('beatNodeIds / scheduleFrames', () => {
  it('collects every dot a journey touches', () => {
    expect(beatNodeIds(buildJourneyBeats(journey))).toEqual(new Set([
      'skeleton:file:frontend/src/Composer.tsx', 'skeleton:file:routes/observatory.py',
      'skeleton:file:store.py', 'skeleton:file:scripts/turn_host.py',
    ]));
  });

  it('batches beats closer than a step into one frame, and stretches by slow', () => {
    const frames = scheduleFrames(buildJourneyBeats(journey), 2, 40);
    expect(frames.map((f) => f.beats.length)).toEqual([2, 2, 1, 1, 1]);
    expect(frames[0].atMs).toBe(1000);
  });
});
