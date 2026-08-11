/**
 * What counts as a conversation for the per-conversation dwell split.
 *
 * The stakes: whatever `convFromLocation` returns becomes a permanent key in
 * feature_usage, and the join that turns those keys into "how long did I
 * journal" runs against real conversation ids in exo.db. A key that isn't a
 * real id joins to nothing and quietly reports zero, which is the exact
 * failure the split exists to fix — so the sentinel and the not-yet-minted
 * cases are pinned here rather than left to the reader.
 */
import { describe, expect, it } from 'vitest';
import { convFromLocation, tabFromPathname } from './usageBeacon';

describe('tabFromPathname', () => {
  it('takes the first path segment', () => {
    expect(tabFromPathname('/observatory/session')).toBe('observatory');
  });

  it('falls back to the default tab at the root', () => {
    expect(tabFromPathname('/')).toBe('todos');
  });
});

describe('convFromLocation', () => {
  it('reads ?conv= on an observatory url', () => {
    expect(convFromLocation('/observatory/session', { conv: '2026-08-09.030450' }))
      .toBe('2026-08-09.030450');
  });

  it('accepts the -n suffix real ids carry', () => {
    expect(convFromLocation('/observatory/session', { conv: '2026-07-23.102832-2' }))
      .toBe('2026-07-23.102832-2');
  });

  it('ignores conv on any other tab', () => {
    // Nothing else mints conversations; a stray ?conv= elsewhere is not one.
    expect(convFromLocation('/journal', { conv: '2026-08-09.030450' })).toBeNull();
  });

  it('refuses the "latest" sentinel', () => {
    // The route swaps this for a real id on mount — banking time against it
    // would invent a conversation that never existed.
    expect(convFromLocation('/observatory/session', { conv: 'latest' })).toBeNull();
  });

  it('returns null for a brand-new chat that has no id yet', () => {
    // Its opening seconds stay in the tab total and out of the split, rather
    // than being guessed onto whichever conversation came before.
    expect(convFromLocation('/observatory/session', {})).toBeNull();
  });

  it('rejects ids that could never have been minted', () => {
    for (const conv of ['../../etc/passwd', 'a b', '', 'x'.repeat(65)]) {
      expect(convFromLocation('/observatory/session', { conv })).toBeNull();
    }
  });

  it('survives a search value that is not an object', () => {
    for (const search of [null, undefined, 'conv=1', 42]) {
      expect(convFromLocation('/observatory/session', search)).toBeNull();
    }
  });
});
