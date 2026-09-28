#!/usr/bin/env python3
"""Propose where each of her foods and products comes from — with evidence — for the checker to test.

What this file does: it lists what still needs an origin (proposalstore.targets):
first the foods she pressed "Request linking" on, then foods with no source,
then products, then her existing sources (to suggest improvements). For each,
it asks `claude -p` — with web search and nothing else — where it comes from,
with the passage on each page that says so. The answer is cleaned against the
rules in provenance.py; when the model names a USDA commodity, the script
fetches the real county figures from USDA NASS itself rather than trusting the
model's numbers. A state or province the answer names (anywhere in the
world) is drawn as its outline, found by georegions.py in the answer's own
words. The evidence is written to her research pool as unreviewed
machine entries (under the topic "Food origins"), and the proposal to the
proposal tables, unchecked. `scripts/check_proposals.py` tests it next.

Nothing here writes her sources: a proposal sits beside them, shown as the
machine's, and a re-run supersedes the old proposal rather than deleting it.

    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data venv/bin/python3 scripts/propose_sources.py [--limit N] [--only foods|products|sources|requests] [--force] [--dry-run]

--limit asks about only the first N targets; --force re-asks targets that
already have a live proposal; --dry-run prints the first prompt and the target
list and writes nothing. One run at a time: a second run exits at once. How the
run went is written to source_proposal_run.json in the data dir.

Touches: provenance.py (cleaning, ranking, USDA), georegions.py (region
outlines), proposalstore.py (targets and
every proposal write), estimatestore.py (her organic estimates, reused as an
ingredient's health concern), routes/research.py + store.py (the research
pool's entries, the same write path scripts/research_ctl.py uses), and
researchstore.py (linking each claim to its page).

Prompt that produced this file: "propose where each food and product comes
from, with evidence and origin" — evidence from "model knowledge + USDA NASS
figures + web search (brand/industry pages)"; products "list every
ingredient, rank each, summary = the worst one and which ingredient"; imports
"find a way to map these more closely"; and "work on everything, including
suggesting improvements to the existing sources".
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# Make the skeleton root importable from anywhere.
SKELETON = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import estimatestore  # noqa: E402
import georegions  # noqa: E402
import proposalstore  # noqa: E402
import provenance  # noqa: E402
import researchstore  # noqa: E402
import store  # noqa: E402

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
MODEL = os.environ.get("EXOCORTEX_PROPOSE_MODEL", "claude-sonnet-5")
BATCH_SIZE = 4
TIMEOUT_SECONDS = 900
RUN_FILE = "source_proposal_run.json"
TOPIC_NAME = "Food origins"
USDA_SITE = "https://quickstats.nass.usda.gov/"

# The instructions the model gets. Written so a guess can't dress up as a
# finding: every place needs a page that says so, quoted word for word, and
# the checker will open that page and look for the quote.
PROMPT = """You are finding where foods and grocery products bought in Austin, Texas come from. Use web search to find real pages — the brand's own site, the store's product page, an industry or government report — and quote them exactly. A checker will open every URL you cite and look for your quote word for word, then ask whether it supports your claim; anything it can't find fails.

