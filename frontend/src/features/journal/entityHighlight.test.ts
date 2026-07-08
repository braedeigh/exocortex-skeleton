import { describe, expect, it } from 'vitest';
import { buildEntityMatcher, highlightEntities } from './entityHighlight';
import { entityHue } from './markdown';
import type { Person } from './types';

function person(overrides: Partial<Person> = {}): Person {
  return { id: 'bradie', name: 'Bradie Lee', file: 'people/bradie.md', tags: [], aliases: [], ...overrides };
}

describe('buildEntityMatcher', () => {
  it('matches first names and aliases, case-insensitively, word-boundary', () => {
    const matcher = buildEntityMatcher([
      person({ id: 'vivian', name: 'Vivian Ostrander', aliases: ['my landlord'] }),
    ]);
    expect(matcher.regex).not.toBeNull();
    expect(matcher.matchToSlug.get('vivian')).toBe('vivian');
    expect(matcher.matchToSlug.get('my landlord')).toBe('vivian');
  });

  it('first person to claim a term wins', () => {
    const matcher = buildEntityMatcher([
      person({ id: 'a', name: 'Sam Adams' }),
      person({ id: 'b', name: 'Sam Bell' }),
    ]);
    expect(matcher.matchToSlug.get('sam')).toBe('a');
  });

  it('sorts terms longest-first so multi-word aliases win', () => {
    const matcher = buildEntityMatcher([person({ id: 'sally', name: 'Sally', aliases: ['my landlord'] })]);
    const source = matcher.regex?.source ?? '';
    const idxLandlord = source.indexOf('my landlord');
    const idxSally = source.toLowerCase().indexOf('sally');
    expect(idxLandlord).toBeGreaterThanOrEqual(0);
    expect(idxLandlord).toBeLessThan(idxSally);
  });

  it('returns a null regex when there are no people', () => {
    const matcher = buildEntityMatcher([]);
    expect(matcher.regex).toBeNull();
  });
});

describe('highlightEntities', () => {
  const matcher = buildEntityMatcher([person({ id: 'vivian', name: 'Vivian Ostrander' })]);

  it('wraps a plain-text match in an entity span with the right slug and color', () => {
    const hue = entityHue('vivian');
    const html = highlightEntities('<p>Saw Vivian today.</p>', matcher);
    expect(html).toBe(
      `<p>Saw <span class="entity" data-slug="vivian" style="color:hsl(${hue} 70% 66%);border-bottom-color:hsl(${hue} 70% 66%)">Vivian</span> today.</p>`,
    );
  });

  it('does not match inside a code span', () => {
    const html = highlightEntities('<p><code>Vivian</code> said hi</p>', matcher);
    expect(html).not.toContain('class="entity"');
  });

  it('does not match inside headings', () => {
    const h1 = highlightEntities('<h1>Vivian</h1>', matcher);
    const h2 = highlightEntities('<h2>Vivian</h2>', matcher);
    const h3 = highlightEntities('<h3>Vivian</h3>', matcher);
    expect(h1).not.toContain('class="entity"');
    expect(h2).not.toContain('class="entity"');
    expect(h3).not.toContain('class="entity"');
  });

  it('does not double-wrap text already inside an entity span', () => {
    const html = highlightEntities('<p><span class="entity" data-slug="vivian">Vivian</span></p>', matcher);
    expect(html.match(/class="entity"/g)?.length).toBe(1);
  });

  it('matches case-insensitively but preserves the original casing in output', () => {
    const html = highlightEntities('<p>vivian and VIVIAN</p>', matcher);
    expect(html).toContain('>vivian<');
    expect(html).toContain('>VIVIAN<');
  });

  it('is a no-op when there is no regex (no people)', () => {
    const empty = buildEntityMatcher([]);
    expect(highlightEntities('<p>Vivian</p>', empty)).toBe('<p>Vivian</p>');
  });

  it('leaves unmatched text untouched', () => {
    expect(highlightEntities('<p>Nobody here.</p>', matcher)).toBe('<p>Nobody here.</p>');
  });
});
