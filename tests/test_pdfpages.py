"""Finding a passage's page (pdfpages.py). What can silently break: a
passage whose spacing differs from the PDF's being missed, one running over
a page break landing on the wrong page, and an off-by-one in page numbers."""
import pdfpages


def test_passage_is_found_despite_different_spacing():
    pages = ["Intro text", "Carrots (708)   46.0\nBroccoli (708) 21.0", "End"]
    assert pdfpages.find_page(pages, "Broccoli (708)                   21.0") == 2


def test_passage_over_a_page_break_lands_on_its_first_page():
    assert pdfpages.find_page(["one two", "three four"], "two three") == 1


def test_missing_passage_is_none():
    assert pdfpages.find_page(["one"], "absent") is None and pdfpages.find_page(["one"], "  ") is None
