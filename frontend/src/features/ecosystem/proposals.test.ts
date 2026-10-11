import { describe, expect, it } from 'vitest';
import { groupByFood, proposalPaint, regionCodes, waitingByFood, type EcoProposal } from './proposals';

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

describe('proposalPaint', () => {
  it('draws a failed proposal faint and grey, whatever its transparency', () => {
    const paint = proposalPaint({ check_status: 'failed', transparency: 'disclosed' });
    expect([paint.color, paint.opacity < 0.5]).toEqual(['#9aa0a6', true]);
  });

  it('dashes every proposal, passed ones included', () => {
    expect(proposalPaint({ check_status: 'passed', transparency: 'partial' }).dashArray).not.toBe('');
  });
});

describe('regionCodes', () => {
  it('lists each region code once across all proposals', () => {
    const codes = regionCodes([
      { regions: [{ code: 'BO-O', name: 'Oruro' }, { code: 'BO-P', name: 'Potosí' }] },
      { regions: [{ code: 'BO-O', name: 'Oruro' }] },
      { regions: [] },
    ]);
    expect(codes).toEqual(['BO-O', 'BO-P']);
  });
});
