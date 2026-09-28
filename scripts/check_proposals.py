#!/usr/bin/env python3
"""The checker: test every machine proposal of where a food comes from, and mark it passed or failed.

What this file does: for each unchecked proposal (proposalstore.unchecked),
it
  1. opens every page the proposal cites and looks for the quoted passage
     (provenance.quote_found) — a quote that isn't there fails;
  2. hands each found passage and its claim to a separate model call, with no
     tools at all, which says only whether the passage supports the claim;
  3. re-fetches the USDA county figures and compares them with what was saved;
  4. applies the rules (provenance.rule_problems): a machine never marks a
     place 'placed', a USDA placement is a proxy, and something checkable
     must back it.
Every citation must hold for the proposal to pass. Passed means "checked by
machine, not by her"; it also closes the "Request linking" request it answers.
Failed keeps every reason, and is still shown. She is never asked to approve.

    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data venv/bin/python3 scripts/check_proposals.py [--limit N] [--recheck]

--recheck tests proposals that were already checked, too. One run at a time.

Touches: provenance.py (quote finding, USDA comparison, the rules),
proposalstore.py (what to check, and every result), and — through
proposalstore — sourcestore.close_request.

Prompt that produced this file: "I want some checker built into the system"
— re-fetch USDA and compare, fetch each cited URL and have a separate model
confirm it says the claim, enforce the rules; "show failures".
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

# Make the skeleton root importable from anywhere.
SKELETON = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import proposalstore  # noqa: E402
import provenance  # noqa: E402
import store  # noqa: E402

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
MODEL = os.environ.get("EXOCORTEX_CHECK_MODEL", "claude-sonnet-5")
TIMEOUT_SECONDS = 300
PAGE_LIMIT_BYTES = 3_000_000

JUDGE_PROMPT = """You are checking citations. Each numbered item below has a CLAIM and a PASSAGE copied from the web page cited for it. Using only the passage — no outside knowledge — say whether the passage supports the claim. A passage that is merely on the same topic, or supports a weaker or different claim, does not support it.

{items}

