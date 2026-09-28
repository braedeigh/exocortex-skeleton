import { describe, expect, it } from 'vitest';
import type { SwarmMember } from './swarmApi';
import { centreOf, foldLinks, nodeBoxes, placeCounts, layoutSwarm, lineWidth, NETWORK_WIDTH, placeRings, shortTitle } from './swarmNetworkMath';

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

  it('carries retired through to the drawing, false when the server leaves it out', () => {
    const layout = layoutSwarm({ members: [{ ...member('a'), retired: true }, member('b')], links: [] });
    expect(layout.nodes.map((n) => n.retired)).toEqual([true, false]);
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

describe('the helper seat', () => {
  it('sits at the centre of the circle of rings', () => {
    const centre = centreOf(placeRings(5));
    expect(centre.x).toBe(NETWORK_WIDTH / 2);
    const seats = placeRings(4);
    expect(centre.y).toBeGreaterThan(seats[0].y);
  });

  it('sits halfway between two rings', () => {
    const [a, b] = placeRings(2);
    expect(centreOf([a, b])).toEqual({ x: (a.x + b.x) / 2, y: a.y });
  });
});

describe('the helper threads', () => {
  const members = [member('a'), member('b')];

  it('runs one thread to each member the helper has messaged, with its count', () => {
    const layout = layoutSwarm({
      members, links: [], continues: [],
      helper_links: [{ to: 'a', messages: 3 }, { to: 'gone', messages: 2 }],
    });
    expect(layout.helperThreads.map((t) => [t.conv, t.messages])).toEqual([['a', 3]]);
  });

});

describe('placing the message counts', () => {
  const bounds = { width: NETWORK_WIDTH, height: 400 };
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) < 30 && Math.abs(a.y - b.y) < 24;

  it('keeps its preferred spot when nothing is in the way', () => {
    const spots = placeCounts(
      [{ key: 'a', from: { x: 100, y: 100 }, to: { x: 300, y: 100 }, text: '3', prefer: 0.5 }], [], 1, bounds);
    expect(spots.get('a')).toEqual({ x: 200, y: 100 });
  });

  it('moves a count off a name it would cover', () => {
    const name = nodeBoxes({ x: 200, y: 60 }, 'a fairly long session title', 1);
    const spot = placeCounts(
      [{ key: 'a', from: { x: 200, y: 60 }, to: { x: 200, y: 260 }, text: '1', prefer: 0.2 }], name, 1, bounds).get('a')!;
    expect(name.every((box) => spot.y - 15 >= box.bottom || spot.y + 15 <= box.top
      || spot.x + 22 <= box.left || spot.x - 22 >= box.right)).toBe(true);
  });

  it('never stacks two counts on one another', () => {
    const lines = [
      { key: 'talk', from: { x: 100, y: 200 }, to: { x: 500, y: 200 }, text: '2', prefer: 0.5 },
      { key: 'helper', from: { x: 300, y: 200 }, to: { x: 500, y: 200 }, text: '1', prefer: 0 + 0.1 },
    ];
    const spots = placeCounts(lines, [], 1, bounds);
    expect(overlaps(spots.get('talk')!, spots.get('helper')!)).toBe(false);
  });
});