For each item below, answer with one object:
- "item": the item's key exactly as given (e.g. "food:12").
- "skip": a short reason, ONLY if the item is not something eaten (shampoo, a bag). Otherwise omit it.
- "name": a short label for the place, e.g. "Quinoa — Bolivian altiplano" or "H-E-B milk — Central Texas dairies".
- "place": {{"lat": number, "lng": number, "country": two-letter ISO code, "region_name": the state/province/region in words, "precision": "area" (or "point" only for one named facility or farm), "radius_km": how wide the area honestly is}}. For an import, centre it on the actual producing province or region, not the country's middle.
- "transparency": how disclosed this supply chain is — "disclosed" (the brand names the farms or facility), "partial" (a region or a co-op, not the farm), "opaque" (nothing said).
- "geo_source": "proxy" when the place is where this is generally grown (industry or USDA statistics), "guess" when it is reasoned without such figures. Never anything else — only an in-person visit can confirm a placement.
- "origin": "package" (the brand or store says so), "research" (a report or article), or "usda-nass" (you are relying on the USDA figures the script will fetch), or "unknown".
- "origin_detail": the citation in words; "origin_url": the main page.
- "usda_commodity": for anything grown or raised in the US, the USDA NASS QuickStats commodity_desc that fits it (e.g. "CATTLE", "CHICKENS", "MILK", "SWEET POTATOES", "RICE"), or null when none fits. The script fetches the county figures itself; don't quote numbers for it.
- "summary": 1-3 plain sentences: where it comes from and how sure that is.
- "evidence": a list of {{"url", "title", "quote": a passage copied exactly from that page (one or two sentences), "claim": the one-sentence claim the quote backs}}. At least one when you can find any.
- "ingredients": the ingredient list as the label or the product page gives it, one string per ingredient in label order (["organic beef bones", "water", "organic onions", ...]). A whole food with no label is one ingredient: ["kale"]. Look the list up — don't guess it from the name.
- "parts": REQUIRED whenever "ingredients" names two or more things besides water — broth, ice cream, chips, sauces, spreads, flavoured anything. One entry per ingredient in label order (water may be left out), each {{"ingredient", "place": where it's from in words, "transparency", "geo_source", "health_concern": "high"|"some"|"low"|"unknown" — how much it is worth worrying about for health (residues, contaminants, additives), "note"}}. The top-level place is where the product is made or its main ingredient comes from. Omit "parts" only for a single ingredient; an answer listing several ingredients without parts is refused.
{improve}
Items:
{items}

Answer with ONLY a JSON array, one object per item, in any order. No prose before or after it."""

IMPROVE = """
Some items are the reader's EXISTING map entries (keys starting "source:"), shown with what they say now. For those, propose a better version of the same entry: a more exact place, a citation where it has none, or a corrected transparency — and say in "summary" what you changed and why. If it is already right, still answer, with the same place and evidence for it.
"""


def _item_lines(targets):
    """One line per target for the prompt: its key, what it is, what's known."""
    lines = []
    for target in targets:
        line = f"- {target['key']}: {target['label']}"
        if target.get("context"):
            line += f" — {target['context']}"
        lines.append(line)
    return "\n".join(lines)


def build_prompt(targets):
    improve = IMPROVE if any(t["key"].startswith("source:") for t in targets) else ""
    return PROMPT.format(items=_item_lines(targets), improve=improve)


def run_claude(prompt):
    """Seam for tests: the real one shells out to `claude -p` with only the
    web tools, so the model can search and read pages but touch nothing else."""
    result = subprocess.run([CLAUDE_BIN, "-p", "--model", MODEL, "--tools", "WebSearch,WebFetch"],
                            input=prompt, capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "claude failed").strip()[:300])
    return result.stdout


def parse_answer(text):
    """The JSON array out of the model's reply, tolerating prose around it."""
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("the reply held no JSON array")
    answer = json.loads(text[start:end + 1])
    if not isinstance(answer, list):
        raise ValueError("the reply was not a list")
    return answer


# --- the research pool: where the evidence lives ------------------------------
# Every page, USDA query and model statement becomes an entry in her research
# pool, written as the machine's (author 'llm', reviewed false), filed under
# one topic, the same shape scripts/research_ctl.py writes.

def _topic_id(data):
    from scripts.research_ctl import _normalize_name
    from routes.research import _slugify, _unique_id
    topics = data.setdefault("topics", [])
    for topic in topics:
        if _normalize_name(topic["name"]) == _normalize_name(TOPIC_NAME):
            return topic["id"]
    topic_id = _unique_id(_slugify(TOPIC_NAME), {t["id"] for t in topics})
    topics.append({"id": topic_id, "name": TOPIC_NAME, "status": "active",
                   "created": datetime.now().strftime("%Y-%m-%d %H:%M")})
    return topic_id


def record_evidence(proposal, usda, label):
    """Write the evidence for one proposal. Returns [(entry id, role)] and the
    (claim id, source id, quote) pairs to link once the entries exist."""
    from routes.research import _new_entry_id
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    written, links = [], []
    with store.mutate("research.json", {"topics": [], "entries": [], "sessions": []}) as data:
        topic_id = _topic_id(data)
        entries = data.setdefault("entries", [])

        def add(kind, text, url=""):
            entry = {"id": _new_entry_id(entries), "kind": kind, "text": text, "topics": [topic_id],
                     "url": url, "verdict": "", "status": "", "reply_to": "", "created": now,
                     "author": "llm", "reviewed": False}
            entries.append(entry)
            return entry["id"]

        # A cited page becomes a source entry, and what it backs a claim entry.
        for item in proposal["evidence"]:
            source_id = add("source", item["title"] or item["url"], item["url"])
            claim_id = add("claim", f"{label}: {item['claim']}")
            written += [(source_id, "web"), (claim_id, "web")]
            links.append((claim_id, source_id, item["quote"]))
        # The USDA figures become a source entry naming the exact query.
        if usda:
            source_id = add("source", usda["origin_detail"], USDA_SITE)
            claim_id = add("claim", f"{label}: grown or raised mostly in {usda['region_name']}"
                                    f" (top county {usda['counties'][0]['county']},"
                                    f" {usda['counties'][0]['state']}), per USDA NASS.")
            written += [(source_id, "usda"), (claim_id, "usda")]
            links.append((claim_id, source_id, ""))
        # The model's own summary is kept too, marked as model knowledge.
        if proposal["summary"]:
            written.append((add("claim", f"{label}: {proposal['summary']}"), "model"))
    return written, links


def _link(links):
    for claim_id, source_id, quote in links:
        researchstore.link_claim_source(claim_id, source_id, note=quote[:600])


# --- one target, from answer to saved proposal -------------------------------

def _health_from_estimates(parts):
    """Where she already has an organic estimate for an ingredient, its verdict
    sets the health concern instead of the model's word."""
    # Look foods up by name only — food_page reads and never creates a food.
    for part in parts:
        page = estimatestore.food_page(part["ingredient"])
        estimate = page.get("estimate")
        if page.get("food"):
            part["food_id"] = page["food"]["id"]
        if estimate and estimate.get("verdict") in provenance.HEALTH_FROM_ESTIMATE:
            part["health_concern"] = provenance.HEALTH_FROM_ESTIMATE[estimate["verdict"]]
            part["health_basis"] = f"estimate:{estimate['id']}"
    return parts


def save_answer(target, answer, usda_key, run_id, fetch_usda=provenance.usda_placement):
    """Clean, enrich and save one answer. Returns (proposal id or None, problems)."""
    proposal, problems = provenance.clean_answer(answer)
    if proposal is None:
        return None, problems
    usda = None
    if proposal["usda_commodity"] and proposal["country"] in ("US", "") and usda_key:
        try:
            usda = fetch_usda(proposal["usda_commodity"], usda_key)
        except Exception as exc:  # USDA is slow and flaky; the proposal still stands on its pages
            problems.append(f"USDA fetch failed: {str(exc)[:120]}")
        if usda is None and not any("USDA fetch" in p for p in problems):
            problems.append(f"USDA has no county figures for {proposal['usda_commodity']}")
    # A USDA answer sets the place: the counties, centred on the lead state.
    counties = []
    if usda:
        counties = usda["counties"]
        proposal.update(lat=usda["lat"], lng=usda["lng"], area_kind="counties", precision="area",
                        region_name=usda["region_name"], country="US", geo_source="proxy",
                        radius_km=max(proposal["radius_km"], 200.0))
        if proposal["origin"] in ("unknown", "usda-nass"):
            proposal.update(origin="usda-nass", origin_detail=usda["origin_detail"], origin_url=USDA_SITE)
    elif proposal["origin"] == "usda-nass":
        proposal["origin"] = "research" if proposal["evidence"] else "unknown"
    # Draw a named state or province as its outline, not a circle. The regions
    # come only from the proposal's own words (georegions.match); a place
    # given as part of a region ("East Texas"), or one far smaller than the
    # region, stays a circle.
    regions = []
    if not usda and proposal["area_kind"] == "circle":
        regions = georegions.regions_for(proposal["country"], proposal["region_name"],
                                         radius_km=proposal["radius_km"] or 0)
        if regions:
            proposal.update(area_kind="state", precision="area")
    proposal["origin_date"] = time.strftime("%Y-%m-%d")
    _health_from_estimates(proposal["parts"])
    proposal.update(provenance.worst_parts(proposal["parts"]))

    evidence, links = record_evidence(proposal, usda, target["label"])
    _link(links)
    proposal_id = proposalstore.add(target, proposal, counties=counties, evidence=evidence,
                                    model=MODEL, run_id=run_id, regions=regions)
    return proposal_id, problems


def propose(targets, ask=run_claude, usda_key="", run_id=""):
    """Ask about `targets` in batches and save each answer.
    Returns (saved [(key, proposal id)], skipped [{item, reason}], failures [{item, error}])."""
    saved, skipped, failures = _propose_once(targets, ask, usda_key, run_id)
    # Ask again, once, about every item that failed. A refused answer (a
    # product listed with no parts) or a timed-out batch usually comes right
    # the second time; what still fails is reported.
    if failures:
        failed_keys = {failure["item"] for failure in failures}
        retry = [target for target in targets if target["key"] in failed_keys]
        again_saved, again_skipped, failures = _propose_once(retry, ask, usda_key, run_id)
        saved += again_saved
        skipped += again_skipped
    return saved, skipped, failures


def _propose_once(targets, ask, usda_key, run_id):
    saved, skipped, failures = [], [], []
    for start in range(0, len(targets), BATCH_SIZE):
        batch = targets[start:start + BATCH_SIZE]
        try:
            answers = parse_answer(ask(build_prompt(batch)))
        except (ValueError, RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
            failures.extend({"item": t["key"], "error": str(exc)[:300]} for t in batch)
            continue
        # Match answers to targets by the key the model echoes back, never by position.
        by_key = {str(a.get("item", "")).strip(): a for a in answers if isinstance(a, dict)}
        for target in batch:
            answer = by_key.get(target["key"])
            if answer is None:
                failures.append({"item": target["key"], "error": "no answer for this item"})
            elif answer.get("skip"):
                skipped.append({"item": target["key"], "reason": str(answer["skip"])[:200]})
            else:
                try:
                    proposal_id, problems = save_answer(target, answer, usda_key, run_id)
                except ValueError as exc:
                    proposal_id, problems = None, [str(exc)]
                if proposal_id is None:
                    failures.append({"item": target["key"], "error": "; ".join(problems)})
                else:
                    saved.append({"item": target["key"], "id": proposal_id, "notes": problems})
    return saved, skipped, failures


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only", choices=("requests", "foods", "products", "sources"))
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    targets = proposalstore.targets(only=args.only, force=args.force)
    if args.limit:
        targets = targets[:args.limit]
    if args.dry_run:
        for target in targets:
            print(f"{target['key']:>14}  {target['label']}")
        print(build_prompt(targets[:BATCH_SIZE]) if targets else "nothing to propose")
        return 0

    # One run at a time: hold the lock for the whole run; a second run leaves.
    lock = open(store.DATA_DIR / "source_proposal_run.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("a proposal run is already going", file=sys.stderr)
        return 1
    run_id = time.strftime("%Y%m%d-%H%M%S")
    usda_key = (store.read("ecosystem_config", {}).get("usda_key")
                or os.environ.get("EXOCORTEX_USDA_KEY") or "").strip()
    store.write_file(RUN_FILE, {"run_id": run_id, "started": run_id, "finished": None,
                                "asked": len(targets)})
    saved, skipped, failures = propose(targets, usda_key=usda_key, run_id=run_id)
    store.write_file(RUN_FILE, {"run_id": run_id, "started": run_id,
                                "finished": time.strftime("%Y%m%d-%H%M%S"), "asked": len(targets),
                                "saved": saved, "skipped": skipped, "failures": failures})
    print(f"saved {len(saved)}, skipped {len(skipped)}, failed {len(failures)}")
    for failure in failures:
        print(f"  {failure['item']}: {failure['error']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
