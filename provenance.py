"""Where a food comes from: the rules for the machine's guesses, and how they are checked.

**What this is.** The research pass (`scripts/propose_sources.py`) asks a model,
with web search, where each food or product comes from. The checker
(`scripts/check_proposals.py`) then tests every answer before it is shown. This
file holds the parts both of them share, none of which touch the database:

  cleaning   — turn a model's answer into a proposal the tables accept, or say
               plainly why it can't be one. A machine may say a place is a USDA
               estimate ('proxy') or a guess; it may never say 'placed' — only
               a visit does that.
  ranking    — for a product made of several ingredients, which one is least
               traceable and which one is worst for health. Worked out here, in
               code, so the model can't bend it.
  USDA       — the counties that grow a commodity, from the USDA NASS Census
               of Agriculture, through the helpers `routes/ecosystem.py` already
               uses for the map's USDA button.
  checking   — does a cited page really contain the quoted passage; do the USDA
               numbers still match; does the proposal keep the rules.

Touches: `routes/ecosystem.py` (USDA fetch helpers, state centres),
`sourcestore.py` (the vocabularies a source uses), `scripts/propose_sources.py`
and `scripts/check_proposals.py` (the two callers).

Prompt that produced this file: "propose where each food and product comes from,
with evidence and origin … USDA placements stay proxy, never placed" — then "I
want some checker built into the system", and for products: "list every
ingredient, rank each, summary = the worst one and which ingredient"; worst
meaning "least traceable and worst for your health for now".
"""
import html
import re

import sourcestore

# --- the vocabularies ---------------------------------------------------------
# A machine's answer may use only these words; each one also has a CHECK in the
# proposal tables, so nothing outside them can land.

MACHINE_GEO_SOURCES = ("proxy", "guess")
TRANSPARENCY = ("disclosed", "partial", "opaque")
HEALTH_CONCERNS = ("high", "some", "low", "unknown")
MACHINE_ORIGINS = ("usda-nass", "package", "research", "unknown")
EVIDENCE_ROLES = ("usda", "web", "model")

# How bad each word is, worst first — used to pick a product's worst part.
_TRACE_BADNESS = {"opaque": 3, "partial": 2, "disclosed": 1}
_GEO_BADNESS = {"guess": 2, "unrated": 2, "proxy": 1}
_HEALTH_BADNESS = {"high": 4, "some": 3, "unknown": 2, "low": 1}

# What an organic estimate's verdict says about a food's health concern.
HEALTH_FROM_ESTIMATE = {"organic": "high", "some": "some", "conventional": "low", "open": "unknown"}


# --- cleaning a model's answer ------------------------------------------------
# Each helper takes whatever the model wrote and returns a value the tables
# accept, adding a plain-English problem to `problems` when it can't.

def _text(value, limit=500):
    return str(value or "").strip()[:limit]


def _number(value, low, high):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if low <= number <= high else None


def _url(value):
    url = _text(value, 1000)
    return url if re.match(r"^https?://[^\s]+$", url) else ""


def _evidence(items, problems):
    """The cited pages: each needs a real URL, a quote and the claim it backs."""
    out = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        url, quote, claim = _url(item.get("url")), _text(item.get("quote"), 600), _text(item.get("claim"), 400)
        if not (url and quote and claim):
            problems.append(f"evidence dropped (needs url, quote and claim): {_text(item.get('url'), 120)!r}")
            continue
        out.append({"url": url, "quote": quote, "claim": claim, "title": _text(item.get("title"), 200)})
    return out


def _parts(items, problems):
    """A product's ingredients, each with where it's from and how worrying it is."""
    out = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not _text(item.get("ingredient")):
            continue
        transparency = item.get("transparency")
        geo_source = item.get("geo_source")
        health = item.get("health_concern")
        out.append({
            "seq": len(out),
            "ingredient": _text(item.get("ingredient"), 120),
            "place": _text(item.get("place"), 200),
            "transparency": transparency if transparency in TRANSPARENCY else "opaque",
            "geo_source": geo_source if geo_source in MACHINE_GEO_SOURCES else "unrated",
            "health_concern": health if health in HEALTH_CONCERNS else "unknown",
            "health_basis": "model",
            "note": _text(item.get("note"), 400),
        })
    return out


# Ingredients that don't need a place of their own. Water is everywhere, so a
# label that adds only water to one ingredient still counts as one ingredient.
_PLACELESS_INGREDIENTS = ("water", "filtered water")


