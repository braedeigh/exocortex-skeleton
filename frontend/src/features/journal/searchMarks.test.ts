import { describe, expect, it } from 'vitest';
import { mdToHtml } from './markdown';
import { marksToHtml, stripMarks } from './searchMarks';

describe('marksToHtml', () => {
  it('wraps each marked word in a mark tag', () => {
    expect(marksToHtml('from \u0002Tate\u0003 on \u0002Instagram\u0003')).toBe(
      'from <mark class="search-hit">Tate</mark> on <mark class="search-hit">Instagram</mark>',
    );
  });

  it('survives the markdown step intact', () => {
    expect(marksToHtml(mdToHtml('**\u0002bold\u0003** & more'))).toBe(
      '<p><strong><mark class="search-hit">bold</mark></strong> &amp; more</p>',
    );
  });
});

describe('stripMarks', () => {
  it('removes every marker', () => {
    expect(stripMarks('a \u0002b\u0003 c')).toBe('a b c');
  });
});
