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

  it('renders a table as a real table, standing as its own block between paragraphs', () => {
    const md = [
      'Before.',
      '',
      '| # | Title | Blocked by |',
      '|---|-------|-----------|',
      '| 1 | **Survey** | none |',
      '| 2 | Shells: `api` \\| web |',
      'After.',
    ].join('\n');
    expect(mdToHtml(md)).toBe(
      '<p>Before.</p>' +
        '<table><thead><tr><th>#</th><th>Title</th><th>Blocked by</th></tr></thead><tbody>' +
        '<tr><td>1</td><td><strong>Survey</strong></td><td>none</td></tr>' +
        '<tr><td>2</td><td>Shells: <code>api</code> | web</td><td></td></tr>' +
        '</tbody></table>' +
        '<p>After.</p>',
    );
  });

  it('leaves a line of pipes alone when no divider row follows it', () => {
    expect(mdToHtml('| a | b |\n| c | d |')).toBe('<p>| a | b |\n| c | d |</p>');
  });

  it('handles empty/null input', () => {
    expect(mdToHtml('')).toBe('<p></p>');
    expect(mdToHtml(null)).toBe('<p></p>');
    expect(mdToHtml(undefined)).toBe('<p></p>');
  });
});

describe('entityHue', () => {
  it('is deterministic for the same name', () => {
    expect(entityHue('rowan')).toBe(entityHue('rowan'));
  });

  it('stays within 0-359', () => {
    for (const name of ['rowan', 'k', 'a-very-long-slug-name-indeed']) {
      const hue = entityHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('differs for different names (not guaranteed, but true for these)', () => {
    expect(entityHue('rowan')).not.toBe(entityHue('fern'));
  });
});
