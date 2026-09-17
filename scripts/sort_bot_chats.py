#!/usr/bin/env python3
"""Auto-sorter for Observatory chat sessions.

For every `bot_chats/index.json` entry with no `bot_chats/gists.json` entry
yet, builds a compact transcript excerpt from the conversation's own jsonl
(reusing `recap_summary.build_bot_dialogue` — the same "User: .../Assistant:
..." dialogue format the roster's card summaries are built from), and asks a
cheap headless Claude turn to classify it against two vocabularies:

  - data/fronts.json      — the 12 life fronts (health, job, exocortex, ...)
  - data/exo_domains.json — 5 sub-fronts *within* exocortex (ui-design,
    keeper-journal, research-system, agents-infra, vision-product)

The result lands in `data/bot_chats/gists.json`, a SIDECAR collection kept
deliberately separate from `bot_chats/index.json` — the app's index is
mutated constantly (every turn, every roster poll almost), and this script
must never contend for its lock. Going through `store.mutate("bot_chats/
gists", ...)` gets that for free: store keys its flock by file path, so
gists.json gets its own `gists.json.lock`, untouched by anything index-side.

Idempotent + quiet on no-op — safe to cron. A conversation with a turn
genuinely in flight is skipped (its transcript is a moving target), judged by
whether its log is still being written to rather than by the `running` flag,
which strands easily — see _is_live. A conversation already in gists.json is
skipped unless --all or --conv forces it.

Usage:
    scripts/sort_bot_chats.py                 # sort every unsorted, non-running conv
    scripts/sort_bot_chats.py --dry-run        # print prompts + who'd be sorted; call nothing
    scripts/sort_bot_chats.py --conv <id>      # sort just one conv (even if already sorted)
    scripts/sort_bot_chats.py --all            # re-sort every conv (even if already sorted)
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import recap_summary                              # noqa: E402
import store                                       # noqa: E402

# Same override seam as routes/observatory.py: an install where `claude`
# isn't on this script's PATH (e.g. cron with a bare env) can point it at an
# absolute path.
CLAUDE_BIN = os.environ.get("EXOCORTEX_CLAUDE_BIN", "claude")
# Cheap-model convention from recap_summary.py's card summaries — a sort is a
# classification task, not a reasoning one.
SORT_MODEL = "claude-haiku-4-5"
CLAUDE_TIMEOUT_SEC = 120

# Keep the prompt (and therefore the bill) small — a gist doesn't need the
# whole transcript, just enough to tell what a session was about.
MAX_TRANSCRIPT_CHARS = 6000

BY = f"sort_bot_chats:{SORT_MODEL}"

# How long a conversation log can sit untouched before a `running` flag on it
# is treated as a corpse. See _is_live for why this is measured off the log
# rather than off the flag.
LIVE_LOG_IDLE_SEC = 900

_PROMPT_PREAMBLE = """You are sorting a chat session transcript into a filing system.

Read the transcript excerpt below and respond with ONLY a single JSON object
(no markdown fences, no commentary before or after), with exactly these keys:

  "title": a short (under 60 chars) descriptive title for this session
  "gist": one or two sentences (under 220 chars) summarizing what this
          session is/was about, in plain language
  "tags": a list of 1-5 short lowercase keyword tags
  "front": the single best-matching front id from the FRONTS list below, or
           null if none fit
  "domain": if (and only if) front is "exocortex", the single best-matching
            domain id from the DOMAINS list below, or null if none fit
            particularly well; if front is not "exocortex", this must be null
  "confidence": one of "high", "medium", "low" — how confident you are in
                the front/domain call

FRONTS (id: name):
{fronts}

DOMAINS — sub-fronts *within* the "exocortex" front only (id: name — description):
{domains}

TRANSCRIPT EXCERPT:
---
{transcript}
---