def label_ingredients(answer):
    """The ingredient list the answer copied off the label, water left out."""
    items = answer.get("ingredients") if isinstance(answer, dict) else None
    names = [_text(item, 120) for item in items] if isinstance(items, list) else []
    return [name for name in names if name and name.lower() not in _PLACELESS_INGREDIENTS]


def clean_answer(answer):
    """Turn one model answer into (proposal, problems).

    `proposal` is None when the answer can't be a proposal at all (no place, a
    machine claiming 'placed'); otherwise it's a dict ready for proposalstore,
    and `problems` lists anything that was dropped or defaulted on the way."""
    problems = []
    if not isinstance(answer, dict):
        return None, ["the answer was not an object"]
    place = answer.get("place") if isinstance(answer.get("place"), dict) else {}

    # Refuse a machine claiming a visit-grade placement, rather than quietly downgrading it.
    geo_source = answer.get("geo_source")
    if geo_source == "placed":
        return None, ["a machine may not mark a place 'placed' — only a visit does that"]
    if geo_source not in MACHINE_GEO_SOURCES:
        problems.append(f"geo_source {geo_source!r} isn't proxy or guess; using guess")
        geo_source = "guess"

    lat, lng = _number(place.get("lat"), -90, 90), _number(place.get("lng"), -180, 180)
    if lat is None or lng is None:
        return None, ["no usable latitude/longitude"]

    transparency = answer.get("transparency")
    if transparency not in TRANSPARENCY:
        problems.append(f"transparency {transparency!r} unknown; using opaque")
        transparency = "opaque"
    origin = answer.get("origin")
    if origin not in MACHINE_ORIGINS:
        origin = "unknown"
    country = _text(place.get("country"), 2).upper()
    if not re.match(r"^[A-Z]{2}$", country):
        problems.append("no two-letter country code")
        country = ""

    radius = _number(place.get("radius_km"), 0, 3000)
    parts = _parts(answer.get("parts"), problems)

    # Refuse a several-ingredient product that isn't broken into parts. The
    # model states the label's list, so whether a product needs parts is its
    # own words, not its whim; the caller asks again once.
    ingredients = label_ingredients(answer)
    if len(ingredients) >= 2 and not parts:
        return None, [f"the label lists {len(ingredients)} ingredients but no parts were given"]
    if len(ingredients) >= 2 and len(parts) < len(ingredients):
        problems.append(f"{len(parts)} parts for {len(ingredients)} listed ingredients")
    proposal = {
        "name": _text(answer.get("name") or answer.get("food"), 200),
        "summary": _text(answer.get("summary"), 800),
        "note": _text(answer.get("note"), 800),
        "lat": lat, "lng": lng,
        "precision": "point" if place.get("precision") == "point" else "area",
        "radius_km": radius if radius is not None else 50.0,
        "area_kind": "circle",
        "region_name": _text(place.get("region_name"), 200),
        "country": country,
        "transparency": transparency,
        "geo_source": geo_source,
        "origin": origin,
        "origin_detail": _text(answer.get("origin_detail"), 400),
        "origin_url": _url(answer.get("origin_url")),
        "usda_commodity": _text(answer.get("usda_commodity"), 80).upper() or None,
        "evidence": _evidence(answer.get("evidence"), problems),
        "parts": parts,
    }
    if proposal["precision"] == "point":
        proposal["radius_km"] = 0.0
    proposal.update(worst_parts(parts))
    return proposal, problems


# --- ranking a product's ingredients -----------------------------------------
# The worst part on each axis is chosen here, deterministically; ties go to the
# earlier ingredient (labels list the largest share first).

def worst_parts(parts):
    """{'worst_trace_seq', 'worst_health_seq'} for a list of parts, or Nones."""
    if not parts:
        return {"worst_trace_seq": None, "worst_health_seq": None}
    trace = max(parts, key=lambda p: (_TRACE_BADNESS.get(p["transparency"], 3),
                                      _GEO_BADNESS.get(p["geo_source"], 2), -p["seq"]))
    health = max(parts, key=lambda p: (_HEALTH_BADNESS.get(p["health_concern"], 2), -p["seq"]))
    return {"worst_trace_seq": trace["seq"], "worst_health_seq": health["seq"]}


# --- USDA: the counties that grow a commodity --------------------------------
# A USDA placement is always a proxy: it says where this crop is generally
# grown in the US, never where her package came from.

