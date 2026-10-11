"""Which foods a low-histamine diet allows — by one named list, the SIGHI list.

**What this does.** Reads the Swiss Interest Group Histamine Intolerance
(SIGHI) "Food Compatibility List" and says, for a USDA food, what that list
rates it: 0 well tolerated, 1 moderately compatible, 2 incompatible, 3 very
poorly tolerated, or "?" / "-" where SIGHI says the evidence is thin or no
general statement is possible. The Nutrients page uses it to mark each
ranked food and to filter a ranking down to the 0s.

**Why this list.** Low-histamine lists disagree with each other, so the app
follows exactly one and names it everywhere. SIGHI's is the most detailed
free one (hundreds of foods, each with a reason code — histamine content,
other amines, liberators, DAO blockers), it is kept up to date (this parser
was written against the 2023-04-01 edition), and it rates *compatibility for
histamine-sensitive people*, not measured histamine content, which is what
choosing a diet needs. SIGHI's own caution travels with it on the page:
tolerance is individual and freshness matters.

**Where the list lives.** SIGHI's copyright asks that copies not be re-hosted
— link to their server instead. So the PDF is not in the commons (which is
meant to be public) or this repo: `fetch()` downloads it from SIGHI into the
install's own data dir (`<data>/histamine/`), and it is read from there.
Without it, every food comes back unrated.

**Matching a USDA food to a list entry is by name, and approximate.** A USDA
description like "Cheese, cheddar" is tried as "cheddar cheese", then "cheese
cheddar", then "cheese", against every name and synonym SIGHI gives (its
entries list synonyms after commas). Where one name carries more than one
rating (e.g. "milk" — pasteurised 0, lactose-free 1), the worst is kept. Every
result names the SIGHI entry it matched, so a wrong match can be seen. Foods
whose USDA name says canned, smoked, cured, pickled or fermented are marked
"avoid" from SIGHI's leaflet ("To avoid: fermented or microbially ripened
products … canned, finished or semi-finished products"), whatever the base
food's rating; organ meats (liver, kidney, "variety meats") are rated as SIGHI's
"innards", not as the animal's fresh meat.

Touches: `store.py` (the data dir), `nutrition.py` (ranking's filter),
`routes/nutrition.py`, `tests/test_histamine.py`. Design: docs/nutrition.md.

Prompt that produced this file: "I'm also wanting to add a low histamine list
in here somewhere so I can filter by low histamine if I want" — use a real
source and say which list is followed, since they disagree.
"""
import functools
import re
import subprocess
import urllib.request

import store

LIST_URL = "https://www.mastzellaktivierung.info/downloads/foodlist/21_FoodList_EN_alphabetic_withCateg.pdf"
LEAFLET_URL = "https://www.histaminintoleranz.ch/downloads/SIGHI-Leaflet_HistamineEliminationDiet.pdf"
LIST_FILE = "SIGHI-FoodList-EN.pdf"
SOURCE = {
    "name": "SIGHI Food Compatibility List",
    "publisher": "Swiss Interest Group Histamine Intolerance (SIGHI)",
    "edition": "2023-04-01",
    "url": LIST_URL,
    "leaflet_url": LEAFLET_URL,
}

# The leaflet's "to avoid" processing, as words in a USDA food name — including
# foods that are fermented by definition, whose USDA name doesn't say so.
PROCESSED = ("canned", "smoked", "cured", "pickled", "fermented",
             "kimchi", "sauerkraut", "miso", "tempeh", "natto")

# Organ meats, which SIGHI rates under "innards" / "entrails" (2), not under the
# animal's fresh meat: USDA names them "Beef, variety meats and by-products, liver".
ORGANS = ("liver", "kidney", "spleen", "heart", "tripe", "brain", "giblet", "lung",
          "sweetbread", "variety")

# A rating as the word the page shows.
VERDICTS = {"0": "low", "1": "moderate", "2": "high", "3": "high", "?": "unclear", "-": "unclear"}

# The flag letters SIGHI prints between a rating and the food's name.
_FLAGS = {"H!", "H", "A", "L", "B", "?"}
_ROW = re.compile(r"^ {4,12}([0-3?\-])(?= )(.*)$")
_CATEGORY = re.compile(r"^ {1,3}([A-Z][A-Za-z ,]+?)\s*$")


def folder():
    """Where this install keeps SIGHI's files (private: its copyright asks not to re-host)."""
    return store.DATA_DIR / "histamine"


def fetch(url=LIST_URL, name=LIST_FILE):
    """Download SIGHI's list into the data dir, from SIGHI's own server."""
    folder().mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (exocortex)"})
    with urllib.request.urlopen(request, timeout=60) as response:
        (folder() / name).write_bytes(response.read())
    return folder() / name


