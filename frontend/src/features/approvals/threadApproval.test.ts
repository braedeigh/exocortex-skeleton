import { describe, expect, it } from 'vitest';
import {
  cardsFromPayload,
  evidenceFromPayload,
  lastCardLabel,
  linkChangeRows,
  linkRowLabel,
  parseAliases,
  threadNameForSlug,
  threadOpenDraftFromPayload,
  threadOpenPayloadFromDraft,
  toggleOrdered,
} from './threadApproval';
import type { ThreadOpenDraft } from './threadApproval';

function openDraft(overrides: Partial<ThreadOpenDraft> = {}): ThreadOpenDraft {
  return {
    name: 'Migraines',
    slug: 'migraines',
    aliasesText: 'migraine, aura',
    kind: 'standing',
    fronts: ['health', 'job'],
    parents: ['long-covid'],
    people: ['michael'],
    ...overrides,
  };
}

const openPayload = {
  slug: 'migraines',
  name: 'Migraines',
  aliases: ['migraine', 'aura'],
  fronts: ['health', 'job'],
  parents: ['long-covid'],
  people: ['michael'],
  kind: 'standing',
  proposer: 'cricket-health',
  rationale: '9 cards across 3 weeks; 7 of 9 on workdays.',
  evidence: [
    { source: '2026-07-08.1841b', date: '2026-07-08', quote: 'third one this week, always after the standup' },
    { source: '2026-07-11.0912b', date: '2026-07-11', quote: 'aura started before I even opened the laptop' },
  ],
  cards: [
    { section: 'What it is', text: 'Recurring migraines with aura, clustering on workdays.', source: '2026-07-08.1841b' },
  ],
};

