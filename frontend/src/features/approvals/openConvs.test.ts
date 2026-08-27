import { beforeEach, describe, expect, it } from 'vitest';
import { _resetOpenConvs, isConvOpen, itemsForConv, itemsUnowned, registerOpenConv } from './openConvs';

beforeEach(() => _resetOpenConvs());

describe('openConvs', () => {
  it('a pane claims its conversation while mounted, and releases it', () => {
    const off = registerOpenConv('c1');
    expect(isConvOpen('c1')).toBe(true);
    off();
    expect(isConvOpen('c1')).toBe(false);
  });

  it('two tiles on the same conversation keep it claimed until both go', () => {
    const a = registerOpenConv('c1');
    const b = registerOpenConv('c1');
    a();
    expect(isConvOpen('c1')).toBe(true);
    b();
    expect(isConvOpen('c1')).toBe(false);
  });

  it('routes an item to its open pane and everything else to the global host', () => {
    registerOpenConv('c1');
    const q = [{ id: 'a', conv: 'c1' }, { id: 'b', conv: 'c2' }, { id: 'c' }];
    expect(itemsForConv(q, 'c1').map((p) => p.id)).toEqual(['a']);
    expect(itemsUnowned(q).map((p) => p.id)).toEqual(['b', 'c']);
  });
});