Respond with ONLY the JSON object."""


def _chats_dir():
    return store.DATA_DIR / "bot_chats"


def _is_live(conv_id, entry):
    """Is a turn genuinely running right now, or is the flag a leftover?

    A `running` flag outlives its turn easily: the event relay lives in a
    THREAD inside a gunicorn worker, so a worker recycle (--max-requests) or a
    service restart strands the flag set forever. The roster clears a stale one
    at read time, but ARCHIVED sessions never reach that path — so nothing in
    the system ever corrects them, and this script skipped them on every run.
    Four sessions had carried a stale flag for 5-9 days by 2026-08-02 and were
    permanently unsortable: invisible on the roster AND never gisted.

    Liveness is read off the conversation LOG'S MTIME, not the flag and not
    `last_at`. A live turn streams events into its jsonl continuously, while
    `last_at` only moves at send and at turn end — so a long build turn would
    look idle mid-flight and get sorted on a half-written transcript.

    A missing/unreadable log reads as not-live, matching what the script
    already does with conversations that have no log to excerpt."""
    if not entry.get("running"):
        return False
    try:
        idle = time.time() - (_chats_dir() / f"{conv_id}.jsonl").stat().st_mtime
    except OSError:
        return False
    return idle < LIVE_LOG_IDLE_SEC


def _load_vocab():
    """(fronts, domains) as lists of dicts, defensively — a missing or
    malformed vocab file just yields an empty list, never a crash."""
    fronts_raw = store.read("fronts", {})
    fronts_list = fronts_raw.get("fronts") if isinstance(fronts_raw, dict) else None
    fronts = [f for f in (fronts_list or []) if isinstance(f, dict) and f.get("id")]

    domains_raw = store.read("exo_domains", {})
    domains_list = domains_raw.get("domains") if isinstance(domains_raw, dict) else None
    domains = [d for d in (domains_list or []) if isinstance(d, dict) and d.get("id")]

    return fronts, domains


def _transcript_excerpt(conv_id):
    """A compact User:/Assistant: dialogue built the same way the roster's
    card summaries are (recap_summary.build_bot_dialogue) — text turns only,
    each capped, newest _MAX_MESSAGES kept. Trimmed further here to a hard
    char cap so one long conversation can't blow up the prompt."""
    path = _chats_dir() / f"{conv_id}.jsonl"
    if not path.exists():
        return ""
    lines = path.read_text(errors="replace").splitlines()
    dialogue = recap_summary.build_bot_dialogue(lines)
    if len(dialogue) > MAX_TRANSCRIPT_CHARS:
        # Keep the tail — the end of a conversation is more telling of "what
        # this session is/became about" than its opening lines.
        dialogue = "…\n" + dialogue[-MAX_TRANSCRIPT_CHARS:]
    return dialogue


def build_prompt(transcript, fronts, domains):
    fronts_desc = "\n".join(f"- {f['id']}: {f.get('name', f['id'])}" for f in fronts)
    domains_desc = "\n".join(
        f"- {d['id']}: {d.get('name', d['id'])} — {d.get('description', '')}"
        for d in domains)
    return _PROMPT_PREAMBLE.format(
        fronts=fronts_desc or "(none configured)",
        domains=domains_desc or "(none configured)",
        transcript=transcript or "(empty transcript)")


def _run_claude(prompt):
    """Seam for tests: real implementation shells out to `claude -p`, same
    invocation shape as recap_summary._run_claude."""
    return subprocess.run(
        [CLAUDE_BIN, "-p", "--model", SORT_MODEL],
        input=prompt, capture_output=True, text=True, timeout=CLAUDE_TIMEOUT_SEC,
        cwd=str(Path.home()),
    )