describe('parseAliases', () => {
  it('trims entries and drops empties', () => {
    expect(parseAliases('a, b , ,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles a single alias with no commas', () => {
    expect(parseAliases('migraine')).toEqual(['migraine']);
  });

  it('returns [] for blank input', () => {
    expect(parseAliases('')).toEqual([]);
    expect(parseAliases('   ')).toEqual([]);
  });

  it('drops a trailing comma with nothing after it', () => {
    expect(parseAliases('a, b,')).toEqual(['a', 'b']);
  });
});

describe('toggleOrdered', () => {
  it('appends a new item at the end', () => {
    expect(toggleOrdered([], 'a')).toEqual(['a']);
    expect(toggleOrdered(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes an existing item, closing the gap', () => {
    expect(toggleOrdered(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('promotes the next item to primary when the current primary is removed', () => {
    const withPrimary = toggleOrdered(['a', 'b'], 'a');
    expect(withPrimary).toEqual(['b']);
    expect(withPrimary[0]).toBe('b'); // b is now primary
  });

  it('re-adding after removal appends at the end, not the original position', () => {
    const removed = toggleOrdered(['a', 'b', 'c'], 'a'); // ['b', 'c']
    expect(toggleOrdered(removed, 'a')).toEqual(['b', 'c', 'a']);
  });
});

describe('evidenceFromPayload', () => {
  it('maps evidence entries in order', () => {
    expect(evidenceFromPayload(openPayload)).toEqual([
      { source: '2026-07-08.1841b', date: '2026-07-08', quote: 'third one this week, always after the standup' },
      { source: '2026-07-11.0912b', date: '2026-07-11', quote: 'aura started before I even opened the laptop' },
    ]);
  });

  it('returns [] when evidence is missing or not an array', () => {
    expect(evidenceFromPayload({})).toEqual([]);
    expect(evidenceFromPayload({ evidence: 'nope' })).toEqual([]);
  });
});

describe('cardsFromPayload', () => {
  it('maps starter fact-cards, preserving a single string source', () => {
    expect(cardsFromPayload(openPayload)).toEqual([
      { section: 'What it is', text: 'Recurring migraines with aura, clustering on workdays.', source: '2026-07-08.1841b' },
    ]);
  });

  it('preserves an array source', () => {
    const r = cardsFromPayload({
      cards: [{ section: 'S', text: 'T', source: ['2026-07-08.1841b', '2026-07-09'] }],
    });
    expect(r).toEqual([{ section: 'S', text: 'T', source: ['2026-07-08.1841b', '2026-07-09'] }]);
  });

  it('returns [] when cards is missing', () => {
    expect(cardsFromPayload({})).toEqual([]);
  });
});

describe('threadOpenDraftFromPayload', () => {
  it('prefills every field from the staged payload', () => {
    expect(threadOpenDraftFromPayload(openPayload)).toEqual({
      name: 'Migraines',
      slug: 'migraines',
      aliasesText: 'migraine, aura',
      kind: 'standing',
      fronts: ['health', 'job'],
      parents: ['long-covid'],
      people: ['michael'],
    });
  });

  it('defaults kind to standing for anything other than "arc"', () => {
    expect(threadOpenDraftFromPayload({ kind: 'arc' }).kind).toBe('arc');
    expect(threadOpenDraftFromPayload({ kind: 'bogus' }).kind).toBe('standing');
    expect(threadOpenDraftFromPayload({}).kind).toBe('standing');
  });

  it('defaults parents/fronts/people/aliases to empty when absent', () => {
    const d = threadOpenDraftFromPayload({ name: 'x', slug: 'x' });
    expect(d.aliasesText).toBe('');
    expect(d.fronts).toEqual([]);
    expect(d.parents).toEqual([]);
    expect(d.people).toEqual([]);
  });
});

describe('threadOpenPayloadFromDraft', () => {
  it('round-trip preserves evidence, cards, proposer, and rationale untouched', () => {
    const draft = threadOpenDraftFromPayload(openPayload);
    const merged = threadOpenPayloadFromDraft(draft, openPayload);
    expect(merged.evidence).toEqual(openPayload.evidence);
    expect(merged.cards).toEqual(openPayload.cards);
    expect(merged.proposer).toBe(openPayload.proposer);
    expect(merged.rationale).toBe(openPayload.rationale);
  });

  it('overwrites only the editable fields with the edited draft', () => {
    const draft = openDraft({
      name: '  New Name  ',
      aliasesText: 'x, y',
      kind: 'arc',
      fronts: ['job'],
      parents: [],
      people: ['bryan'],
    });
    const merged = threadOpenPayloadFromDraft(draft, openPayload);
    expect(merged.name).toBe('New Name');
    expect(merged.aliases).toEqual(['x', 'y']);
    expect(merged.kind).toBe('arc');
    expect(merged.fronts).toEqual(['job']);
    expect(merged.parents).toEqual([]);
    expect(merged.people).toEqual(['bryan']);
    expect(merged.slug).toBe('migraines');
  });
});

describe('linkChangeRows', () => {
  it('orders rows: fronts, then parents, then people — adds before removes in each', () => {
    const rows = linkChangeRows({
      add_fronts: ['job'],
      remove_fronts: ['health'],
      add_parents: ['the-body'],
      remove_parents: ['long-covid'],
      add_people: ['michael'],
      remove_people: ['bryan'],
    });
    expect(rows).toEqual([
      { op: 'add', what: 'front', id: 'job' },
      { op: 'remove', what: 'front', id: 'health' },
      { op: 'add', what: 'parent', id: 'the-body' },
      { op: 'remove', what: 'parent', id: 'long-covid' },
      { op: 'add', what: 'person', id: 'michael' },
      { op: 'remove', what: 'person', id: 'bryan' },
    ]);
  });

  it('skips empty/missing arrays', () => {
    expect(linkChangeRows({ add_fronts: ['job'] })).toEqual([{ op: 'add', what: 'front', id: 'job' }]);
    expect(linkChangeRows({})).toEqual([]);
  });

  it('preserves within-array order for multiple entries', () => {
    const rows = linkChangeRows({ add_fronts: ['job', 'hobbies'] });
    expect(rows.map((r) => r.id)).toEqual(['job', 'hobbies']);
  });
});

describe('linkRowLabel', () => {
  it('formats add/remove rows for fronts, parents, and people', () => {
    expect(linkRowLabel({ op: 'add', what: 'front', id: 'job' })).toBe('+ front: job');
    expect(linkRowLabel({ op: 'remove', what: 'parent', id: 'x' })).toBe('− parent: x');
    expect(linkRowLabel({ op: 'add', what: 'person', id: 'michael' })).toBe('+ person: michael');
  });
});

describe('threadNameForSlug', () => {
  it('resolves a known slug to its name', () => {
    expect(threadNameForSlug([{ id: 'migraines', name: 'Migraines' }], 'migraines')).toBe('Migraines');
  });

  it('falls back to the bare slug when not found', () => {
    expect(threadNameForSlug([], 'migraines')).toBe('migraines');
    expect(threadNameForSlug([{ id: 'other', name: 'Other' }], 'migraines')).toBe('migraines');
  });
});

describe('lastCardLabel', () => {
  it('formats a present date', () => {
    expect(lastCardLabel('2026-06-10')).toBe('last card: 2026-06-10');
  });

  it('returns empty string when absent', () => {
    expect(lastCardLabel('')).toBe('');
  });
});
