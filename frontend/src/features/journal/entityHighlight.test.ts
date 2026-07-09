import { describe, expect, it } from 'vitest';
import { buildEntityMatcher, highlightEntities } from './entityHighlight';
import { entityHue } from './markdown';
import type { Person, Thread } from './types';

function person(overrides: Partial<Person> = {}): Person {
  return { id: 'bradie', name: 'Bradie Lee', file: 'people/bradie.md', tags: [], aliases: [], ...overrides };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return { id: 'office-hours', name: 'Office Hours', file: 'Threads/office-hours.md', aliases: [], ...overrides };
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

  it('matches thread names and aliases into matchToThread', () => {
    const matcher = buildEntityMatcher([], [thread({ aliases: ['TPOT', 'tianmucord'] })]);
    expect(matcher.regex).not.toBeNull();
    expect(matcher.matchToThread.get('office hours')).toBe('office-hours');
    expect(matcher.matchToThread.get('tpot')).toBe('office-hours');
    expect(matcher.matchToThread.get('tianmucord')).toBe('office-hours');
  });

  it('people claim a shared term before threads', () => {
    const matcher = buildEntityMatcher(
      [person({ id: 'sam', name: 'Sam Adams' })],
      [thread({ id: 'sam-club', name: 'Sam', aliases: ['the club'] })],
    );
    expect(matcher.matchToSlug.get('sam')).toBe('sam');
    expect(matcher.matchToThread.has('sam')).toBe(false);
    expect(matcher.matchToThread.get('the club')).toBe('sam-club');
  });

  it('first thread to claim a term wins among threads', () => {
    const matcher = buildEntityMatcher(
      [],
      [thread({ id: 'a', name: 'Office Hours' }), thread({ id: 'b', name: 'office hours' })],
    );
    expect(matcher.matchToThread.get('office hours')).toBe('a');
  });

  it('builds an identical people matcher whether or not the threads arg is passed', () => {
    const people = [person({ id: 'vivian', name: 'Vivian Ostrander', aliases: ['my landlord'] })];
    const withoutThreads = buildEntityMatcher(people);
    const withEmptyThreads = buildEntityMatcher(people, []);
    expect(withEmptyThreads.regex?.source).toBe(withoutThreads.regex?.source);
    expect([...withEmptyThreads.matchToSlug]).toEqual([...withoutThreads.matchToSlug]);
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

  describe('threads', () => {
    const both = buildEntityMatcher(
      [person({ id: 'vivian', name: 'Vivian Ostrander' })],
      [thread({ aliases: ['TPOT'] })],
    );

    it('wraps a thread match in an entity-thread span with data-thread and no inline color', () => {
      const html = highlightEntities('<p>Went to Office Hours tonight.</p>', both);
      expect(html).toBe(
        '<p>Went to <span class="entity entity-thread" data-thread="office-hours">Office Hours</span> tonight.</p>',
      );
    });

    it('matches thread aliases case-insensitively, preserving original casing', () => {
      const html = highlightEntities('<p>tpot again</p>', both);
      expect(html).toContain('<span class="entity entity-thread" data-thread="office-hours">tpot</span>');
    });

    it('person highlighting output is byte-identical with threads in the matcher', () => {
      const peopleOnly = buildEntityMatcher([person({ id: 'vivian', name: 'Vivian Ostrander' })]);
      const input = '<p>Saw Vivian today.</p>';
      expect(highlightEntities(input, both)).toBe(highlightEntities(input, peopleOnly));
    });

    it('highlights people and threads side by side in one text node', () => {
      const hue = entityHue('vivian');
      const html = highlightEntities('<p>Vivian was at Office Hours.</p>', both);
      expect(html).toBe(
        `<p><span class="entity" data-slug="vivian" style="color:hsl(${hue} 70% 66%);border-bottom-color:hsl(${hue} 70% 66%)">Vivian</span>` +
          ' was at <span class="entity entity-thread" data-thread="office-hours">Office Hours</span>.</p>',
      );
    });

    it('does not match threads inside code or headings', () => {
      expect(highlightEntities('<p><code>Office Hours</code></p>', both)).not.toContain('entity-thread');
      expect(highlightEntities('<h2>Office Hours</h2>', both)).not.toContain('entity-thread');
    });

    it('does not double-wrap an existing entity-thread span', () => {
      const html = highlightEntities(
        '<p><span class="entity entity-thread" data-thread="office-hours">Office Hours</span></p>',
        both,
      );
      expect(html.match(/entity-thread/g)?.length).toBe(1);
    });
  });
});
