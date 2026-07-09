import { describe, expect, it } from 'vitest';
import { countBullets, ideasMdBlock, ideasMdInline, parseIdeaSections, preambleBody } from './ideasDoc';

describe('parseIdeaSections', () => {
  it('splits on ## headings, keeping everything before the first as the preamble', () => {
    const md = '# Title\nintro line\n\n## One\n- a\n- b\n## Two\ntext';
    const secs = parseIdeaSections(md);
    expect(secs).toHaveLength(3);
    expect(secs[0]).toEqual({ title: null, lines: ['# Title', 'intro line', ''] });
    expect(secs[1]).toEqual({ title: 'One', lines: ['- a', '- b'] });
    expect(secs[2]).toEqual({ title: 'Two', lines: ['text'] });
  });

  it('returns a single preamble section for a doc with no ## headings', () => {
    const secs = parseIdeaSections('just some text');
    expect(secs).toHaveLength(1);
    expect(secs[0].title).toBeNull();
    expect(secs[0].lines).toEqual(['just some text']);
  });

  it('trims section titles but not their bodies', () => {
    const secs = parseIdeaSections('##  Spaced  \n  indented');
    // "## " requires exactly one space, then the rest is trimmed.
    expect(secs[1].title).toBe('Spaced');
    expect(secs[1].lines).toEqual(['  indented']);
  });

  it('does not treat ### headings as section breaks', () => {
    const secs = parseIdeaSections('## Top\n### Sub\nbody');
    expect(secs).toHaveLength(2);
    expect(secs[1].lines).toEqual(['### Sub', 'body']);
  });

  it('handles the empty doc (one empty preamble)', () => {
    expect(parseIdeaSections('')).toEqual([{ title: null, lines: [''] }]);
  });
});

describe('ideasMdInline', () => {
  it('escapes HTML-significant characters first', () => {
    expect(ideasMdInline('<b> & </b>')).toBe('&lt;b&gt; &amp; &lt;/b&gt;');
  });

  it('renders http(s) links with target=_blank', () => {
    expect(ideasMdInline('[site](https://example.com)')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener">site</a>',
    );
  });

  it('leaves non-http link syntax alone', () => {
    expect(ideasMdInline('[note](ftp://x)')).toBe('[note](ftp://x)');
  });

  it('renders bold, italic and code', () => {
    expect(ideasMdInline('**b** *i* `c`')).toBe('<strong>b</strong> <em>i</em> <code>c</code>');
  });
});

describe('ideasMdBlock', () => {
  it('renders - and * bullets into one list', () => {
    expect(ideasMdBlock('- one\n* two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('renders indented and ordered list items', () => {
    expect(ideasMdBlock('  - nested\n1. first')).toBe('<ul><li>nested</li><li>first</li></ul>');
  });

  it('joins consecutive blockquote lines with <br>', () => {
    expect(ideasMdBlock('> a\n> b')).toBe('<blockquote>a<br>b</blockquote>');
  });

  it('a list interrupts a quote and vice versa', () => {
    expect(ideasMdBlock('> q\n- li')).toBe('<blockquote>q</blockquote>\n<ul><li>li</li></ul>');
  });

  it('renders ### headings, --- rules and paragraphs', () => {
    expect(ideasMdBlock('### H\n---\ntext')).toBe('<h3>H</h3>\n<hr>\n<p>text</p>');
  });

  it('blank lines split lists and paragraphs', () => {
    expect(ideasMdBlock('- a\n\n- b')).toBe('<ul><li>a</li></ul>\n<ul><li>b</li></ul>');
  });

  it('applies inline formatting inside blocks', () => {
    expect(ideasMdBlock('- **bold** item')).toBe('<ul><li><strong>bold</strong> item</li></ul>');
  });

  it('ignores trailing whitespace on lines', () => {
    expect(ideasMdBlock('text   ')).toBe('<p>text</p>');
  });
});

describe('preambleBody', () => {
  it('drops the # title line and --- rules, then trims', () => {
    const pre = parseIdeaSections('# IDEAS\n\nintro\n---\n\n## S\nx')[0];
    expect(preambleBody(pre)).toBe('intro');
  });

  it('only removes the first # title line', () => {
    const pre = { title: null, lines: ['# One', 'body', '# Two'] };
    expect(preambleBody(pre)).toBe('body\n# Two');
  });

  it('returns empty string for a title-only preamble', () => {
    const pre = parseIdeaSections('# IDEAS\n## S\nx')[0];
    expect(preambleBody(pre)).toBe('');
  });
});

describe('countBullets', () => {
  it('counts -, * and indented bullets but not ordered items or prose', () => {
    expect(countBullets(['- a', '* b', '  - c', '1. d', 'text', '-no space'])).toBe(3);
  });
});
