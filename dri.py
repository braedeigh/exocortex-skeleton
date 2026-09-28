"""The Dietary Reference Intakes — how much of each nutrient a day is enough, and too much.

**What this is.** The DRIs are the Food and Nutrition Board's (National
Academies) daily targets, by sex and age:

  RDA  Recommended Dietary Allowance — enough for 97–98% of healthy people.
       Set from measured requirements, so it's the firmer kind of number.
  AI   Adequate Intake — used where the evidence was too thin for an RDA.
       A best guess that's believed to be enough; treat it as softer.
  UL   Tolerable Upper Intake Level — the most a day that's likely safe.
       Some ULs count only supplements or added forms, not food (see UL_SCOPE).

The file of record is the four summary tables in the commons
(`<commons>/nasem-dri/vitaminintake.pdf`, fetched by scripts/commons_fetch.py).
`load_dri` reads its text (poppler's `pdftotext -layout`) row by row into the
`dri_values` table in commons.db — one row per nutrient × sex × age band ×
kind — keeping the value exactly in the unit the table prints. Only the male
and female rows are read, not infants, children, pregnancy or lactation.

One correction sits on top: the 2019 sodium and potassium report replaced the
2005 values those tables print (UPDATES_2019, cited below). It is typed in
from the report, not read from a commons file — the National Academies'
servers turn away scripted downloads — so it is marked that way wherever it
shows.

Touches: `commonsdb.py` (the connection), `commons.py` (checksums),
`nutrition.py` (reads targets), `scripts/nutrient_data.py` (runs the loader),
`tests/test_dri.py`. Design: docs/nutrition.md.

Prompt that produced this file: step 3 of the own-Cronometer plan — "Targets:
the DRI minimums (RDA/AI) and upper limits (UL)."
"""
import re
import subprocess

import commons

TABLE_FILE = "nasem-dri/vitaminintake.pdf"

# Each table's columns in the order the PDF prints them: (nutrient, unit).
# A unit of None is a column this app doesn't use (it's read past, not kept).
COLUMNS = {
    ("rda", "vitamins"): (
        ("vitamin_a", "µg"), ("vitamin_c", "mg"), ("vitamin_d", "µg"), ("vitamin_e", "mg"),
        ("vitamin_k", "µg"), ("thiamin", "mg"), ("riboflavin", "mg"), ("niacin", "mg"),
        ("vitamin_b6", "mg"), ("folate", "µg"), ("vitamin_b12", "µg"),
        ("pantothenic_acid", "mg"), ("biotin", "µg"), ("choline", "mg")),
    ("rda", "elements"): (
        ("calcium", "mg"), ("chromium", "µg"), ("copper", "µg"), ("fluoride", "mg"),
        ("iodine", "µg"), ("iron", "mg"), ("magnesium", "mg"), ("manganese", "mg"),
        ("molybdenum", "µg"), ("phosphorus", "mg"), ("selenium", "µg"), ("zinc", "mg"),
        ("potassium", "g"), ("sodium", "g"), ("chloride", "g")),
    ("ul", "vitamins"): (
        ("vitamin_a", "µg"), ("vitamin_c", "mg"), ("vitamin_d", "µg"), ("vitamin_e", "mg"),
        ("vitamin_k", None), ("thiamin", None), ("riboflavin", None), ("niacin", "mg"),
        ("vitamin_b6", "mg"), ("folate", "µg"), ("vitamin_b12", None),
        ("pantothenic_acid", None), ("biotin", None), ("choline", "g"), ("carotenoids", None)),
    ("ul", "elements"): (
        ("arsenic", None), ("boron", "mg"), ("calcium", "mg"), ("chromium", None),
        ("copper", "µg"), ("fluoride", "mg"), ("iodine", "µg"), ("iron", "mg"),
        ("magnesium", "mg"), ("manganese", "mg"), ("molybdenum", "µg"), ("nickel", "mg"),
        ("phosphorus", "g"), ("selenium", "µg"), ("silicon", None), ("vanadium", "mg"),
        ("zinc", "mg"), ("sodium", "g"), ("chloride", "g")),
}

