/**
 * What the landmark says about the pond's settings. The rule under every test
 * here: a pond at its defaults reports NOTHING, so the little pond only wears
 * chips when she actually chose something.
 */
import { describe, expect, it } from 'vitest';
import { describeSavedView } from './savedView';

describe('describeSavedView', () => {
  it('says nothing about a pond at its defaults', () => {
    expect(describeSavedView({})).toEqual([]);
    expect(
      describeSavedView({
        mode: 'clock',
        range: 'all',
        hideKeeper: false,
        litKey: null,
        layers: { turns: true, writes: true, sessions: true },
      }),
    ).toEqual([]);
  });

  it('leads with the lit thread, by its stored name', () => {
    const facets = describeSavedView({ litKey: 'tag:long-covid', litLabel: 'Long COVID' });
    expect(facets).toEqual([{ kind: 'lit', label: 'Long COVID' }]);
  });

  it('falls back to the key without its prefix when no name was stored', () => {
    // A view saved by an older build has the key but no label — a name is
    // still better than silence.
    expect(describeSavedView({ litKey: 'front:health' })).toEqual([
      { kind: 'lit', label: 'health' },
    ]);
    expect(describeSavedView({ litKey: 'unfiled' })).toEqual([
      { kind: 'lit', label: 'unfiled' },
    ]);
  });

  it('reports the arrangement and window only when they are not the default', () => {
    expect(describeSavedView({ mode: 'words', range: '30' })).toEqual([
      { kind: 'mode', label: 'words' },
      { kind: 'range', label: '30 days' },
    ]);
    expect(describeSavedView({ mode: 'clock', range: 'all' })).toEqual([]);
  });

  it('names the working layers when some are off, and never lists them', () => {
    expect(describeSavedView({ layers: { turns: true, writes: true, sessions: true } })).toEqual([]);
    expect(
      describeSavedView({ layers: { turns: false, writes: false, sessions: false } }),
    ).toEqual([{ kind: 'layers', label: 'journal only' }]);
    expect(describeSavedView({ layers: { turns: true, writes: false, sessions: false } })).toEqual([
      { kind: 'layers', label: 'messages only' },
    ]);
    expect(describeSavedView({ layers: { turns: true, writes: true, sessions: false } })).toEqual([
      { kind: 'layers', label: '2 work layers' },
    ]);
  });

  it('orders facets by how deliberately she chose them', () => {
    const facets = describeSavedView({
      litKey: 'tag:ezra',
      litLabel: 'Ezra',
      mode: 'words',
      range: '90',
      hideKeeper: true,
    });
    expect(facets.map((f) => f.kind)).toEqual(['lit', 'mode', 'range', 'keeper']);
  });
});
