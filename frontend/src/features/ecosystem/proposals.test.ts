import { describe, expect, it } from 'vitest';
import { groupByFood, waitingByFood, type EcoProposal } from './proposals';

function proposal(id: number, food_id: number | null, check_status: EcoProposal['check_status']): EcoProposal {
  return { id, food_id, check_status } as EcoProposal;
}

describe('groupByFood', () => {
  it('puts the food with the most proposals first and the no-food group last', () => {
    const groups = groupByFood([proposal(1, null, 'unchecked'), proposal(2, 5, 'passed'), proposal(3, 7, 'failed'), proposal(4, 7, 'passed')]);
    expect(groups.map((g) => g.foodId)).toEqual([7, 5, null]);
  });

  it('orders a food’s proposals passed, then unchecked, then failed', () => {
    const [group] = groupByFood([proposal(1, 5, 'failed'), proposal(2, 5, 'unchecked'), proposal(3, 5, 'passed')]);
    expect(group.proposals.map((p) => p.id)).toEqual([3, 2, 1]);
  });
});

describe('waitingByFood', () => {
  it('counts every live proposal per food, failed ones included', () => {
    const counts = waitingByFood([proposal(1, 5, 'failed'), proposal(2, 5, 'passed'), proposal(3, null, 'unchecked')]);
    expect(counts.get(5)).toBe(2);
    expect(counts.size).toBe(1);
  });
});
