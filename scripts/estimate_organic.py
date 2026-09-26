#!/usr/bin/env python3
"""Ask Claude, from what it already knows, whether each grocery-list food is
worth buying organic — and write the answers as estimates.

What this file does: it takes every food on the grocery list that has no
estimate yet (estimatestore.to_estimate), asks `claude -p` about them in
batches of ten, checks each answer against estimatestore's vocabulary, and
saves the ones that pass. An answer that fails the check is reported, never
half-saved. One run at a time: a second run while one is going exits at once.
The Kitchen page starts this through POST /api/food/estimates/run
(routes/food.py); it can also be run by hand or from cron:

    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data venv/bin/python3 scripts/estimate_organic.py [--force] [--dry-run]

--force re-asks about foods that already have an estimate (a fresh estimate
starts unreviewed again); --dry-run prints the prompt and exits.

How it ends is written to estimate_run.json in the data dir (started,
finished, saved, and each failure with its reason), which the Kitchen page
reads to say what happened.

Touches: estimatestore.py (what to ask about, and every write), foodstore.py
(through estimatestore, a food is made for a list name that has none).

Prompt that produced this file: "get an approximate based off of Claude's
confidence … figure out some qualifiers, and provide what is genuinely known
in terms of contaminants that actually affect that item like PFAS or whatever
else, maybe not pesticides."
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Make the skeleton root importable from anywhere.
SKELETON = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import estimatestore  # noqa: E402
import hazardstore  # noqa: E402
import store  # noqa: E402

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
MODEL = os.environ.get("EXOCORTEX_ESTIMATE_MODEL", "claude-sonnet-5")
BATCH_SIZE = 10
TIMEOUT_SECONDS = 300

# The instructions the model gets. Written so a guess can't dress up as
# research: no invented numbers or studies, confidence lowered when the
# evidence is thin, and contaminants listed only when something real is known
# about them in this food.
PROMPT = """You are estimating, from general knowledge only, whether each food below is worth buying organic for HEALTH reasons (not environmental ones). There is no research in front of you, and the reader knows that — so be honest about what is well established and what isn't.

For each food, give:
- "verdict": one of "organic" (buy organic), "some" (organic helps some), "conventional" (conventional is fine), "open" (genuinely can't say).
- "confidence": "high", "medium" or "low". High only where the evidence is broad and consistent (e.g. residue testing on fruit and vegetables that is repeated year after year). Use low where studies are few or disputed. Don't round up.
- "summary": 2-4 plain sentences on why. Say what organic does and doesn't change for this food, including pesticide residue. No invented figures, no invented study names; if you mention a number, it must be one you are confident is widely reported.
- "qualifiers": zero or more of these keys, only where they really apply:
{qualifiers}
- "contaminants": what ELSE is genuinely known to get into this particular food, apart from synthetic pesticide residue — for example PFAS, lead, cadmium, arsenic, mercury, mycotoxins (aflatoxin, ochratoxin), dioxins/PCBs, nitrates, BPA or phthalates from packaging, microplastics, veterinary drug residues. List only ones with real documented relevance to this food; an empty list is a fine answer. Each entry:
  {{"name": "...", "known": "1-2 sentences on what is actually established for this food", "organic_helps": "yes|partly|no|unknown", "evidence": "established|suggestive|speculative"}}

Foods:
{foods}

Answer with ONLY a JSON array, one object per food in the same order, each with "food" set to the food's name exactly as given above. No prose before or after it."""


def build_prompt(names):
    qualifiers = "\n".join(f'    "{key}" — {words}' for key, words in estimatestore.QUALIFIERS.items())
    foods = "\n".join(f"- {name}" for name in names)
    return PROMPT.format(qualifiers=qualifiers, foods=foods)


def run_claude(prompt):
    """Seam for tests: the real one shells out to `claude -p`."""
    result = subprocess.run([CLAUDE_BIN, "-p", "--model", MODEL], input=prompt,
                            capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "claude failed").strip()[:300])
    return result.stdout


def parse_answer(text):
    """The JSON array out of the model's reply, tolerating a code fence or a
    stray line around it. Raises ValueError when there is no array."""
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("the reply held no JSON array")
    answer = json.loads(text[start:end + 1])
    if not isinstance(answer, list):
        raise ValueError("the reply was not a list")
    return answer


def estimate(items, ask=run_claude):
    """Ask about `items` [(name, category)] in batches and save each answer.
    Returns (saved names, failures [{food, error}])."""
    saved, failures = [], []
    for start in range(0, len(items), BATCH_SIZE):
        batch = items[start:start + BATCH_SIZE]
        names = [name for name, _category in batch]
        try:
            answers = parse_answer(ask(build_prompt(names)))
        except (ValueError, RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
            failures.extend({"food": name, "error": str(exc)} for name in names)
            continue
        # Match answers to foods by the name the model echoes back, not by
        # position, so a skipped or reordered answer can't land on the wrong food.
        by_name = {str(a.get("food", "")).strip().lower(): a for a in answers if isinstance(a, dict)}
        for name, category in batch:
            answer = by_name.get(name.lower())
            if answer is None:
                failures.append({"food": name, "error": "no answer for this food"})
                continue
            try:
                food_id = estimatestore.food_for_item(name, category)
                estimatestore.save(food_id, answer, model=MODEL)
                saved.append(name)
            except ValueError as exc:
                failures.append({"food": name, "error": str(exc)})
    return saved, failures


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    items = estimatestore.to_estimate(force=args.force)
    if args.dry_run:
        print(build_prompt([name for name, _ in items]) if items else "nothing to estimate")
        return 0

    # One run at a time: hold the lock for the whole run; a second run leaves.
    lock = open(estimatestore.lock_path(), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("an estimate run is already going", file=sys.stderr)
        return 1
    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    store.write_file(estimatestore.RUN_FILE, {"started": started, "finished": None,
                                              "asked": len(items), "saved": [], "failures": []})
    saved, failures = estimate(items)
    store.write_file(estimatestore.RUN_FILE, {
        "started": started, "finished": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "asked": len(items), "saved": saved, "failures": failures})
    print(f"saved {len(saved)}, failed {len(failures)}")
    for failure in failures:
        print(f"  {failure['food']}: {failure['error']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
