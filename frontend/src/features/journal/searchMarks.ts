/**
 * Lights up the matching words in a journal search result.
 *
 * The server sends each result card's whole text with every matching word
 * wrapped in two invisible marker characters (cardsearch.py's _HIT_START and
 * _HIT_END, which can't occur in anything she writes). The card is rendered
 * as usual — markdown, people and threads highlighted — with the markers
 * riding along untouched, and `marksToHtml` swaps them for <mark> tags at the
 * very end. Doing it last means the markers never get escaped or broken up by
 * the markdown step. `stripMarks` removes them where they must not appear
 * (a photo's file name, the text of an edit box).
 */

export const HIT_START = '\u0002';
export const HIT_END = '\u0003';

const ANY_MARK = /[\u0002\u0003]/g;

/** Rendered HTML with markers -> the same HTML with each hit in <mark>. */
export function marksToHtml(html: string): string {
  return html.replaceAll(HIT_START, '<mark class="search-hit">').replaceAll(HIT_END, '</mark>');
}

/** Text with markers -> the plain text. */
export function stripMarks(text: string): string {
  return text.replace(ANY_MARK, '');
}
