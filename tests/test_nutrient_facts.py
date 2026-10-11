"""Pulling a nutrient's sections out of its NIH ODS fact sheet (nutrient_facts.py).

A tiny sheet in the real sheets' shape: <h2> headings, <p>/<h3>/<li> blocks,
citation links with class fscopy_nounderline. Checks that the three sections
come back word for word with the citations gone, that a nutrient ODS has no
sheet for says so instead of inventing text, and that a sheet not yet
fetched into the commons is flagged missing.
"""
import pytest

import nutrient_facts

SHEET = """<html><body>
<h2>Table of Contents</h2><ul><li>Introduction</li></ul>
<h2 id="h1">Introduction</h2>
<p>Iron is a mineral [<a href="#en1" class="fscopy_nounderline">1</a>].</p>
<p>Second intro paragraph.</p><p>Third, not shown.</p>
<h2 id="h8">Iron Deficiency</h2>
<p>People with iron deficiency anemia may experience weakness [<a class="fscopy_nounderline" href="#en2">2</a>,<a class="fscopy_nounderline" href="#en3">3-5</a>].</p>
<ul><li>Storage iron depletion</li></ul>
<h2 id="h9">Groups at Risk of Iron Inadequacy</h2>
<h3>Pregnant women</h3><p>Needs rise.</p>
<h2 id="h17">Iron and Health</h2><p>Not wanted.</p>
</body></html>"""


@pytest.fixture
def commons_root(tmp_path, monkeypatch):
    root = tmp_path / "commons"
    (root / "nih-ods").mkdir(parents=True)
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    return root


def test_deficiency_section_comes_back_without_citations(commons_root):
    (commons_root / "nih-ods" / "Iron-HealthProfessional.html").write_text(SHEET)
    facts = nutrient_facts.facts("iron")
    assert facts["deficiency"] == [
        {"kind": "p", "text": "People with iron deficiency anemia may experience weakness."},
        {"kind": "li", "text": "Storage iron depletion"}]


def test_intro_is_its_first_two_paragraphs(commons_root):
    (commons_root / "nih-ods" / "Iron-HealthProfessional.html").write_text(SHEET)
    assert [b["text"] for b in nutrient_facts.facts("iron")["intro"]] == ["Iron is a mineral.", "Second intro paragraph."]


def test_groups_at_risk_keep_their_subheadings(commons_root):
    (commons_root / "nih-ods" / "Iron-HealthProfessional.html").write_text(SHEET)
    assert nutrient_facts.facts("iron")["at_risk"][0] == {"kind": "h3", "text": "Pregnant women"}


def test_a_nutrient_without_an_ods_sheet_has_no_text(commons_root):
    assert nutrient_facts.facts("protein") == {"key": "protein", "sheet": None, "intro": [], "deficiency": [],
                                               "at_risk": []}


def test_a_sheet_not_yet_fetched_is_flagged_missing(commons_root):
    facts = nutrient_facts.facts("zinc")
    assert (facts["sheet"]["missing"], facts["deficiency"]) == (True, [])
