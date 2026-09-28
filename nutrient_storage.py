"""Which nutrients the body keeps a store of, and which it needs steadily — in the NIH's own words.

**What this does.** For each nutrient the Nutrients page tracks, it gives one
of four answers, each backed by sentences quoted word for word from that
nutrient's NIH Office of Dietary Supplements (ODS) Health Professional Fact
Sheet, the same sheets nutrient_facts.py reads from the commons:

- `stores`   — the sheet says the body keeps a real store and draws on it
               (calcium in bone, iron as ferritin, vitamin A in the liver, …).
- `steady`   — the sheet says the store is small, or the vitamin is used up
               fast (thiamin, riboflavin, copper, vitamin K, vitamin C).
- `unclear`  — the sheet says where the nutrient sits in the body, or says
               nothing on it, but not whether that tides you over low days.
- `unsourced`— no ODS sheet at all (energy, macronutrients, fiber, sodium).

The kind and the one-line summary are this file's reading of the quotes; the
quotes are the evidence and ship beside them. `lasts` is filled only where the
sheet itself names a time. At read time every quote is checked against the
sheet's text, and any that no longer appears is dropped and reported under
`unverified` instead of being shown — so a changed sheet can't leave a
sentence here that ODS no longer says.

Each answer also carries the sheet's own definition of the RDA ("Average daily
level of intake …"): the targets are averages over time, not a line to clear
every day.

Touches: nutrient_facts.py (SHEETS, the sheet parser), commons.py,
routes/nutrition.py (GET /api/nutrition/nutrient/<key>, /api/nutrition/day),
tests/test_nutrient_storage.py. Design: docs/nutrition.md.

Prompt that produced this file: "Also wanting to know which nutrients I need
to get daily vs. which can build up in my system" — each answer sourced from
the fact sheets, not written from general knowledge.
"""
import re

import commons
import nutrient_facts

# How each kind reads as a marker on the Nutrients list.
LABELS = {
    "stores": "Body stores it",
    "steady": "Needed steadily",
    "unclear": "Store not stated",
    "unsourced": "No sourced answer",
}

# Each tracked nutrient's kind, a plain summary, how long a store lasts where
# the sheet names a time, and the sheet's sentences that back it, verbatim.
STORAGE = {
    # --- a real store ---
    "calcium": ("stores", "Almost all of it sits in your bones, which the body uses as a reservoir.", None, [
        "Almost all calcium in the body (98%) is stored in the bones, and the body uses the bones as a reservoir for, and source of, calcium to maintain calcium homeostasis.",
    ]),
    "iron": ("stores", "Held in reserve as ferritin in the liver, spleen and bone marrow; a shortfall empties that reserve before anemia starts.", None, [
        "Much of the remaining iron is stored in the form of ferritin or hemosiderin (a degradation product of ferritin) in the liver, spleen, and bone marrow, or it is located in the myoglobin of muscle tissue.",
        "Iron deficiency progresses from the depletion of iron stores (mild iron deficiency), to iron-deficiency erythropoiesis (erythrocyte production), and finally to iron deficiency anemia (IDA).",
    ]),
    "vitamin_a": ("stores", "Stored in the liver; blood levels don't fall until that store is almost gone. Excess builds up too.", None, [
        "Most of the body’s vitamin A is stored in the liver in the form of retinyl esters.",
        "However, these levels are not always reliable indicators of vitamin A status because they do not decline until vitamin A levels in the liver and other storage sites are almost depleted and because acute and chronic infections can decrease serum and plasma retinol concentrations.",
        "Because vitamin A is fat soluble, the body stores excess amounts, primarily in the liver, and these levels can accumulate.",
    ]),
    "vitamin_d": ("stores", "Kept in body fat; the form in your blood has a half-life of about 15 days.", "Blood form: half-life 15 days", [
        "In serum, 25(OH)D has a fairly long circulating half-life of 15 days.",
        "In this procedure, part of the upper small intestine, where vitamin D is absorbed, is bypassed, and vitamin D that is mobilized into the bloodstream from fat stores might not raise 25(OH)D to adequate levels over time.",
    ]),
    "folate": ("stores", "The body holds 15–30 mg, about half of it in the liver. The sheet gives the size, not how long it lasts.", None, [
        "The total body content of folate is estimated to be 15 to 30 mg; about half of this amount is stored in the liver and the remainder in blood and body tissues.",
    ]),
    "vitamin_b12": ("stores", "The body holds 1,000–2,000 days' worth, so a shortfall can take years to show.", "Several years", [
        "Because the body stores about 1 to 5 milligrams (mg) vitamin B12 (or about 1,000 to 2,000 times as much as the amount typically consumed in a day), the symptoms of vitamin B12 deficiency can take several years to appear.",
    ]),
    # --- a small store, used fast ---
    "thiamin": ("steady", "Only a very small store and a short half-life, so you need a continuous supply.", "Short half-life", [
        "Humans store thiamin primarily in the liver but in very small amounts.",
        "The vitamin has a short half-life, so people require a continuous supply of it from the diet.",
    ]),
    "riboflavin": ("steady", "Only small amounts are stored; the excess leaves in urine.", None, [
        "The body absorbs little riboflavin from single doses beyond 27 mg and stores only small amounts of riboflavin in the liver, heart, and kidneys.",
        "When excess amounts are consumed, they are either not absorbed or the small amount that is absorbed is excreted in urine.",
    ]),
    "copper": ("steady", "Only small amounts are stored.", None, [
        "Only small amounts of copper are typically stored in the body, and the average adult has a total body content of 50–120 mg copper.",
    ]),
    "vitamin_k": ("steady", "Broken down fast, so its tissue stores are low next to the other fat-soluble vitamins.", None, [
        "This rapid metabolism accounts for vitamin K's relatively low blood levels and tissue stores compared to those of the other fat-soluble vitamins.",
    ]),
    "vitamin_c": ("steady", "A store of up to about 2 g; with little or none, signs of scurvy can appear within a month.", "About a month", [
        "The total body content of vitamin C ranges from 300 mg (at near scurvy) to about 2 g.",
        "The timeline for the development of scurvy varies, depending on vitamin C body stores, but signs can appear within 1 month of little or no vitamin C intake (below about 10 mg/day).",
    ]),
    # --- the sheet says where it sits, not whether it carries you ---
    "magnesium": ("unclear", "Half or more sits in bone, but the sheet doesn't say whether that carries you through low days.", None, [
        "An adult body contains approximately 25 grams magnesium, with 50% to 60% present in the bones and most of the rest in soft tissues.",
    ]),
    "phosphorus": ("unclear", "Most sits in bones and teeth; the sheet describes it as balanced, not as a store to draw on.", None, [
        "Of this amount, 85% is in bones and teeth, and the other 15% is distributed throughout the blood and soft tissues.",
    ]),
    "potassium": ("unclear", "The kidneys pass it out quickly after you eat it unless stores are low; the sheet doesn't say how long those stores last.", None, [
        "The kidneys control potassium excretion in response to changes in dietary intakes, and potassium excretion increases rapidly in healthy people after potassium consumption, unless body stores are depleted.",
    ]),
    "zinc": ("unclear", "The sheet says most is stored in muscle and bone, but not whether the body can draw on it, or for how long.", None, [
        "Most of this zinc is stored in skeletal muscle and bone.",
    ]),
    "manganese": ("unclear", "10–20 mg in the body, a quarter to 40% of it in bone; nothing on drawing on it.", None, [
        "The human body contains about 10 to 20 mg manganese, of which 25% to 40% is in bone.",
    ]),
    "selenium": ("unclear", "About a third to a half sits in muscle; nothing on drawing on it.", None, [
        "Approximately 28% to 46% of the body's total selenium content is found in skeletal muscle.",
    ]),
    "iodine": ("unclear", "15–20 mg in the body, mostly in the thyroid; the sheet doesn't say how long that lasts.", None, [
        "The iodine-replete healthy adult has about 15–20 mg of iodine, 70%–80% of which is contained in the thyroid.",
    ]),
    "niacin": ("unclear", "Some excess is kept in red blood cells as a reserve; the sheet says there's no test of total stores.", None, [
        "Some excess niacin is taken up by red blood cells to form a circulating reserve pool.",
        "No functional biochemical tests that reflect total body stores of niacin are available.",
    ]),
    "choline": ("unclear", "The liver makes some, but not enough to meet needs; the sheet says nothing about a store.", None, [
        "Humans can produce choline endogenously in the liver, mostly as phosphatidylcholine, but the amount that the body naturally synthesizes is not sufficient to meet human needs.",
    ]),
    "vitamin_e": ("unclear", "The sheet doesn't say whether the body keeps a store.", None, []),
    "pantothenic_acid": ("unclear", "The sheet doesn't say whether the body keeps a store.", None, []),
    "vitamin_b6": ("unclear", "The sheet doesn't say whether the body keeps a store.", None, []),
}