# Which table a title line starts. Matched against the PDF's own headings.
_TITLES = (
    ("Recommended Dietary Allowances and Adequate Intakes, Vitamins", ("rda", "vitamins")),
    ("Recommended Dietary Allowances and Adequate Intakes, Elements", ("rda", "elements")),
    ("Tolerable Upper Intake Levels, Vitamins", ("ul", "vitamins")),
    ("Tolerable Upper Intake Levels, Elements", ("ul", "elements")),
)

# The ULs that don't count food — from the tables' own footnotes.
UL_SCOPE = {
    "vitamin_a": "preformed vitamin A (retinol) only — not the beta-carotene in plants",
    "vitamin_e": "supplements and fortified foods only (any α-tocopherol form)",
    "niacin": "supplements and fortified foods only",
    "folate": "supplements and fortified foods only (folic acid)",
    "magnesium": "supplements and medicines only — not food or water",
}

# The 2019 sodium and potassium report, which replaced the 2005 values the tables print.
UPDATES_2019 = {
    "citation": ("National Academies of Sciences, Engineering, and Medicine. 2019. Dietary "
                 "Reference Intakes for Sodium and Potassium. Washington, DC: The National "
                 "Academies Press. doi:10.17226/25353"),
    "how": "typed in from the report's summary, not read from a file in the commons",
    # (nutrient, sex, kind) -> (value, unit), for every adult band 19 and over.
    "values": {
        ("potassium", "female", "ai"): (2600, "mg"),
        ("potassium", "male", "ai"): (3400, "mg"),
        ("sodium", "female", "ai"): (1500, "mg"),
        ("sodium", "male", "ai"): (1500, "mg"),
        # Not a UL: the report dropped sodium's UL for a "Chronic Disease Risk
        # Reduction" intake — cutting back above it lowers risk.
        ("sodium", "female", "cdrr"): (2300, "mg"),
        ("sodium", "male", "cdrr"): (2300, "mg"),
    },
}

ADULT_BANDS = ("19-30", "31-50", "51-70", "71+")

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS dri_values ("
    "  nutrient TEXT NOT NULL,"
    "  sex TEXT NOT NULL,"          # 'female' | 'male'
    "  age_band TEXT NOT NULL,"     # '9-13', '14-18', '19-30', '31-50', '51-70', '71+'
    "  kind TEXT NOT NULL,"         # 'rda' | 'ai' | 'ul' | 'cdrr'
    "  value REAL NOT NULL,"
    "  unit TEXT NOT NULL,"
    "  as_printed TEXT NOT NULL,"   # the cell exactly as the table printed it
    "  source TEXT NOT NULL,"       # the commons file, or the 2019 report's citation
    "  file_sha256 TEXT,"
    "  PRIMARY KEY (nutrient, sex, age_band, kind)"
    ")",
)

# A row's life-stage label ("19–30 y", "> 70 y"), with any of the PDF's dashes.
_BAND = re.compile(r"^\s*(\d+)\s*[–−-]\s*(\d+)\s*y\b|^\s*>\s*70\s*y\b")
# One cell: a number (maybe with thousands commas), an AI star, footnote letters; or ND.
_CELL = re.compile(r"^(?:(\d[\d,]*(?:\.\d+)?)(\*?)[a-z]*|ND[a-z]*)$")


def ensure_schema(conn):
    """Add the dri_values table to a commons.db connection if it isn't there yet."""
    for statement in _SCHEMA:
        conn.execute(statement)


def pdf_text(path):
    """The PDF as text with its columns kept in place (poppler's pdftotext -layout)."""
    return subprocess.run(["pdftotext", "-layout", str(path), "-"], check=True,
                          capture_output=True, text=True, timeout=60).stdout


