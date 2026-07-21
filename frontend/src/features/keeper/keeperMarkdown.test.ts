import { describe, expect, it } from 'vitest';
import { mdToHtml } from '../journal/markdown';
import {
  EMPTY_FILE_HTML,
  extractFrontmatter,
  parseFrontmatter,
  renderChips,
  renderKeeperBody,
  renderKeeperPreview,
} from './keeperMarkdown';

const FILES: Record<string, string> = {
  sage: 'people/sage.md',
  sleep: 'Patterns/sleep.md',
};
const resolve = (name: string) => FILES[name.trim().toLowerCase()];

describe('parseFrontmatter', () => {
  it('parses bracketed lists with quoted items', () => {
    expect(parseFrontmatter('tags: [friend, "old crew"]')).toEqual({ tags: ['friend', 'old crew'] });
  });

  it('parses a bare value as a one-item list', () => {
    expect(parseFrontmatter('aliases: Sal')).toEqual({ aliases: ['Sal'] });
  });

  it('lowercases keys and skips lines without a colon or with empty values', () => {
    expect(parseFrontmatter('Tags: [x]\njust text\nempty:')).toEqual({ tags: ['x'] });
  });
});

describe('extractFrontmatter', () => {
  it('pulls a tags/aliases block out of the body', () => {
    const md = '---\ntags: [friend]\n---\n# Sage\n';
    expect(extractFrontmatter(md)).toEqual({ meta: { tags: ['friend'] }, body: '# Sage\n' });
  });

  it('leaves frontmatter without tags/aliases in place (renders as-is, like legacy)', () => {
    const md = '---\ncreated: 2026-01-01\n---\nbody';
    expect(extractFrontmatter(md)).toEqual({ meta: null, body: md });
  });

  it('leaves documents without frontmatter untouched', () => {
    expect(extractFrontmatter('# Hi')).toEqual({ meta: null, body: '# Hi' });
  });
});

describe('renderChips', () => {
  it('renders tag pills and an aliases line inside one fm-block', () => {
    expect(renderChips({ tags: ['friend'], aliases: ['Sal', 'S'] })).toBe(
      '<div class="fm-block"><div class="fm-tags"><span class="fm-tag">#friend</span></div>' +
        '<div class="fm-aliases">also known as: Sal, S</div></div>',
    );
  });

  it('renders nothing when there are no tags or aliases', () => {
    expect(renderChips({})).toBe('');
  });
});

describe('renderKeeperBody', () => {
  it('resolves a [[wikilink]] to a clickable span with its target path', () => {
    expect(renderKeeperBody('See [[Sage]].', resolve)).toBe(
      '<p>See <span class="wikilink" data-target="people/sage.md">Sage</span>.</p>',
    );
  });

  it('renders an unresolvable [[wikilink]] as a dead link', () => {
    expect(renderKeeperBody('[[Nobody]]', resolve)).toBe(
      '<p><span class="wikilink dead" title="no file yet">Nobody</span></p>',
    );
  });

  it('resolves case-insensitively and trimmed, but shows the raw name', () => {
    expect(renderKeeperBody('[[ SAGE ]]', resolve)).toBe(
      '<p><span class="wikilink" data-target="people/sage.md"> SAGE </span></p>',
    );
  });

  it('keeps wikilinks working inside headings and list items', () => {
    expect(renderKeeperBody('# About [[Sage]]', resolve)).toBe(
      '<h1>About <span class="wikilink" data-target="people/sage.md">Sage</span></h1>',
    );
    expect(renderKeeperBody('- ping [[sleep]]', resolve)).toBe(
      '<ul><li>ping <span class="wikilink" data-target="Patterns/sleep.md">sleep</span></li></ul>',
    );
  });

  it('escapes HTML inside wikilink names', () => {
    expect(renderKeeperBody('[[a<b]]', resolve)).toBe(
      '<p><span class="wikilink dead" title="no file yet">a&lt;b</span></p>',
    );
  });

  it('accepts "* " bullets like the legacy /^[-*] / list regex', () => {
    expect(renderKeeperBody('* one\n* two', resolve)).toBe('<ul><li>one</li>\n<li>two</li></ul>');
  });

  it('matches mdToHtml exactly for plain markdown (no wikilinks)', () => {
    const md = '# T\n\n**bold** and *em*, `code`\n\n> quote\n\n- item\n\n---';
    expect(renderKeeperBody(md, resolve)).toBe(mdToHtml(md));
  });
});

describe('renderKeeperPreview', () => {
  it('shows the italic empty-file message for blank content', () => {
    expect(renderKeeperPreview('', resolve)).toBe(EMPTY_FILE_HTML);
    expect(renderKeeperPreview('   \n', resolve)).toBe(EMPTY_FILE_HTML);
  });

  it('renders chips ahead of the body and strips the frontmatter from it', () => {
    const html = renderKeeperPreview('---\ntags: [friend]\naliases: [Sal]\n---\n# Sage', resolve);
    expect(html).toBe(
      '<div class="fm-block"><div class="fm-tags"><span class="fm-tag">#friend</span></div>' +
        '<div class="fm-aliases">also known as: Sal</div></div><h1>Sage</h1>',
    );
  });

  it('lets non-chip frontmatter render as a horizontal rule, like legacy', () => {
    const html = renderKeeperPreview('---\ncreated: x\n---\nbody', resolve);
    expect(html).toContain('<hr>');
    expect(html).toContain('created: x');
  });
});