def usda_placement(commodity, key, fetch=None):
    """Top counties for a NASS commodity as {counties, year, statistic, lat, lng,
    region_name, origin_detail}, or None when USDA has nothing usable.
    `fetch` is the seam for tests; the real one calls QuickStats."""
    from routes import ecosystem  # the map's USDA helpers; imported late so tests can stub
    fetch = fetch or ecosystem._usda_fetch
    rows = fetch(commodity, key, level="COUNTY")
    top = ecosystem._usda_top_counties(rows)
    if not top or not top["counties"]:
        return None
    lead_state = top["counties"][0]["state"].upper()
    lat, lng = ecosystem.STATE_CENTROIDS.get(lead_state, (39.8, -98.6))
    states = sorted({c["state"] for c in top["counties"]})
    return {
        "counties": top["counties"],
        "year": top["year"], "statistic": top["statistic"],
        "lat": lat, "lng": lng,
        "region_name": ", ".join(states),
        "origin_detail": (f"USDA NASS Census of Agriculture {top['year']}, {commodity},"
                          f" {top['statistic']} — top {len(top['counties'])} counties"),
    }


def usda_matches(stored, fresh, tolerance=0.01):
    """Problems (a list, empty when fine) comparing saved counties to a re-fetch."""
    if not fresh:
        return ["USDA returned nothing on re-fetch"]
    fresh_by_fips = {c["fips"]: c for c in fresh["counties"]}
    problems = []
    for county in stored:
        again = fresh_by_fips.get(county["fips"])
        if again is None:
            problems.append(f"{county.get('county') or county['fips']} is no longer a top county")
        elif county.get("value") is not None and abs(again["value"] - county["value"]) > tolerance * max(abs(again["value"]), 1):
            problems.append(f"{county.get('county') or county['fips']}: saved {county['value']:g},"
                            f" USDA now says {again['value']:g}")
    return problems


# --- checking a cited page ---------------------------------------------------
# A quote counts as found when its words appear in the page in order, after
# both are lowered and stripped to letters and digits — so curly quotes, line
# breaks and markup don't fail an honest quote. A near-miss (most of its
# eight-word runs present) also counts, for pages that wrap or hyphenate.

def page_text(raw):
    """Readable text out of an HTML page: scripts, styles and tags removed."""
    raw = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(raw)).strip()


def _words(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def quote_found(quote, text, near=0.85):
    """Whether `quote` appears in `text` (see the note above)."""
    quote_words, text_words = _words(quote), _words(text)
    if not quote_words:
        return False
    if " ".join(quote_words) in " ".join(text_words):
        return True
    size = 8
    if len(quote_words) < size:
        return False
    page_runs = {tuple(text_words[i:i + size]) for i in range(len(text_words) - size + 1)}
    runs = [tuple(quote_words[i:i + size]) for i in range(len(quote_words) - size + 1)]
    return sum(run in page_runs for run in runs) / len(runs) >= near


def passage_around(quote, text, width=1500):
    """The stretch of page around where the quote's first words occur, for the
    judge to read; the page's start when they can't be found."""
    first = " ".join(quote.split()[:5]).lower()
    at = text.lower().find(first) if first else -1
    start = max(0, at - width // 2) if at >= 0 else 0
    return text[start:start + width]


# --- the rules every proposal keeps ------------------------------------------

def rule_problems(proposal, counties=(), evidence=()):
    """Plain-English reasons a proposal breaks the rules; empty when it keeps them.

    `evidence` is its evidence rows, each with 'role' and 'check_status'. A
    proposal must stand on something checkable: at least one USDA figure or
    cited page that passed — model knowledge alone isn't enough."""
    problems = []
    if proposal.get("geo_source") not in MACHINE_GEO_SOURCES:
        problems.append("a machine proposal must be proxy or guess")
    if proposal.get("transparency") not in TRANSPARENCY + ("unrated",):
        problems.append("transparency is outside the vocabulary")
    if proposal.get("origin") not in sourcestore.ORIGINS:
        problems.append("origin is outside the vocabulary")
    if proposal.get("origin") == "usda-nass":
        if not counties:
            problems.append("says USDA but holds no USDA counties")
        if proposal.get("geo_source") != "proxy":
            problems.append("a USDA placement must be a proxy")
    if proposal.get("country") == "US" and not (18 <= proposal.get("lat", 0) <= 72
                                                and -180 <= proposal.get("lng", 0) <= -65):
        problems.append("says US but the point is outside the US")
    if not any(e.get("role") in ("usda", "web") and e.get("check_status") == "passed" for e in evidence):
        problems.append("nothing checkable backs it (no USDA figure or cited page passed)")
    return problems
