"""The DRI tables reader (dri.py).

The parser works on the text pdftotext prints, so a hand-written slice of
that text stands in for the PDF: male and female rows are read and every
other group is skipped, an AI star is kept as kind 'ai', footnote letters
and thousands commas are read past, ND cells are left out, and a row with
the wrong number of cells is refused rather than guessed at. The 2019
sodium/potassium values replace the old adult rows, sodium's UL included.
"""
import pytest

import dri

VITAMINS = "  ".join(["400"] * 14)
RDA_ELEMENTS_F = "1,000  25*  900  3*  150  18  310  1.8*  45  700  55  8  4.7*  1.5*  2.3*"
UL_ELEMENTS = "ND  20  2,500  ND  10,000  10  1,100  45  350  11  2,000  1.0  4  400  ND  1.8  40  2.3  3.6"

TEXT = f"""
Dietary Reference Intakes (DRIs): Recommended Dietary Allowances and Adequate Intakes, Elements
Children
      1–3 y       700  11*  340  0.7*  90  7  80  1.2*  17  460  20  3  3.0*  1.0*  1.5*
Females
     19–30 y    {RDA_ELEMENTS_F}
      > 70 y    {RDA_ELEMENTS_F}
Pregnancy
     19–30 y    {RDA_ELEMENTS_F.replace("18", "27")}
Dietary Reference Intakes (DRIs): Tolerable Upper Intake Levels, Elements
Females
     19−30 y    {UL_ELEMENTS}
"""


def rows_for(nutrient, kind=None):
    return [r for r in dri.parse_tables(TEXT)
            if r["nutrient"] == nutrient and (kind is None or r["kind"] == kind)]


def test_reads_female_rows_only():
    assert {(r["sex"], r["age_band"]) for r in rows_for("iron", "rda")} == {("female", "19-30"), ("female", "71+")}


def test_star_marks_an_adequate_intake():
    assert rows_for("manganese", "rda") == [] and rows_for("manganese", "ai")[0]["value"] == 1.8


def test_commas_are_read_past():
    assert rows_for("copper", "ul")[0]["value"] == 10000.0


def test_nd_cells_are_left_out():
    assert rows_for("arsenic") == []


def test_wrong_cell_count_is_refused():
    with pytest.raises(ValueError):
        dri.parse_tables(TEXT.replace(RDA_ELEMENTS_F, "1,000  25*"))


def test_2019_update_replaces_sodium_rows_and_its_ul(tmp_path, data_dir, monkeypatch):
    import commonsdb
    monkeypatch.setattr(dri, "pdf_text", lambda path: TEXT)
    pdf = tmp_path / "t.pdf"
    pdf.write_bytes(b"%PDF")
    with commonsdb.session(tmp_path / "commons") as conn:
        dri.load_dri(conn, pdf)
        sodium = dri.targets(conn, "female", 29)["sodium"]
    assert {kind: row["value"] for kind, row in sodium.items()} == {"ai": 1500, "cdrr": 2300}


def test_age_band_edges():
    assert [dri.age_band(a) for a in (19, 30, 31, 70, 71)] == ["19-30", "19-30", "31-50", "51-70", "71+"]
