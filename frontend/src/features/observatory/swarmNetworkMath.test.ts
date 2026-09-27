import { describe, expect, it } from 'vitest';
import type { SwarmMember } from './swarmApi';
import { foldLinks, layoutSwarm, lineWidth, NETWORK_WIDTH, placeRings, shortTitle } from './swarmNetworkMath';

function member(conv: string): SwarmMember {
  return { conv, title: `title ${conv}`, lane: 'coding', state: 'silent', joined_at: '', summary: null, summary_at: null };
}

describe('placeRings', () => {
  it('sits two side by side on one row', () => {
    const [a, b] = placeRings(2);
    expect(a.y).toBe(b.y);
    expect(a.x).toBeLessThan(b.x);
  });

  it('stands three or more round a circle, first at the top, all inside the width', () => {
    const seats = placeRings(7);
    expect(Math.min(...seats.map((s) => s.y))).toBe(seats[0].y);
    for (const s of seats) {
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(NETWORK_WIDTH);
      expect(s.y).toBeLessThan(s.height);
    }
  });
});

describe('foldLinks', () => {
  it('folds both directions of a conversation into one line', () => {
    const lines = foldLinks(
      [{ from: 'b', to: 'a', messages: 2 }, { from: 'a', to: 'b', messages: 3 }],
      new Set(['a', 'b']),
    );
    expect(lines).toEqual([{ a: 'a', b: 'b', aToB: 3, bToA: 2, messages: 5 }]);
  });

  it('drops messages to anyone outside the swarm, like its helper', () => {
    expect(foldLinks([{ from: 'a', to: 'helper', messages: 4 }], new Set(['a', 'b']))).toEqual([]);
  });
});

describe('layoutSwarm', () => {
  it('keeps continuation lines only between members, and tolerates an older server without them', () => {
    const swarm = { members: [member('a'), member('b')], links: [] };
    expect(layoutSwarm(swarm).continues).toEqual([]);
    const layout = layoutSwarm({ ...swarm, continues: [{ from: 'a', to: 'b' }, { from: 'x', to: 'a' }] });
    expect(layout.continues).toEqual([{ from: 'a', to: 'b' }]);
  });
});

it('thickens a line with more messages, up to a cap', () => {
  expect(lineWidth(1)).toBeLessThan(lineWidth(8));
  expect(lineWidth(10_000)).toBe(6);
});

it('cuts a long title at a word', () => {
  expect(shortTitle('make it such that sessions can talk to each other')).toBe('make it such that…');
  expect(shortTitle('short')).toBe('short');
});
