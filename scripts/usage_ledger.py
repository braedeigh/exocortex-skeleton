#!/usr/bin/env python3
"""usage_ledger.py — what every background run cost, and how close the
subscription is to its wall.

Plain English: this is the receipt book. When the run dispatcher notices a run
has finished, it asks this file two questions — "how many tokens did that
spend?" and "how full is the subscription right now?" — and writes the answers
into token_usage.json, one record per run. A separate hourly pass folds those
records into per-day totals broken out by lane and by model, so a week later
there's an honest answer to "what does this system cost me, and where does it
go."

Kept Flask-free ON PURPOSE, exactly like scripts/claude_transcripts.py: this
runs from cron and from the dispatcher, neither of which should drag the whole
web app into memory to add up some numbers.

Touches:
  - scripts/claude_transcripts.py — the actual token summing (sum_tokens), which
    reads Claude Code's own transcript files and time-slices them.
  - scripts/run_dispatcher.py — the only caller of receipt()/append_entry(); it
    also imports looks_throttled() from here.
  - data/token_usage.json — the ledger this file owns.
  - data/bot_chats/<conv>.jsonl — the fallback token source for runs that are
    Observatory turns rather than tmux workers.

Prompt that produced it: "i want to also build in some kind of tracker for
tokens/usage ... all i care about for now is some kind of data logging of how
much usage I am using for each kind of job and what models are being used and
when and how many sessions."
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

# Make the skeleton root importable regardless of where this is invoked from
# (mirrors scripts/research_dispatcher.py's bootstrap).
HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
from scripts import claude_transcripts  # noqa: E402

LEDGER = "token_usage.json"


def _ledger_default():
    """A FRESH default per call — never a shared module-level dict. When the
    ledger file doesn't exist yet, store.mutate hands the default object
    itself to the caller to fill in; a module-level default's inner list
    would silently accumulate every entry ever appended to a missing file
    and leak them into later reads (found 2026-08-04 by the backfill's
    tests; a shallow dict() copy shares the inner list)."""
    return {"entries": [], "days": {}}

CLAUDE_BIN = os.environ.get("EXOCORTEX_CLAUDE_BIN", "claude")

# Shapes a throttled turn's error takes. Copied deliberately rather than
# imported from scripts/nightcrew_run.py: that module imports routes.observatory,
# which pulls in Flask and the whole route chain — too heavy for a per-minute
# cron script. The two lists converge into this one when nightcrew migrates onto
# the dispatcher (a later pass); until then they're two copies of one truth and
# that's a known cost, not an oversight.
LIMIT_MARKERS = ("rate limit", "rate_limit", "usage limit", "429",
                 "quota", "overloaded", "too many requests")


def looks_throttled(error):
    """True when a run's error reads as a usage-limit refusal. A throttled run
    is not a verdict on the work — nothing was attempted — so the dispatcher
    requeues it AND pauses the whole queue rather than scoring it a failure."""
    low = (error or "").lower()
    return any(m in low for m in LIMIT_MARKERS)


# --- the subscription gauge --------------------------------------------------

# `claude -p "/usage"` answers from local state without calling the model:
# verified 2026-08-03 at num_turns 0, total_cost_usd 0, all four token counters
# 0, in about two seconds. That's what makes it safe to call on every reap —
# it's a free, direct reading of the thing that actually limits this box (the
# subscription window), instead of the number of tokens we infer it from.
_PCT_RE = re.compile(r"Current session:\s*(\d+)%")
_WEEK_RE = re.compile(r"Current week \(([^)]+)\):\s*(\d+)% used(?:\s*·\s*resets ([^(\n]+))?")
_SESSION_RESET_RE = re.compile(r"Current session:.*?resets ([^(\n]+)")
_WINDOW_RE = re.compile(r"Last (24h|7d)\s*·\s*([\d,]+) requests\s*·\s*([\d,]+) sessions")


def parse_usage_text(text):
    """Pull the numbers out of /usage's prose.

    The output is human text, not an API — undocumented and free to change
    shape between releases. So every field is optional: a line that doesn't
    match simply isn't reported, and a totally unrecognizable blob yields {}.
    Nothing here ever raises, because a ledger entry missing its gauge reading
    is much better than a reap that crashes.
    """
    out = {}
    if not isinstance(text, str) or not text:
        return out

    m = _PCT_RE.search(text)
    if m:
        out["session_pct"] = int(m.group(1))
    m = _SESSION_RESET_RE.search(text)
    if m:
        out["session_resets"] = m.group(1).strip()

    # "Current week (all models)" and "Current week (<Model>)" are the same
    # line shape, so they're captured generically into one dict rather than
    # hardcoding today's model names — a new model tier shouldn't need a code
    # change to show up in the ledger.
    by_model = {}
    for label, pct, resets in _WEEK_RE.findall(text):
        by_model[label.strip()] = int(pct)
        if resets and "week_resets" not in out:
            out["week_resets"] = resets.strip()
    if by_model:
        out["week_by_model"] = by_model
        if "all models" in by_model:
            out["week_pct"] = by_model["all models"]

    for window, requests, sessions in _WINDOW_RE.findall(text):
        key = "24h" if window == "24h" else "7d"
        out[f"requests_{key}"] = int(requests.replace(",", ""))
        out[f"sessions_{key}"] = int(sessions.replace(",", ""))
    return out


def _run_usage_cli(timeout=30):
    """Real /usage reader. Returns the CLI's `result` prose, or "" on any
    failure — a missing binary, a timeout, a login prompt, anything."""
    try:
        proc = subprocess.run(
            [CLAUDE_BIN, "-p", "/usage", "--output-format", "json"],
            capture_output=True, text=True, timeout=timeout, cwd="/tmp",
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if proc.returncode != 0:
        return ""
    try:
        payload = json.loads(proc.stdout or "")
    except (ValueError, TypeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    return payload.get("result") or ""


def usage_snapshot(runner=None):
    """The subscription window as a dict, right now. `runner` is injected in
    tests so nothing shells out. Never raises; {} means "couldn't read it"."""
    runner = runner or _run_usage_cli
    try:
        return parse_usage_text(runner())
    except Exception:
        return {}


# --- receipts ----------------------------------------------------------------

def _parse_local(value):
    """Our own ISO timestamps (isoformat(timespec='seconds'), local clock) back
    into datetimes. Returns None on anything unparseable."""
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def conv_totals(conv_id, offset=0, chats_dir=None):
    """Tokens and dollars an Observatory turn spent, read from the
    conversation's own jsonl starting at `offset` bytes.

    Claude Code writes one `result` record per completed turn carrying that
    turn's usage and total_cost_usd. The dispatcher records the file's size at
    the moment it spawns a run, so summing from there counts THIS run's turns
    and nothing the conversation did earlier — the same byte-offset trick
    routes/observatory.py's _session_tokens uses for its live counter.

    Never raises: an unreadable or missing log yields zeros.
    """
    totals = {"input": 0, "cache_creation": 0, "cache_read": 0, "output": 0,
              "total": 0, "cost_usd": 0.0, "model": None}
    chats_dir = chats_dir or (store.DATA_DIR / "bot_chats")
    path = chats_dir / f"{conv_id}.jsonl"
    try:
        with open(path, "rb") as fh:
            fh.seek(max(0, int(offset or 0)))
            chunk = fh.read()
    except (OSError, ValueError, TypeError):
        return totals

    for raw in chunk.splitlines():
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(rec, dict) or rec.get("type") != "result":
            continue
        usage = rec.get("usage")
        if isinstance(usage, dict):
            for key, field in (("input", "input_tokens"),
                               ("cache_creation", "cache_creation_input_tokens"),
                               ("cache_read", "cache_read_input_tokens"),
                               ("output", "output_tokens")):
                try:
                    totals[key] += int(usage.get(field) or 0)
                except (TypeError, ValueError):
                    pass
        try:
            totals["cost_usd"] += float(rec.get("total_cost_usd") or 0)
        except (TypeError, ValueError):
            pass
        # modelUsage is keyed by the model id the turn actually ran on, which
        # is the only place the real (not requested) model appears.
        model_usage = rec.get("modelUsage")
        if isinstance(model_usage, dict) and model_usage:
            totals["model"] = sorted(model_usage)[0]

    totals["total"] = (totals["input"] + totals["cache_creation"]
                       + totals["cache_read"] + totals["output"])
    totals["cost_usd"] = round(totals["cost_usd"], 6)
    return totals


def receipt(run, now=None, sum_fn=None, conv_fn=None, snapshot_fn=None):
    """One finished run's receipt: four token counters, cost, model, duration,
    and the subscription gauge at the moment it was reaped.

    Two token sources, because there are two kinds of run:
      - a tmux worker owns its own Claude Code process and transcript, so its
        tokens come from claude_transcripts.sum_tokens, time-sliced to the run's
        own window (the transcript may cover other work).
      - an Observatory turn's tokens live in the conversation's jsonl, summed
        from the byte offset recorded at spawn.

    Everything is optional and nothing raises: a run whose session id was never
    captured still gets a receipt, just one with zeros in it. A missing receipt
    would silently drop the run from the ledger, which is worse than a zero we
    can see and explain.
    """
    sum_fn = sum_fn or claude_transcripts.sum_tokens
    conv_fn = conv_fn or conv_totals
    now = now or datetime.now()

    started = _parse_local(run.get("started"))
    finished = _parse_local(run.get("finished")) or now

    tokens = {"in": 0, "out": 0, "cache_r": 0, "cache_w": 0}
    cost_usd = 0.0
    model = run.get("model")

    sid, cwd = run.get("claude_session"), run.get("claude_cwd")
    if sid and cwd:
        try:
            # The transcript's own timestamps are UTC; ours are local. astimezone
            # on a naive datetime is presumed-local-then-converted, which is
            # exactly the conversion the window needs.
            since = started.astimezone(timezone.utc) if started else None
            until = finished.astimezone(timezone.utc)
            totals = sum_fn(sid, cwd, since=since, until=until)
            tokens = {"in": totals.get("input", 0), "out": totals.get("output", 0),
                      "cache_r": totals.get("cache_read", 0),
                      "cache_w": totals.get("cache_creation", 0)}
        except Exception:
            pass
    elif run.get("conv_id"):
        try:
            totals = conv_fn(run["conv_id"], run.get("log_offset", 0))
            tokens = {"in": totals.get("input", 0), "out": totals.get("output", 0),
                      "cache_r": totals.get("cache_read", 0),
                      "cache_w": totals.get("cache_creation", 0)}
            cost_usd = totals.get("cost_usd", 0.0)
            model = model or totals.get("model")
        except Exception:
            pass

    duration_sec = (finished - started).total_seconds() if started else None
    out = {
        "tokens": tokens,
        "cost_usd": round(float(cost_usd), 6),
        "model": model,
        "duration_sec": duration_sec,
    }
    snapshot = usage_snapshot(snapshot_fn)
    if snapshot:
        out["usage_at_reap"] = snapshot
    return out


def entry_for(run, receipt_data):
    """The ledger record — one shape, several consumers (the usage rollup, a
    future queue view, the night's narration). Flat and boring on purpose."""
    return {
        "id": run.get("id"),
        "lane": run.get("lane"),
        "kind": run.get("kind"),
        "mem_class": run.get("mem_class"),
        "status": run.get("status"),
        "model": receipt_data.get("model"),
        "started": run.get("started"),
        "finished": run.get("finished"),
        "duration_sec": receipt_data.get("duration_sec"),
        "tokens": receipt_data.get("tokens") or {"in": 0, "out": 0, "cache_r": 0, "cache_w": 0},
        "cost_usd": receipt_data.get("cost_usd", 0.0),
        "throttled": bool(run.get("throttled")),
        "usage_at_reap": receipt_data.get("usage_at_reap") or {},
    }


def append_entry(entry):
    """Add one receipt to the ledger. One mutate, appended — the ledger is
    append-only; the rollup below never edits entries, only reads them."""
    with store.mutate(LEDGER, _ledger_default()) as data:
        data.setdefault("entries", []).append(entry)


# --- the daily fold ----------------------------------------------------------

def fold_entries(entries):
    """Pure fold: ledger entries → {date: {"runs": n, "lanes": {...},
    "models": {...}, "tokens": {...}, "cost_usd": x}}.

    Keyed on the LOCAL date a run finished, since that's the day she'd say it
    happened. An entry with no parseable `finished` is skipped rather than
    guessed at.
    """
    out = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        finished = _parse_local(e.get("finished"))
        if finished is None:
            continue
        day = out.setdefault(finished.strftime("%Y-%m-%d"), {
            "runs": 0, "lanes": {}, "models": {},
            "tokens": {"in": 0, "out": 0, "cache_r": 0, "cache_w": 0},
            "cost_usd": 0.0,
        })
        tokens = e.get("tokens") if isinstance(e.get("tokens"), dict) else {}
        cost = 0.0
        try:
            cost = float(e.get("cost_usd") or 0)
        except (TypeError, ValueError):
            pass

        day["runs"] += 1
        day["cost_usd"] = round(day["cost_usd"] + cost, 6)
        for k in day["tokens"]:
            try:
                day["tokens"][k] += int(tokens.get(k) or 0)
            except (TypeError, ValueError):
                pass

        # Per-lane and per-model slots carry one summed token number rather than
        # the four counters — the question they answer is "where did the usage
        # go", and four columns per lane per model buries that.
        try:
            run_tokens = sum(int(tokens.get(k) or 0) for k in
                             ("in", "out", "cache_r", "cache_w"))
        except (TypeError, ValueError):
            run_tokens = 0
        for bucket, key in (("lanes", e.get("lane") or "unknown"),
                            ("models", e.get("model") or "unknown")):
            slot = day[bucket].setdefault(key, {"runs": 0, "tokens": 0, "cost_usd": 0.0})
            slot["runs"] += 1
            slot["tokens"] += run_tokens
            slot["cost_usd"] = round(slot["cost_usd"] + cost, 6)
    return out


def write_days(folded, today):
    """Write each PAST day's totals under days[<date>], skipping today (still
    accumulating) and any day already written. Same idempotence rule as
    scripts/usage_rollup.py: the first write for a day is the one that stands,
    so re-running the cron can never double-count. Returns (written, skipped)."""
    eligible = sorted(d for d in folded if d < today)
    written, skipped = [], []
    if eligible:
        with store.mutate(LEDGER, _ledger_default()) as data:
            days = data.setdefault("days", {})
            for d in eligible:
                if d in days:
                    skipped.append(d)
                else:
                    days[d] = folded[d]
                    written.append(d)
    return written, skipped


def rollup(today=None):
    """Fold the ledger's entries into per-day totals. Safe to run hourly."""
    today = today or datetime.now().strftime("%Y-%m-%d")
    data = store.read(LEDGER, _ledger_default())
    entries = data.get("entries", []) if isinstance(data, dict) else []
    written, skipped = write_days(fold_entries(entries), today)
    return written, skipped


def main():
    parser = argparse.ArgumentParser(
        description="Fold the run ledger into per-day usage totals.")
    parser.add_argument("--usage", action="store_true",
                        help="print the current subscription-window reading and exit")
    args = parser.parse_args()

    if args.usage:
        print(json.dumps(usage_snapshot(), indent=2))
        return 0

    written, skipped = rollup()
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    bits = []
    if written:
        bits.append(f"wrote {', '.join(written)}")
    if skipped:
        bits.append(f"skipped {len(skipped)} already rolled up")
    print(f"[{stamp}] usage-ledger: {'; '.join(bits) if bits else 'nothing to fold'}")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
