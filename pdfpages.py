"""Which page of a PDF a passage is on.

**What this does.** Highlights in the research pool are stored as passages of
a source's extracted text (research_annotations: the exact words, plus
character offsets into docstore's text). That text has lost its page breaks,
so to open the source's own PDF at a highlight this module re-reads the PDF
page by page (`pdftotext -layout`, which ends each page with a form feed)
and finds the page each passage starts on. Matching ignores whitespace —
the layout spacing differs between extractions — the same way
scripts/research_claims.py finds a passage. The stored text and its offsets
are never touched.

Touches: `paperclients.py` (which pdftotext binary), `scripts/reference_data.py`
(fetch-pdf runs this and stores the pages through exposurestore),
`tests/test_pdfpages.py`.

Prompt that produced this file: "i want pdfs to be downloaded so they can pop
up next to the claim and highlight exactly where in the claim that it was."
"""
import subprocess

import paperclients


def page_texts(pdf_path, timeout=120):
    """The PDF's text, one string per page, in order."""
    completed = subprocess.run(
        [paperclients.PDFTOTEXT_BIN, "-layout", str(pdf_path), "-"],
        capture_output=True, timeout=timeout, check=True)
    pages = completed.stdout.decode("utf-8", "replace").split("\f")
    # pdftotext ends the last page with a form feed too; drop the empty tail.
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def _squash(text):
    """Text with every whitespace character removed, for matching."""
    return "".join(str(text or "").split())


def find_page(pages, exact):
    """The 1-based page the passage `exact` starts on, or None if it isn't there.

    The pages are joined with no whitespace and searched as one string, so a
    passage running over a page break is still found (on its first page).
    """
    wanted = _squash(exact)
    if not wanted:
        return None
    joined, starts = [], []
    position = 0
    for text in pages:
        squashed = _squash(text)
        starts.append(position)
        joined.append(squashed)
        position += len(squashed)
    found = "".join(joined).find(wanted)
    if found < 0:
        return None
    page = 0
    while page + 1 < len(starts) and starts[page + 1] <= found:
        page += 1
    return page + 1
