"""Whether the body stores a nutrient, backed by its NIH ODS sheet's own sentences (nutrient_storage.py).

A tiny sheet stands in for the real one. Checks that a quote the sheet holds
is shown, that one it no longer holds is moved aside rather than shown, that
the sheet's RDA definition comes along, that a nutrient without a sheet says
there's no sourced answer, and that every tracked sheet has an answer.
"""
import pytest

import nutrient_facts
import nutrient_storage

SHEET = """<html><body>
<h2 id="h1">Introduction</h2>
<p>Only small amounts of copper are typically stored in the body, and the average adult has a total body content of 50&ndash;120 mg copper [<a class="fscopy_nounderline" href="#en1">1</a>].</p>
<h2 id="h2">Recommended Intakes</h2>
<ul><li>Recommended Dietary Allowance (RDA): Average daily level of intake sufficient to meet the needs of nearly all.</li></ul>
</body></html>"""


@pytest.fixture
def commons_root(tmp_path, monkeypatch):
    root = tmp_path / "commons"
    (root / "nih-ods").mkdir(parents=True)
    monkeypatch.setenv("EXOCORTEX_COMMONS_DIR", str(root))
    return root


def test_a_quote_the_sheet_holds_is_shown(commons_root):
    (commons_root / "nih-ods" / "Copper-HealthProfessional.html").write_text(SHEET)
    answer = nutrient_storage.storage("copper")
    assert (answer["kind"], answer["quotes"], answer["unverified"]) == (
        "steady", list(nutrient_storage.STORAGE["copper"][3]), [])


def test_a_quote_the_sheet_no_longer_holds_is_not_shown(commons_root):
    (commons_root / "nih-ods" / "Copper-HealthProfessional.html").write_text(SHEET.replace("small", "large"))
    answer = nutrient_storage.storage("copper")
    assert (answer["quotes"], len(answer["unverified"])) == ([], 1)


def test_the_sheets_rda_definition_comes_along(commons_root):
    (commons_root / "nih-ods" / "Copper-HealthProfessional.html").write_text(SHEET)
    assert nutrient_storage.storage("copper")["average"].startswith("Recommended Dietary Allowance (RDA): Average daily")


def test_a_nutrient_without_a_sheet_has_no_sourced_answer(commons_root):
    answer = nutrient_storage.storage("protein")
    assert (answer["kind"], answer["quotes"], nutrient_storage.kind("protein")) == ("unsourced", [], "unsourced")


def test_every_tracked_sheet_has_an_answer():
    assert set(nutrient_storage.STORAGE) == set(nutrient_facts.SHEETS)
