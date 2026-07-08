import { describe, expect, it } from 'vitest';
import { entityHue, mdToHtml } from './markdown';

describe('mdToHtml', () => {
  it('renders headings', () => {
    expect(mdToHtml('# Title')).toBe('<h1>Title</h1>');
    expect(mdToHtml('## Sub')).toBe('<h2>Sub</h2>');
    expect(mdToHtml('### Sub sub')).toBe('<h3>Sub sub</h3>');
  });

  it('renders an hr (legacy quirk: the trailing </p> is never stripped after a void <hr>)', () => {
    expect(mdToHtml('---')).toBe('<hr></p>');
  });

  it('renders bold and italic', () => {
    expect(mdToHtml('**bold** and *italic*')).toBe('<p><strong>bold</strong> and <em>italic</em></p>');
  });

  it('renders inline code', () => {
    expect(mdToHtml('`code`')).toBe('<p><code>code</code></p>');
  });

  it('escapes HTML-significant characters first', () => {
    expect(mdToHtml('<script>&</script>')).toBe('<p>&lt;script&gt;&amp;&lt;/script&gt;</p>');
  });

  it('renders a blockquote', () => {
    expect(mdToHtml('> quoted')).toBe('<blockquote>quoted</blockquote>');
  });

  it('renders a list', () => {
    expect(mdToHtml('- one\n- two')).toBe('<ul><li>one</li>\n<li>two</li></ul>');
  });

  it('wraps paragraphs on blank lines', () => {
    expect(mdToHtml('first\n\nsecond')).toBe('<p>first</p><p>second</p>');
  });

  it('handles empty/null input', () => {
    expect(mdToHtml('')).toBe('<p></p>');
    expect(mdToHtml(null)).toBe('<p></p>');
    expect(mdToHtml(undefined)).toBe('<p></p>');
  });
});

describe('entityHue', () => {
  it('is deterministic for the same name', () => {
    expect(entityHue('bradie')).toBe(entityHue('bradie'));
  });

  it('stays within 0-359', () => {
    for (const name of ['bradie', 'k', 'a-very-long-slug-name-indeed']) {
      const hue = entityHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('differs for different names (not guaranteed, but true for these)', () => {
    expect(entityHue('bradie')).not.toBe(entityHue('vivian'));
  });
});
