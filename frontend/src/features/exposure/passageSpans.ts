/**
 * passageSpans.ts — which pieces of a PDF page's text make up a passage.
 *
 * What this does: pdf.js lays a page's text out as many small pieces (one
 * per run of text on the page). A highlight is stored as a passage of words,
 * extracted with different spacing, so this joins the pieces with all
 * whitespace removed, finds the passage the same way (whitespace ignored,
 * like pdfpages.py on the server), and returns the index of every piece the
 * passage touches — the ones PdfPassage.tsx colours in.
 *
 * Touches: PdfPassage.tsx; tested in passageSpans.test.ts.
 */

function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

/** Indexes of the pieces the passage runs through, or [] if it isn't on the page. */
export function passageSpans(pieces: string[], passage: string): number[] {
  const wanted = squash(passage);
  if (!wanted) return [];
  const starts: number[] = [];
  let joined = '';
  for (const piece of pieces) {
    starts.push(joined.length);
    joined += squash(piece);
  }
  const at = joined.indexOf(wanted);
  if (at < 0) return [];
  const end = at + wanted.length;
  const hit: number[] = [];
  pieces.forEach((piece, index) => {
    const start = starts[index];
    const stop = start + squash(piece).length;
    if (stop > start && start < end && stop > at) hit.push(index);
  });
  return hit;
}