def parse_tables(text):
    """Every male and female row of the four tables, as dicts.

    Walks the text a line at a time: a title line says which table this is,
    a "Males"/"Females" line says whose rows follow (any other group heading
    — infants, children, pregnancy, lactation — stops the reading until the
    next Males/Females), and each life-stage row is split on whitespace into
    cells in the table's column order. A row whose cell count doesn't match
    the table's columns is refused loudly, not guessed at.
    """
    table = sex = None
    rows = []
    for line in text.splitlines():
        # Take a title line as the start of a new table.
        for title, key in _TITLES:
            if title in line:
                table, sex = key, None
        stripped = line.strip()

        # Take a group heading as whose rows follow.
        if stripped in ("Males", "Females"):
            sex = stripped[:-1].lower()
            continue
        if stripped in ("Infants", "Children", "Pregnancy", "Lactation"):
            sex = None
            continue

        # Read a life-stage row into one value per column.
        match = _BAND.match(line)
        if not (table and sex and match):
            continue
        band = f"{match.group(1)}-{match.group(2)}" if match.group(1) else "71+"
        cells = line[match.end():].split()
        columns = COLUMNS[table]
        if len(cells) != len(columns):
            raise ValueError(f"{table} {sex} {band}: {len(cells)} cells, expected {len(columns)}: {line!r}")
        for (nutrient, unit), cell in zip(columns, cells):
            parsed = _CELL.match(cell)
            if not parsed:
                raise ValueError(f"{table} {sex} {band} {nutrient}: can't read {cell!r}")
            if unit is None or parsed.group(1) is None:
                continue
            kind = "ul" if table[0] == "ul" else ("ai" if parsed.group(2) else "rda")
            rows.append({"nutrient": nutrient, "sex": sex, "age_band": band, "kind": kind,
                         "value": float(parsed.group(1).replace(",", "")), "unit": unit,
                         "as_printed": cell})
    return rows


def load_dri(conn, pdf_path):
    """Read the DRI tables PDF into dri_values, then lay the 2019 update on top.

    Replaces every earlier row, so running it twice gives the same table.
    Returns {"rows", "updated"}.
    """
    ensure_schema(conn)
    rows = parse_tables(pdf_text(pdf_path))
    if not rows:
        raise ValueError(f"{pdf_path}: no DRI rows found")
    sha = commons.sha256_of(pdf_path)
    conn.execute("DELETE FROM dri_values")
    conn.executemany(
        "INSERT OR REPLACE INTO dri_values (nutrient, sex, age_band, kind, value, unit,"
        " as_printed, source, file_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(r["nutrient"], r["sex"], r["age_band"], r["kind"], r["value"], r["unit"],
          r["as_printed"], TABLE_FILE, sha) for r in rows])

    # Lay the 2019 sodium/potassium values over the adult rows they replace.
    # All the old adult rows go first — RDA/AI, and sodium's UL, which the report dropped.
    for nutrient, sex in {(n, s) for n, s, _ in UPDATES_2019["values"]}:
        conn.execute(f"DELETE FROM dri_values WHERE nutrient = ? AND sex = ?"
                     f" AND age_band IN ({','.join('?' * len(ADULT_BANDS))})",
                     (nutrient, sex, *ADULT_BANDS))
    updated = 0
    for (nutrient, sex, kind), (value, unit) in UPDATES_2019["values"].items():
        for band in ADULT_BANDS:
            conn.execute(
                "INSERT OR REPLACE INTO dri_values (nutrient, sex, age_band, kind, value, unit,"
                " as_printed, source, file_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
                (nutrient, sex, band, kind, value, unit, f"{value:g} {unit}", UPDATES_2019["citation"]))
            updated += 1
    return {"rows": len(rows), "updated": updated}


def age_band(age):
    """The DRI life-stage band an adult's age falls in."""
    if age < 19:
        raise ValueError("only adult targets are loaded")
    if age <= 30:
        return "19-30"
    if age <= 50:
        return "31-50"
    if age <= 70:
        return "51-70"
    return "71+"


def targets(conn, sex, age):
    """Every target for one sex and age: {nutrient: {kind: {value, unit, source, as_printed}}}."""
    ensure_schema(conn)
    out = {}
    for nutrient, kind, value, unit, source, printed in conn.execute(
            "SELECT nutrient, kind, value, unit, source, as_printed FROM dri_values"
            " WHERE sex = ? AND age_band = ?", (sex, age_band(age))):
        out.setdefault(nutrient, {})[kind] = {"value": value, "unit": unit, "source": source,
                                              "as_printed": printed}
    return out
