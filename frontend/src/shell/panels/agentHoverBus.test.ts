import { afterEach, expect, it } from 'vitest';
import { pointAtAgent, pointedAgent, resetAgentHoverForTests, subscribeAgentHover } from './agentHoverBus';

afterEach(() => resetAgentHoverForTests());

it('tells every listener when the pointed-at agent changes, and when the hover ends', () => {
  const map: (string | null)[] = [];
  const other: (string | null)[] = [];
  subscribeAgentHover((conv) => map.push(conv));
  const stop = subscribeAgentHover((conv) => other.push(conv));
  pointAtAgent('a');
  pointAtAgent('a'); // resting on the same agent says nothing new
  pointAtAgent('b');
  stop();
  pointAtAgent(null);
  expect(map).toEqual(['a', 'b', null]);
  expect(other).toEqual(['a', 'b']);
  expect(pointedAgent()).toBeNull();
});

it('lets a map that opens mid-hover ask who is being pointed at', () => {
  pointAtAgent('a');
  expect(pointedAgent()).toBe('a');
});
