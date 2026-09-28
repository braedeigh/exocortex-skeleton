"""What each nutrient does, and what happens without enough of it — in the NIH's own words.

**What this does.** For each nutrient the Nutrients page tracks, it opens the
NIH Office of Dietary Supplements (ODS) Health Professional Fact Sheet kept in
the commons (`<commons>/nih-ods/<Sheet>-HealthProfessional.html`, brought in
by scripts/commons_fetch.py) and pulls three sections out of it, word for
word: the Introduction (what the nutrient is for), "<Nutrient> Deficiency"
(what happens if you don't get enough), and "Groups at Risk of <Nutrient>
Inadequacy". Nothing here is paraphrased — the page shows ODS's sentences
with ODS's citation numbers stripped, and links the sheet.

Why ODS: it is the US government's reference summary for each vitamin and
mineral, reviewed and cited, and public domain. Energy, protein, fat,
carbohydrate, fiber and sodium have no ODS fact sheet, so they come back with
`sheet: None` rather than a made-up paragraph.

The sheets came in through the Internet Archive (ods.od.nih.gov turns this
machine away behind Cloudflare); each commons manifest entry names the
snapshot, and the address given here is ODS's own.

Touches: `commons.py` (where the files are), `routes/nutrition.py`
(GET /api/nutrition/nutrient/<key>), `tests/test_nutrient_facts.py`.
Design: docs/nutrition.md.

Prompt that produced this file: "I want information about what happens if you
don't get enough of that nutrient" — with real sources, cited, not guessed.
"""
import functools
import html
import re
from html.parser import HTMLParser

import commons

SOURCE_DIR = "nih-ods"

# Each tracked nutrient's ODS sheet name, and the word ODS uses for it in headings.
SHEETS = {
    "calcium": ("Calcium", "Calcium"),
    "iron": ("Iron", "Iron"),
    "magnesium": ("Magnesium", "Magnesium"),
    "phosphorus": ("Phosphorus", "Phosphorus"),
    "potassium": ("Potassium", "Potassium"),
    "zinc": ("Zinc", "Zinc"),
    "copper": ("Copper", "Copper"),
    "manganese": ("Manganese", "Manganese"),
    "selenium": ("Selenium", "Selenium"),
    "iodine": ("Iodine", "Iodine"),
    "vitamin_a": ("VitaminA", "Vitamin A"),
    "vitamin_c": ("VitaminC", "Vitamin C"),
    "vitamin_d": ("VitaminD", "Vitamin D"),
    "vitamin_e": ("VitaminE", "Vitamin E"),
    "vitamin_k": ("VitaminK", "Vitamin K"),
    "thiamin": ("Thiamin", "Thiamin"),
    "riboflavin": ("Riboflavin", "Riboflavin"),
    "niacin": ("Niacin", "Niacin"),
    "pantothenic_acid": ("PantothenicAcid", "Pantothenic Acid"),
    "vitamin_b6": ("VitaminB6", "Vitamin B6"),
    "folate": ("Folate", "Folate"),
    "vitamin_b12": ("VitaminB12", "Vitamin B12"),
    "choline": ("Choline", "Choline"),
}


def sheet_url(sheet):
    """ODS's own address for a Health Professional Fact Sheet."""
    return f"https://ods.od.nih.gov/factsheets/{sheet}-HealthProfessional/"


class _Sections(HTMLParser):
    """Walk a fact sheet and collect its text blocks under each <h2>.

    Each section is a list of blocks {kind: 'p'|'h3'|'li', text}. Citation
    links ([1], [2,3-5]) are dropped as they're read, so the text reads clean.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sections = {}
        self.current = None      # the <h2> heading we're under
        self.block = None        # the tag whose text is being gathered
        self.heading = None      # gathering an <h2>'s own text
        self.text = []
        self.in_citation = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and "fscopy_nounderline" in (attrs.get("class") or ""):
            self.in_citation += 1
        elif tag == "h2":
            self.heading, self.text = True, []
        elif tag in ("p", "h3", "li") and self.current and self.block is None:
            self.block, self.text = tag, []

    def handle_endtag(self, tag):
        if tag == "a" and self.in_citation:
            self.in_citation -= 1
        elif tag == "h2" and self.heading:
            self.current = _clean("".join(self.text))
            self.sections.setdefault(self.current, [])
            self.heading = None
        elif tag == self.block:
            text = _clean("".join(self.text))
            if text:
                self.sections[self.current].append({"kind": tag, "text": text})
            self.block = None

    def handle_data(self, data):
        if not self.in_citation and (self.heading or self.block):
            self.text.append(data)


def _clean(text):
    """Collapse whitespace, and drop the empty brackets a removed citation leaves."""
    text = re.sub(r"\s*\[[\s,\-–]*\]", "", html.unescape(text))
    return re.sub(r"\s+", " ", text).strip()


@functools.lru_cache(maxsize=64)
def _sections(path, mtime):
    """A sheet's sections, parsed once per file version (mtime is the cache key)."""
    parser = _Sections()
    with open(path, encoding="utf-8", errors="replace") as handle:
        parser.feed(handle.read())
    return parser.sections


def facts(key):
    """What the ODS sheet says about one tracked nutrient.

    Returns {key, sheet: {name, url, file} | None, intro: [blocks],
    deficiency: [blocks], at_risk: [blocks]} — blocks as _Sections gives them.
    `sheet` is None where ODS has no sheet for the nutrient; `missing` names
    the commons file when the sheet exists but hasn't been fetched here.
    """
    empty = {"key": key, "sheet": None, "intro": [], "deficiency": [], "at_risk": []}
    if key not in SHEETS:
        return empty
    sheet, word = SHEETS[key]
    relative = f"{SOURCE_DIR}/{sheet}-HealthProfessional.html"
    path = commons.commons_dir() / relative
    info = {"name": f"{word} — Health Professional Fact Sheet", "url": sheet_url(sheet),
            "publisher": "NIH Office of Dietary Supplements", "file": relative}
    if not path.exists():
        return dict(empty, sheet=dict(info, missing=True))
    sections = _sections(str(path), path.stat().st_mtime)

    # Pick the three sections by their headings, which every sheet words the same way.
    def section(heading):
        wanted = heading.lower()
        return next((blocks for name, blocks in sections.items() if name and name.lower() == wanted), [])
    return dict(empty, sheet=info,
                intro=[block for block in section("Introduction") if block["kind"] == "p"][:2],
                deficiency=section(f"{word} Deficiency"),
                at_risk=section(f"Groups at Risk of {word} Inadequacy"))
