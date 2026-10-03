import { expect, it } from 'vitest';
import type { SwarmMember } from '../observatory/swarmApi';
import { messageThreads } from './terrainMessages';

function member(conv: string): SwarmMember {
  return { conv, title: conv, lane: 'coding', state: 'silent', joined_at: '', summary: null, summary_at: null };
}

it('turns a swarm into the lines the map draws: one per talking pair, one from the helper to each member it wrote to', () => {
  const threads = messageThreads([{
    members: [member('a'), member('b'), member('c')],
    links: [
      { from: 'a', to: 'b', messages: 3 },
      { from: 'b', to: 'a', messages: 1 },
      { from: 'c', to: 'a', messages: 2 },
      { from: 'a', to: 'outsider', messages: 9 },
    ],
    helper_conv: 'helper',
    helper_links: [{ to: 'b', messages: 4 }, { to: 'c', messages: 0 }, { to: 'gone', messages: 2 }],
  }]);
  expect(threads).toEqual([
    // A conversation is one line carrying both directions.
    { a: 'a', b: 'b', aToB: 3, bToA: 1, messages: 4, kind: 'talk' },
    // One-way: only c wrote, so only a's end gets a head.
    { a: 'a', b: 'c', aToB: 0, bToA: 2, messages: 2, kind: 'talk' },
    // The helper's line always points at the member.
    { a: 'helper', b: 'b', aToB: 4, bToA: 0, messages: 4, kind: 'helper' },
  ]);
});

it('draws no helper lines for a swarm without a helper, or from an older server', () => {
  expect(messageThreads([{ members: [member('a')], links: [], helper_conv: null }])).toEqual([]);
});
