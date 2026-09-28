import { describe, expect, it } from 'vitest';
import type { SwarmMember } from './swarmApi';
import { centreOf, foldLinks, nodeBoxes, placeCounts, layoutSwarm, lineWidth, NETWORK_WIDTH, placeRings, placeTwoRings, shortTitle, withoutRetired } from './swarmNetworkMath';

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

  it('slides a crowded count along its own line', () => {
    const blocker = [{ left: 180, top: 80, right: 220, bottom: 120 }];
    const spot = placeCounts(
      [{ key: 'a', from: { x: 100, y: 100 }, to: { x: 500, y: 100 }, text: '1', prefer: 0.25 }], blocker, 1, bounds).get('a')!;
    expect(spot.y).toBe(100);
  });

  it('keeps a count on its line even when every spot on it is covered', () => {
    const wall = [{ left: 0, top: 90, right: 640, bottom: 110 }];
    const spot = placeCounts(
      [{ key: 'a', from: { x: 100, y: 100 }, to: { x: 500, y: 100 }, text: '1', prefer: 0.5 }], wall, 1, bounds).get('a')!;
    expect(spot).toEqual({ x: 300, y: 100 });
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

describe('withoutRetired', () => {
  const retired = (conv: string) => ({ ...member(conv), retired: true });

  it('moves a hidden session\'s lines onto the live session that took over from it', () => {
    const shown = withoutRetired({
      members: [retired('old'), member('next'), member('peer')],
      links: [{ from: 'peer', to: 'old', messages: 3 }, { from: 'peer', to: 'next', messages: 1 }],
      continues: [{ from: 'old', to: 'next' }],
      helper_links: [{ to: 'old', messages: 4 }],
    });
    expect(shown.members.map((m) => m.conv)).toEqual(['next', 'peer']);
    expect(shown.links).toEqual([{ from: 'peer', to: 'next', messages: 4 }]);
    expect(shown.helper_links).toEqual([{ to: 'next', messages: 4 }]);
  });

  it('follows a chain of handovers and drops lines with no live successor', () => {
    const shown = withoutRetired({
      members: [retired('a'), retired('b'), member('c'), retired('gone'), member('peer')],
      links: [{ from: 'a', to: 'peer', messages: 2 }, { from: 'gone', to: 'peer', messages: 5 }, { from: 'a', to: 'b', messages: 1 }],
      continues: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    });
    expect(shown.links).toEqual([{ from: 'c', to: 'peer', messages: 2 }]);
  });
});

describe('two rings: active inside, retired outside', () => {
  const retired = (conv: string) => ({ ...member(conv), retired: true });
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const swarmOf = (active: number, gone: number) => ({
    members: [
      ...Array.from({ length: gone }, (_, i) => retired(`r${i}`)),
      ...Array.from({ length: active }, (_, i) => member(`a${i}`)),
    ],
    links: [],
  });

  it('seats active agents on the inner radius and retired ones on a wider outer one', () => {
    const layout = layoutSwarm(swarmOf(4, 12));
    const radii = (outer: boolean) => layout.nodes.filter((n) => n.outer === outer)
      .map((n) => Math.round(distance(n, layout.centre)));
    const inner = radii(false);
    expect(inner).toHaveLength(4);
    expect(new Set(inner.map((r) => Math.abs(r - inner[0]) <= 1)).size).toBe(1);
    expect(Math.min(...radii(true))).toBeGreaterThan(Math.max(...inner));
    expect(layout.nodes.filter((n) => n.outer).every((n) => n.retired)).toBe(true);
  });

  it('keeps a small swarm on one circle, every name showing', () => {
    const layout = layoutSwarm(swarmOf(3, 3));
    expect(layout.nodes.every((n) => !n.outer && n.named)).toBe(true);
  });

  it('names the outer ring only when it has room', () => {
    expect(layoutSwarm(swarmOf(3, 6)).nodes.every((n) => n.named)).toBe(true);
    const crowded = layoutSwarm(swarmOf(3, 45)).nodes;
    expect(crowded.filter((n) => n.outer).every((n) => !n.named)).toBe(true);
    expect(crowded.filter((n) => !n.outer).every((n) => n.named)).toBe(true);
  });

  it('keeps a crowded outer ring a tap apart and inside the width', () => {
    const { outer } = placeTwoRings(4, 50);
    for (let i = 0; i < outer.length; i++) {
      const next = outer[(i + 1) % outer.length];
      expect(distance(outer[i], next)).toBeGreaterThanOrEqual(48);
      expect(outer[i].x).toBeGreaterThan(20);
      expect(outer[i].x).toBeLessThan(NETWORK_WIDTH - 20);
    }
  });

  it('seats the helper at the middle of both rings', () => {
    const rings = placeTwoRings(5, 20);
    expect(rings.centre.x).toBe(NETWORK_WIDTH / 2);
    expect(rings.outer[0].y).toBeLessThan(rings.inner[0].y);
  });

  it('lays out a swarm whose every member is retired on the outer ring alone', () => {
    const layout = layoutSwarm(swarmOf(0, 30));
    expect(layout.nodes.every((n) => n.outer)).toBe(true);
  });
});
