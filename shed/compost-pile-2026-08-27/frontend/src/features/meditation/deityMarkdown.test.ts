import { describe, expect, it } from 'vitest';
import { deityMdToHtml } from './deityMarkdown';

describe('deityMdToHtml — blocks', () => {
  it('renders headings h1–h6 with inline formatting', () => {
    expect(deityMdToHtml('# Title')).toBe('<h1>Title</h1>');
    expect(deityMdToHtml('### **Bold** head')).toBe('<h3><strong>Bold</strong> head</h3>');
    expect(deityMdToHtml('###### tiny')).toBe('<h6>tiny</h6>');
  });

  it('renders ---/===/***/___ runs as horizontal rules', () => {
    expect(deityMdToHtml('-----')).toBe('<hr>');
    expect(deityMdToHtml('===')).toBe('<hr>');
    expect(deityMdToHtml('***')).toBe('<hr>');
  });

  it('renders paragraphs, joining adjacent lines with <br>', () => {
    expect(deityMdToHtml('line one\nline two')).toBe('<p>line one<br>line two</p>');
    expect(deityMdToHtml('a\n\nb')).toBe('<p>a</p><p>b</p>');
  });

  it('renders multi-line blockquotes with <br> joins', () => {
    expect(deityMdToHtml('> first\n> second')).toBe('<blockquote>first<br>second</blockquote>');
  });

  it('renders unordered and ordered lists', () => {
    expect(deityMdToHtml('- a\n* b\n+ c')).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
    expect(deityMdToHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  it('escapes raw HTML', () => {
    expect(deityMdToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });
});

describe('deityMdToHtml — inline', () => {
  it('renders bold, italic and inline code', () => {
    expect(deityMdToHtml('**b** and *i* and `c`')).toBe(
      '<p><strong>b</strong> and <em>i</em> and <code>c</code></p>',
    );
  });

  it('renders markdown links with target=_blank', () => {
    expect(deityMdToHtml('[FPMT](https://fpmt.org)')).toBe(
      '<p><a href="https://fpmt.org" target="_blank" rel="noopener">FPMT</a></p>',
    );
  });

  it('auto-links bare URLs with the mdAuto class, leaving markdown links alone', () => {
    expect(deityMdToHtml('see https://example.com now')).toBe(
      '<p>see <a href="https://example.com" target="_blank" rel="noopener" class="mdAuto">https://example.com</a> now</p>',
    );
    // A markdown link must not get double-wrapped by the autolinker.
    const md = deityMdToHtml('[x](https://a.b)');
    expect(md.match(/<a /g)).toHaveLength(1);
  });
});

describe('deityMdToHtml — tables', () => {
  const table = '| Word | Meaning |\n|------|---------|\n| oṃ | sacred syllable |\n| tāre | swift one |';

  it('renders a GFM table with thead and tbody', () => {
    const html = deityMdToHtml(table);
    expect(html).toContain('<div class="mdTableWrap"><table>');
    expect(html).toContain('<thead><tr><th>Word</th><th>Meaning</th></tr></thead>');
    expect(html).toContain('<tr><td>oṃ</td><td>sacred syllable</td></tr>');
    expect(html).toContain('<tr><td>tāre</td><td>swift one</td></tr>');
  });

  it('skips blank padding rows and pads ragged rows to the header width', () => {
    const html = deityMdToHtml('| A | B |\n|---|---|\n|  |  |\n| only-a |');
    expect(html).not.toContain('<tr><td></td><td></td></tr>');
    expect(html).toContain('<tr><td>only-a</td><td></td></tr>');
  });

  it('drops extra cells beyond the header width', () => {
    const html = deityMdToHtml('| A |\n|---|\n| one | extra |');
    expect(html).toContain('<tr><td>one</td></tr>');
    expect(html).not.toContain('extra');
  });

  it('treats a pipe line without a separator as a paragraph', () => {
    expect(deityMdToHtml('a | b')).toBe('<p>a | b</p>');
  });

  it('renders inline markdown inside cells', () => {
    const html = deityMdToHtml('| H |\n|---|\n| **bold** |');
    expect(html).toContain('<td><strong>bold</strong></td>');
  });
});

describe('deityMdToHtml — document flow', () => {
  it('renders a realistic mantra profile in order', () => {
    const body = [
      '# Medicine Buddha Mantra',
      '',
      '**Romanized text:**',
      'Tadyathā: oṃ bhaiṣajye svāhā',
      '',
      '-----',
      '',
      '## Translation',
      '',
      '| Word | Meaning |',
      '|------|---------|',
      '| oṃ | sacred syllable |',
      '',
      '> Recited for healing.',
    ].join('\n');
    const html = deityMdToHtml(body);
    const order = ['<h1>', '<p><strong>', '<hr>', '<h2>', 'mdTableWrap', '<blockquote>'];
    let last = -1;
    for (const marker of order) {
      const idx = html.indexOf(marker);
      expect(idx, `expected ${marker} in output`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it('returns empty string for empty input', () => {
    expect(deityMdToHtml('')).toBe('');
    expect(deityMdToHtml(null)).toBe('');
    expect(deityMdToHtml('   \n\n')).toBe('');
  });
});
