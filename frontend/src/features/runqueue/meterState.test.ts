import { describe, expect, it } from 'vitest';
import {
  humanSize,
  meterDescription,
  meterState,
  meterWantsAttention,
  roomForMore,
} from './meterState';
import type { Headroom } from './memoryPrompt';

function h(over: Partial<Headroom> = {}): Headroom {
  return {
    available_mb: 2000,
    total_mb: 4000,
    floor_mb: 1000,
    per_run_mb: 450,
    cap: 3,
    running: 0,
    queued: 0,
    would_admit: true,
    paused_until: null,
    pause_reason: null,
    ...over,
  };
}

describe('meterState', () => {
  it('fills by how much of the box is spoken for', () => {
    expect(meterState(h({ total_mb: 4000, available_mb: 3000 }))!.fillPct).toBe(25);
  });

  it('puts the tick where the reserve begins', () => {
    // 4000 total, 1000 held back -> the fill shouldn't pass 75%
    expect(meterState(h())!.tickPct).toBe(75);
  });

  it('is calm while a whole session still fits', () => {
    expect(meterState(h({ available_mb: 2000 }))!.tone).toBe('calm');
  });

  it('goes tight above the floor but under a session’s worth', () => {
    // 1200 free, floor 1000 -> 200 spare, less than the 450 a run needs
    expect(meterState(h({ available_mb: 1200 }))!.tone).toBe('tight');
  });

  it('goes critical once it eats into the reserve', () => {
    expect(meterState(h({ available_mb: 900 }))!.tone).toBe('critical');
  });

  it('shows a pause over everything else', () => {
    expect(meterState(h({ paused_until: '2099-01-01T00:00:00' }))!.tone).toBe('paused');
  });

  it('draws nothing rather than a made-up line when memory is unreadable', () => {
    expect(meterState(h({ available_mb: null }))).toBeNull();
    expect(meterState(h({ total_mb: null }))).toBeNull();
    expect(meterState(null)).toBeNull();
  });

  it('never runs off either end of the track', () => {
    const over = meterState(h({ total_mb: 100, available_mb: 0 }))!;
    expect(over.fillPct).toBeLessThanOrEqual(100);
    expect(over.fillPct).toBeGreaterThanOrEqual(0);
  });
});

describe('the label stays a heartbeat, not a dashboard', () => {
  it('never says bytes', () => {
    for (const avail of [3000, 1200, 900]) {
      const label = meterState(h({ available_mb: avail }))!.label;
      expect(label).not.toMatch(/\d+\s*(MB|GB|KB|bytes)/i);
    }
  });

  it('counts runs in words she reads, with the plural right', () => {
    expect(meterState(h({ running: 1 }))!.label).toContain('1 run');
    expect(meterState(h({ running: 3 }))!.label).toContain('3 runs');
  });

  it('mentions waiting work only when some exists', () => {
    expect(meterState(h({ running: 2 }))!.label).not.toContain('waiting');
    expect(meterState(h({ running: 2, queued: 4 }))!.label).toContain('4 waiting');
  });
});

describe('humanSize', () => {
  it('says GB once it is worth saying', () => {
    expect(humanSize(2065)).toBe('2.0 GB');
    expect(humanSize(3819)).toBe('3.7 GB');
  });

  it('stays in MB under a gig — "0.6 GB" is a worse way to say 600MB', () => {
    expect(humanSize(600)).toBe('600 MB');
  });
});

describe('roomForMore', () => {
  it('counts what the free memory can actually hold', () => {
    // 2450 free, 1000 floor -> 1450 spare -> three 450MB runs
    expect(roomForMore(h({ available_mb: 2450, floor_mb: 1000, per_run_mb: 450, cap: 9 }))).toBe(3);
  });

  it('is bounded by the cap, not just the memory', () => {
    expect(roomForMore(h({ available_mb: 8000, total_mb: 9000, cap: 3, running: 1 }))).toBe(2);
  });

  it('is zero once the floor is reached, never negative', () => {
    expect(roomForMore(h({ available_mb: 900, floor_mb: 1000 }))).toBe(0);
  });
});

describe('meterDescription', () => {
  it('says the measurement and what it means for her next tap', () => {
    const d = meterDescription(h({ available_mb: 2065, total_mb: 3819 }))!;
    expect(d.usage).toBe('2.0 GB free of 3.7 GB');
    expect(d.meaning).toContain('room for');
  });

  it('leads with what is going when something is', () => {
    const d = meterDescription(h({ running: 2, queued: 1 }))!;
    expect(d.meaning).toContain('2 running');
    expect(d.meaning).toContain('1 waiting');
  });

  it('stays quiet about runs when there are none', () => {
    expect(meterDescription(h())!.meaning).not.toContain('running');
  });

  it('says plainly when nothing more fits', () => {
    expect(meterDescription(h({ available_mb: 900, floor_mb: 1000 }))!.meaning).toContain(
      'no room for another',
    );
  });

  it('reports a pause instead of a room count', () => {
    const d = meterDescription(h({ paused_until: '2099-01-01T00:00:00' }))!;
    expect(d.meaning).toContain('queue paused');
    expect(d.meaning).not.toContain('room for');
  });

  it('describes nothing when there is nothing to describe', () => {
    expect(meterDescription(h({ available_mb: null }))).toBeNull();
    expect(meterDescription(null)).toBeNull();
  });
});

describe('meterWantsAttention', () => {
  it('stays silent on a calm box — that is the whole point', () => {
    expect(meterWantsAttention(meterState(h()))).toBe(false);
  });

  it('speaks up once things tighten', () => {
    expect(meterWantsAttention(meterState(h({ available_mb: 1200 })))).toBe(true);
    expect(meterWantsAttention(meterState(h({ available_mb: 900 })))).toBe(true);
  });

  it('says nothing when there is no meter at all', () => {
    expect(meterWantsAttention(null)).toBe(false);
  });
});