def parse(text):
    """SIGHI's list (pdftotext -layout text) as [{name, rating, flags, remark, category}].

    A row starts with its rating in the left column, then reason flags, then
    the name, then (after a wide gap) a remark. A line with no rating that
    starts in the name column continues the name above it.
    """
    entries, category = [], None
    for line in text.splitlines():
        row = _ROW.match(line)
        if row:
            rating, rest = row.groups()
            tokens = rest.split()
            flags = []
            while tokens and tokens[0] in _FLAGS:
                flags.append(tokens.pop(0))
            body = rest.strip()
            for flag in flags:
                body = body[len(flag):].lstrip()
            parts = re.split(r" {3,}", body, maxsplit=1)
            name, remark = parts[0].strip(), (parts[1] if len(parts) > 1 else "")
            if name:
                entries.append({"name": name, "rating": rating, "flags": flags,
                                "remark": remark.strip(), "category": category})
            continue
        heading = _CATEGORY.match(line)
        if heading and "SIGHI" not in line:
            category = heading.group(1)
            continue
        # A name or remark that runs onto the next line: the name column is
        # indented under 30 characters, the remark column past 60.
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if not entries or not stripped or stripped.startswith("©"):
            continue
        if 14 <= indent <= 30:
            parts = re.split(r" {3,}", stripped, maxsplit=1)
            entries[-1]["name"] += " " + parts[0]
            if len(parts) > 1:
                entries[-1]["remark"] = (entries[-1]["remark"] + " " + parts[1]).strip()
        elif indent >= 60 and entries[-1]["remark"]:
            entries[-1]["remark"] += " " + stripped
    return entries


def _singular(word):
    """A word's crude singular: berries → berry, tomatoes → tomato, eggs → egg."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith(("oes", "ches", "shes")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def normal(phrase):
    """A name made comparable: lowercase, no brackets or punctuation, each word singular."""
    phrase = re.sub(r"\([^)]*\)", " ", phrase.lower())
    words = re.findall(r"[a-z]+", phrase)
    return " ".join(_singular(word) for word in words)


def index(entries):
    """Every SIGHI name and synonym → the entries that carry it.

    An entry like "eggs, chicken egg, whole egg" or "trout (freshwater): brown
    trout, rainbow trout" is split at commas and colons into names.
    """
    names = {}
    for entry in entries:
        for piece in re.split(r"[,:;/]", entry["name"]):
            key = normal(piece)
            if key:
                names.setdefault(key, []).append(entry)
    return names


def _worst(entries):
    """Of several entries under one name, the one with the worst numeric rating."""
    numeric = [entry for entry in entries if entry["rating"].isdigit()]
    return max(numeric, key=lambda entry: entry["rating"]) if numeric else entries[0]


def rate(names, description):
    """What SIGHI says about one USDA food, or None when no entry matches its name.

    Returns {verdict: low|moderate|high|unclear|avoid, rating, sighi_name, remark}.
    """
    words = set(re.findall(r"[a-z]+", description.lower()))
    for word in PROCESSED:
        if word in words:
            return {"verdict": "avoid", "rating": None, "remark": "",
                    "sighi_name": f"{word} food — SIGHI leaflet: to avoid"}
    organ = names.get("innard") if words & {w for o in ORGANS for w in (o, o + "s")} else None
    if organ:
        entry = _worst(organ)
        return {"verdict": VERDICTS[entry["rating"]], "rating": entry["rating"],
                "sighi_name": entry["name"], "remark": entry["remark"]}
    segments = [normal(segment) for segment in description.split(",")]
    segments = [segment for segment in segments if segment]
    if not segments:
        return None
    tries = []
    if len(segments) > 1:
        tries += [f"{segments[1]} {segments[0]}", f"{segments[0]} {segments[1]}"]
    tries.append(segments[0])
    for phrase in tries:
        if phrase in names:
            entry = _worst(names[phrase])
            return {"verdict": VERDICTS[entry["rating"]], "rating": entry["rating"],
                    "sighi_name": entry["name"], "remark": entry["remark"]}
    return None


def _pdf_text(path):
    """The PDF as text with its columns kept in place (poppler's pdftotext -layout)."""
    return subprocess.run(["pdftotext", "-layout", str(path), "-"], check=True,
                          capture_output=True, text=True, timeout=60).stdout


@functools.lru_cache(maxsize=2)
def _names(path, mtime):
    """The list's name index, built once per file version (mtime is the cache key)."""
    return index(parse(_pdf_text(path)))


def names():
    """The name index for this install's copy of the list; {} when it hasn't been fetched."""
    path = folder() / LIST_FILE
    if not path.exists():
        return {}
    return _names(str(path), path.stat().st_mtime)


if __name__ == "__main__":
    # Fetch SIGHI's list into this install's data dir: python3 histamine.py
    print(fetch())