def _extract_json(text):
    """Claude sometimes wraps JSON in a code fence despite instructions not
    to — strip one if present before parsing."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()
    return json.loads(text)


def classify(conv_id, title_hint, fronts, domains):
    """Run one conversation through Claude and return a validated gist dict,
    or None on any failure (bad process exit, unparseable output, ...) — a
    single bad conversation must never take the whole run down."""
    transcript = _transcript_excerpt(conv_id)
    prompt = build_prompt(transcript, fronts, domains)
    try:
        result = _run_claude(prompt)
    except (subprocess.SubprocessError, OSError) as e:
        print(f"  {conv_id}: claude call failed ({e}) — skipped")
        return None
    if result.returncode != 0 or not (result.stdout or "").strip():
        err = (result.stderr or "").strip().splitlines()[-1:] or [""]
        print(f"  {conv_id}: claude exited {result.returncode} ({err[0]}) — skipped")
        return None
    try:
        parsed = _extract_json(result.stdout)
    except (ValueError, TypeError) as e:
        print(f"  {conv_id}: could not parse claude's reply as JSON ({e}) — skipped")
        return None
    if not isinstance(parsed, dict):
        print(f"  {conv_id}: claude's reply was not a JSON object — skipped")
        return None

    front_ids = {f["id"] for f in fronts}
    domain_ids = {d["id"] for d in domains}

    front = parsed.get("front")
    front = front if front in front_ids else None

    domain = parsed.get("domain")
    domain = domain if domain in domain_ids else None
    # Domains are sub-fronts within exocortex only — a domain call without
    # the exocortex front (or paired with a different one) doesn't fit the
    # vocabulary; keep the domain but the front follows it, never the reverse
    # (a session correctly called out as e.g. "ui-design" IS exocortex work
    # even if the model's own front pick drifted).
    if domain and front != "exocortex":
        front = "exocortex"

    tags = parsed.get("tags")
    tags = [str(t) for t in tags][:5] if isinstance(tags, list) else []

    confidence = parsed.get("confidence")
    confidence = confidence if confidence in ("high", "medium", "low") else "low"

    title = (parsed.get("title") or "").strip()[:60] or title_hint
    gist = (parsed.get("gist") or "").strip()[:280]

    return {
        "title": title,
        "gist": gist,
        "tags": tags,
        "front": front,
        "domain": domain,
        "confidence": confidence,
        "sorted_at": datetime.now().isoformat(timespec="seconds"),
        "by": BY,
    }


def _candidates(index, gists, conv_arg, all_flag):
    """Which conv ids to (re)sort, in a stable order, honoring the flags."""
    if conv_arg:
        return [conv_arg] if conv_arg in index else []
    ids = sorted(index.keys())
    if all_flag:
        return ids
    return [cid for cid in ids if cid not in gists]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="print prompts + which conversations would be sorted; call nothing")
    parser.add_argument("--conv", metavar="ID",
                        help="sort just this conversation, even if already sorted")
    parser.add_argument("--all", action="store_true",
                        help="re-sort every conversation, even ones already in gists.json")
    args = parser.parse_args(argv)

    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        print("bot_chats/index.json missing or malformed — nothing to sort")
        return 0
    gists_raw = store.read("bot_chats/gists", {})
    gists = gists_raw if isinstance(gists_raw, dict) else {}

    fronts, domains = _load_vocab()

    candidates = _candidates(index, gists, args.conv, args.all)
    if args.conv and not candidates:
        print(f"{args.conv}: not found in bot_chats/index.json")
        return 1

    todo = []
    for conv_id in candidates:
        entry = index.get(conv_id)
        if not isinstance(entry, dict):
            continue
        if _is_live(conv_id, entry):
            print(f"  {conv_id}: running — skipped")
            continue
        # A session started from a front's room carries an EXPLICIT `front` on
        # its index entry. That's a filing she made on purpose, so the sorter
        # never re-guesses it — inferring over it would silently move a
        # conversation out of the room she started it in. --conv still forces
        # a re-sort, which is the escape hatch when a filing was wrong.
        if entry.get("front") and not args.conv:
            print(f"  {conv_id}: filed explicitly to {entry['front']} — skipped")
            continue
        todo.append(conv_id)

    if not todo:
        print("nothing to sort")
        return 0

    if args.dry_run:
        print(f"would sort {len(todo)} conversation(s):")
        for conv_id in todo:
            title_hint = index[conv_id].get("title", "Untitled")
            print(f"\n=== {conv_id} ({title_hint!r}) ===")
            print(build_prompt(_transcript_excerpt(conv_id), fronts, domains))
        return 0

    sorted_count = 0
    for conv_id in todo:
        title_hint = index[conv_id].get("title", "Untitled")
        result = classify(conv_id, title_hint, fronts, domains)
        if result is None:
            continue
        with store.mutate("bot_chats/gists", {}) as g:
            g[conv_id] = result
        sorted_count += 1
        print(f"  {conv_id}: sorted -> front={result['front']} domain={result['domain']} "
              f"({result['confidence']})")

    print(f"sorted {sorted_count}/{len(todo)} conversation(s)")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
