import { describe, expect, it } from 'vitest';
import type { SwarmMember } from './swarmApi';
import { directionCounts, foldLinks, nodeBoxes, placeCounts, layoutSwarm, lineWidth, NETWORK_WIDTH, shortTitle, withoutRetired, type Box, type NetworkLayout } from './swarmNetworkMath';

function member(conv: string): SwarmMember {
  return { conv, title: `title ${conv}`, lane: 'coding', state: 'silent', joined_at: '', summary: null, summary_at: null };
}

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

describe('one count per direction on a talk line', () => {
  const members = new Set(['a', 'b', 'c']);
  const lines = foldLinks(
    [{ from: 'a', to: 'b', messages: 3 }, { from: 'b', to: 'a', messages: 1 }, { from: 'c', to: 'a', messages: 2 }],
    members,
  );
  const seats = { a: { x: 0, y: 50 }, b: { x: 400, y: 50 }, c: { x: 0, y: 450 } } as Record<string, { x: number; y: number }>;

  it('keeps each number beside whoever received it, even when the line is crowded', () => {
    // A wide obstacle over the middle of every line pushes chips around; none may cross to the sender's half.
    const crowd: Box[] = [{ left: 120, top: 0, right: 280, bottom: 100 }, { left: -20, top: 180, right: 20, bottom: 320 }];
    for (const line of lines) {
      const counts = directionCounts(line);
      // Every message is counted once, in the direction it went.
      expect(counts.reduce((sum, c) => sum + c.count, 0)).toBe(line.messages);
      const spots = placeCounts(
        counts.map((c) => ({ key: c.receiver, from: seats[line.a], to: seats[line.b], text: String(c.count), prefer: c.prefer, within: c.within })),
        crowd, 1, { width: 500, height: 500 },
      );
      for (const c of counts) {
        const spot = spots.get(c.receiver)!;
        const toReceiver = Math.hypot(spot.x - seats[line[c.receiver]].x, spot.y - seats[line[c.receiver]].y);
        const toSender = Math.hypot(spot.x - seats[line[c.receiver === 'a' ? 'b' : 'a']].x, spot.y - seats[line[c.receiver === 'a' ? 'b' : 'a']].y);
        expect(toReceiver).toBeLessThanOrEqual(toSender);
        expect(c.count).toBe(c.receiver === 'b' ? line.aToB : line.bToA);
      }
    }
  });

  it('gives a one-way line a single number and a conversation two', () => {
    expect(lines.map((line) => directionCounts(line).length).sort()).toEqual([1, 2]);
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

/* The layout, tried the way it is used: many shapes of swarm, at the widths
   it is really shown at (a phone's bubble is about 230-350px, a phone page
   about 400, a desk 640 and up), in the round bubble and on a page. */
describe('fitting the drawing to the width it is shown at', () => {
  const TITLES = ['spin: overlap-alerts', 'spin: helper-context-three-parts', 'fix the nightly tests', 'journal search'];
  const swarmOf = (active: number, gone: number, helper = true) => ({
    members: [
      ...Array.from({ length: gone }, (_, i) => ({ ...member(`r${i}`), title: `old ${TITLES[i % 4]}`, retired: true })),
      ...Array.from({ length: active }, (_, i) => ({ ...member(`a${i}`), title: TITLES[i % 4] })),
    ],
    links: [],
    helper_conv: helper ? 'helper' : null,
  });
  const SHAPES = [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [9, 0], [3, 3], [3, 5], [4, 12], [3, 30], [0, 30]];
  const WIDTHS = [230, 290, 342, 400, 460, 640, 900];
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  // What each agent covers on screen, in drawing units, as the drawing does it.
  const coversOf = (layout: NetworkLayout, shown: number): Box[][] => {
    const pxPerUnit = shown / layout.width;
    return layout.nodes.map((n) =>
      nodeBoxes(n, n.named ? shortTitle(n.title) : '', pxPerUnit, n.outer ? 12 : 18, layout.nameWidth - 8, n.nameAbove));
  };
  const overlap = (a: Box, b: Box) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const everyCase = (round: boolean, check: (layout: NetworkLayout, shown: number, label: string) => void) => {
    for (const shown of WIDTHS) {
      for (const [active, gone] of SHAPES) {
        check(layoutSwarm(swarmOf(active, gone), shown, round), shown, `${active} active, ${gone} retired, ${shown}px`);
      }
    }
  };

  it('keeps every ring and name inside the bubble, the helper at its exact centre', () => {
    everyCase(true, (layout, shown, label) => {
      expect(layout.height, label).toBe(layout.width);
      expect(layout.centre, label).toEqual({ x: layout.width / 2, y: layout.height / 2 });
      for (const box of coversOf(layout, shown).flat()) {
        const reach = Math.hypot(
          Math.max(layout.centre.x - box.left, box.right - layout.centre.x),
          Math.max(layout.centre.y - box.top, box.bottom - layout.centre.y),
        );
        expect(reach, label).toBeLessThanOrEqual(layout.width / 2);
      }
    });
  });

  it('keeps every ring and name inside the page drawing, the helper in the middle, with nothing to scroll to', () => {
    everyCase(false, (layout, shown, label) => {
      expect(layout.centre.x, label).toBe(layout.width / 2);
      expect(layout.width, label).toBeLessThanOrEqual(Math.max(shown, 200));
      for (const box of coversOf(layout, shown).flat()) {
        expect(box.left, label).toBeGreaterThanOrEqual(0);
        expect(box.right, label).toBeLessThanOrEqual(layout.width);
        expect(box.top, label).toBeGreaterThanOrEqual(0);
        expect(box.bottom, label).toBeLessThanOrEqual(layout.height);
      }
    });
  });

  it('never prints a name over another agent or over the helper, and keeps rings a tap apart', () => {
    for (const round of [true, false]) {
      everyCase(round, (layout, shown, label) => {
        // Only promised where it is possible: sixteen rings can't each have
        // a tap, clear of the helper, inside a 230px drawing, nor thirty-three
        // inside a 290px one.
        if ((shown < 290 && layout.nodes.length > 10) || (shown < 342 && layout.nodes.length > 20)) return;
        const covers = coversOf(layout, shown);
        const helper = nodeBoxes(layout.centre, 'Helper', shown / layout.width);
        covers.forEach((mine, i) => {
          for (const box of mine) {
            expect(helper.some((other) => overlap(box, other)), `${label}: ${layout.nodes[i].conv} on the helper`).toBe(false);
            covers.slice(0, i).forEach((theirs, j) => {
              if (!layout.nodes[i].named && !layout.nodes[j].named) return;
              expect(theirs.some((other) => overlap(box, other)), `${label}: ${layout.nodes[i].conv} on ${layout.nodes[j].conv}`).toBe(false);
            });
          }
          for (const other of layout.nodes.slice(0, i)) {
            expect(distance(layout.nodes[i], other) * (shown / layout.width), label).toBeGreaterThanOrEqual(36);
          }
        });
      });
    }
  });

  it('prints every name when a small swarm has the room, on a phone page as on a desk', () => {
    for (const shown of [400, 640, 900]) {
      for (const count of [1, 2, 3, 4, 5]) {
        expect(layoutSwarm(swarmOf(count, 0), shown).nodes.every((n) => n.named), `${count} at ${shown}px`).toBe(true);
      }
    }
    for (const count of [1, 2, 3, 4]) {
      expect(layoutSwarm(swarmOf(count, 0), 342, true).nodes.every((n) => n.named), `${count} in a phone bubble`).toBe(true);
    }
  });

  it('lifts two members above the helper, so their talk line clears its dot; with no helper they sit on one row', () => {
    for (const shown of [230, 342, 640]) {
      const layout = layoutSwarm(swarmOf(2, 0), shown, true);
      const [a, b] = layout.nodes;
      expect(a.y).toBe(b.y);
      expect(layout.centre.y - a.y).toBeGreaterThanOrEqual(20);
      expect(a.x).toBeLessThan(layout.centre.x);
      expect(b.x).toBeGreaterThan(layout.centre.x);
    }
    const [a, b] = layoutSwarm(swarmOf(2, 0, false), 342).nodes;
    expect(a.y).toBe(b.y);
    expect(a.x).toBeLessThan(b.x);
  });

  it('puts a name above its ring only when the ring is above the helper', () => {
    const layout = layoutSwarm(swarmOf(4, 0), 400);
    expect(layout.nodes.map((n) => n.nameAbove)).toEqual(layout.nodes.map((n) => n.y < layout.centre.y));
    expect(layout.nodes.some((n) => n.nameAbove)).toBe(true);
  });

  it('seats active agents on an inner ring and retired ones on a wider outer one, all round the helper', () => {
    for (const shown of [342, 640]) {
      const layout = layoutSwarm(swarmOf(4, 12), shown, shown === 342);
      const radii = (outer: boolean) => layout.nodes.filter((n) => n.outer === outer).map((n) => distance(n, layout.centre));
      expect(radii(false)).toHaveLength(4);
      expect(Math.max(...radii(false)) - Math.min(...radii(false))).toBeLessThanOrEqual(2);
      expect(Math.min(...radii(true))).toBeGreaterThan(Math.max(...radii(false)));
      expect(layout.nodes.filter((n) => n.outer).every((n) => n.retired)).toBe(true);
    }
  });

  it('keeps a small swarm on one circle, and a swarm that is all retired on the outer ring alone', () => {
    expect(layoutSwarm(swarmOf(3, 3)).nodes.every((n) => !n.outer && n.named)).toBe(true);
    expect(layoutSwarm(swarmOf(0, 30)).nodes.every((n) => n.outer)).toBe(true);
  });

  it('names the retired ring only when it has room, and never at the active names\' expense', () => {
    expect(layoutSwarm(swarmOf(3, 6)).nodes.every((n) => n.named)).toBe(true);
    const crowded = layoutSwarm(swarmOf(3, 45)).nodes;
    expect(crowded.filter((n) => n.outer).every((n) => !n.named)).toBe(true);
    expect(crowded.filter((n) => !n.outer).every((n) => n.named)).toBe(true);
  });
});