# The sheet's own definition of the RDA, found in its "Recommended Intakes" section.
AVERAGE_OPENING = "Recommended Dietary Allowance (RDA): Average daily level of intake"


def kind(key):
    """A nutrient's kind alone, for the list's markers — no sheet is opened."""
    return STORAGE[key][0] if key in STORAGE else "unsourced"


def _flat(text):
    """Text reduced for matching: curly quotes straightened, whitespace collapsed."""
    return re.sub(r"\s+", " ", text.replace("’", "'").replace("‘", "'")).strip()


def storage(key):
    """What the ODS sheet says about whether the body stores one nutrient.

    Returns {key, kind, label, summary, lasts, quotes: [text], unverified: [text],
    average: text | None, sheet: {name, url, publisher, file} | None}.
    Quotes the sheet no longer contains move to `unverified` and aren't shown.
    """
    facts = nutrient_facts.facts(key)
    if key not in STORAGE or not facts["sheet"]:
        return {"key": key, "kind": "unsourced", "label": LABELS["unsourced"], "summary": None,
                "lasts": None, "quotes": [], "unverified": [], "average": None, "sheet": None}
    what, summary, lasts, quotes = STORAGE[key]
    answer = {"key": key, "kind": what, "label": LABELS[what], "summary": summary, "lasts": lasts,
              "quotes": [], "unverified": [], "average": None, "sheet": facts["sheet"]}
    if facts["sheet"].get("missing"):
        answer["unverified"] = list(quotes)
        return answer

    # Check every quote against the sheet's whole text, so nothing shown has gone stale.
    sheet, _word = nutrient_facts.SHEETS[key]
    path = commons.commons_dir() / nutrient_facts.SOURCE_DIR / f"{sheet}-HealthProfessional.html"
    sections = nutrient_facts._sections(str(path), path.stat().st_mtime)
    blocks = [block["text"] for section in sections.values() for block in section]
    whole = _flat(" ".join(blocks))
    for quote in quotes:
        answer["quotes" if _flat(quote) in whole else "unverified"].append(quote)
    answer["average"] = next((text for text in blocks if text.startswith(AVERAGE_OPENING)), None)
    return answer