Answer with ONLY a JSON array: [{{"n": 1, "supports": true or false, "reason": "one short sentence"}}, ...], one per item."""


# --- reading a cited page ----------------------------------------------------

def fetch_page(url):
    """The readable text of a page, or raises ValueError with a plain reason."""
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) exocortex-checker/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            kind = response.headers.get("Content-Type", "")
            raw = response.read(PAGE_LIMIT_BYTES)
    except Exception as exc:
        raise ValueError(f"couldn't open the page ({str(exc)[:100]})")
    if "html" not in kind and "text" not in kind:
        raise ValueError(f"the page isn't text the checker can read ({kind or 'unknown type'})")
    return provenance.page_text(raw.decode("utf-8", errors="replace"))


def run_claude(prompt):
    """Seam for tests: the judge runs with no tools at all — it reads only the passage."""
    result = subprocess.run([CLAUDE_BIN, "-p", "--model", MODEL, "--tools", ""], input=prompt,
                            capture_output=True, text=True, timeout=TIMEOUT_SECONDS)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "claude failed").strip()[:300])
    return result.stdout


def judge(pairs, ask=run_claude):
    """{n: (supports, reason)} for [(n, claim, passage)]; an unreadable reply fails them all."""
    if not pairs:
        return {}
    items = "\n\n".join(f"{n}. CLAIM: {claim}\nPASSAGE: {passage}" for n, claim, passage in pairs)
    try:
        text = ask(JUDGE_PROMPT.format(items=items))
        start, end = text.find("["), text.rfind("]")
        verdicts = json.loads(text[start:end + 1]) if start >= 0 < end else []
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
        return {n: (False, f"the judge couldn't answer ({str(exc)[:80]})") for n, _c, _p in pairs}
    out = {}
    for verdict in verdicts if isinstance(verdicts, list) else []:
        if isinstance(verdict, dict) and verdict.get("n") in {n for n, _c, _p in pairs}:
            out[verdict["n"]] = (verdict.get("supports") is True, str(verdict.get("reason", ""))[:300])
    for n, _c, _p in pairs:
        out.setdefault(n, (False, "the judge gave no verdict"))
    return out


# --- checking one proposal ---------------------------------------------------

def check(proposal, fetch=fetch_page, ask=run_claude, usda_key="", fetch_usda=provenance.usda_placement,
          pages=None):
    """(status, reason, {entry_id: (status, reason)}) for one proposal."""
    pages = {} if pages is None else pages
    results, problems, pairs = {}, [], []

    # Find each quote on its page; the ones found go to the judge together.
    for n, citation in enumerate(proposal["citations"], start=1):
        url = citation["url"]
        if url not in pages:
            try:
                pages[url] = fetch(url)
            except ValueError as exc:
                pages[url] = exc
        page = pages[url]
        if isinstance(page, ValueError):
            results[citation["claim_id"]] = ("failed", str(page))
        elif not provenance.quote_found(citation["quote"], page):
            results[citation["claim_id"]] = ("failed", "the quoted passage isn't on the page")
        else:
            pairs.append((n, citation["claim"], provenance.passage_around(citation["quote"], page)))
    verdicts = judge(pairs, ask)
    for n, citation in enumerate(proposal["citations"], start=1):
        if n in verdicts:
            supports, reason = verdicts[n]
            results[citation["claim_id"]] = ("passed" if supports else "failed",
                                             reason if not supports else "")
        # The page entry passes or fails with its claim.
        results[citation["source_id"]] = results[citation["claim_id"]]
        if results[citation["claim_id"]][0] == "failed":
            problems.append(f"{url_short(citation['url'])}: {results[citation['claim_id']][1]}")

    # Re-fetch the USDA counties and compare them with what was saved.
    usda_entries = [e for e in proposal["evidence"] if e["role"] == "usda"]
    if proposal["counties"]:
        try:
            fresh = fetch_usda(proposal["usda_commodity"], usda_key) if usda_key else None
            usda_problems = (provenance.usda_matches(proposal["counties"], fresh) if usda_key
                             else ["no USDA key to re-check with"])
        except Exception as exc:
            usda_problems = [f"USDA re-fetch failed ({str(exc)[:80]})"]
        for entry in usda_entries:
            results[entry["entry_id"]] = ("failed", "; ".join(usda_problems)) if usda_problems else ("passed", "")
        problems += usda_problems

    # The rules, over the evidence as it now stands.
    evidence = [dict(e, check_status=results.get(e["entry_id"], ("unchecked", ""))[0])
                for e in proposal["evidence"]]
    problems += provenance.rule_problems(proposal, proposal["counties"], evidence)
    return ("failed" if problems else "passed"), "; ".join(problems), results


def url_short(url):
    return url.split("//", 1)[-1][:60]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--recheck", action="store_true")
    args = parser.parse_args(argv)

    lock = open(store.DATA_DIR / "source_proposal_check.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("a check run is already going", file=sys.stderr)
        return 1
    usda_key = (store.read("ecosystem_config", {}).get("usda_key")
                or os.environ.get("EXOCORTEX_USDA_KEY") or "").strip()
    proposals = proposalstore.unchecked(include_checked=args.recheck)
    if args.limit:
        proposals = proposals[:args.limit]
    pages, passed, failed = {}, 0, 0
    for proposal in proposals:
        status, reason, results = check(proposal, usda_key=usda_key, pages=pages)
        proposalstore.set_check(proposal["id"], status, reason, results)
        passed, failed = passed + (status == "passed"), failed + (status == "failed")
        print(f"{proposal['id']:>5} {status:<7} {proposal['name'][:50]}" + (f" — {reason[:120]}" if reason else ""))
    print(f"passed {passed}, failed {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
