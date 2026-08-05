#!/usr/bin/env python3
"""usage_backfill.py — fold months of existing Claude Code transcripts into
the token ledger, so the usage picture starts with a baseline instead of
waiting weeks for one to accumulate.

Plain English: token_usage.json (scripts/usage_ledger.py's receipt book) was
born nearly empty, but the history it wants already exists — Claude Code keeps
a transcript of every session under ~/.claude/projects/. This script streams
those transcripts, keeps only the app-spawned sessions (every assistant line
carries an `entrypoint` field: "sdk-cli" is a headless `claude -p` run — an
Observatory turn, a morning ritual, a research worker; "cli" is a human at a
terminal, excluded by her call), and writes one ledger entry per session per
model. The existing hourly rollup then folds them into per-day totals with no
new code.

What makes the numbers honest, in order of importance:
  - One message counted ONCE. Claude Code writes one transcript line per
    content block, so a message's usage appears 2-5 times; entries are
    deduplicated by message.id (verified byte-identical across duplicates,
    and deduplicated sums match the app's own per-turn receipts exactly).
  - No invented prices. Per-model $/token rates are FIT from the receipts in
    data/bot_chats/*.jsonl (each carries usage + total_cost_usd), at run
    time, by least squares. A model with no receipt to fit from gets
    cost_usd 0.0 and priced=false — a visible zero, not a guess.
  - No guessed lanes. Lane/origin come from bot_chats/index.json where a
    session id resolves there; everything else is "unknown".
  - Known coverage. Checked against `claude -p "/usage"`'s own request
    counter, transcripts see roughly 90% of it (retries and background calls
    never reach a transcript). Recorded in the backfill metadata rather than
    silently presented as complete.

Idempotent: entry ids are "bf-<session>-<model>"; a re-run skips ids already
in the ledger. Before its first real write it copies token_usage.json to a
timestamped .bak sibling. It also deletes days[] for the dates it backfills so
the next rollup() re-folds them from the now-complete entries — the ONE
deliberate exception to write_days' never-overwrite rule, taken because a
backfilled day is strictly more complete than what the fold knew before.

Touches:
  - ~/.claude/projects/**/*.jsonl — read-only source (streamed, never loaded;
    the full 1GB scans in ~7s at ~30MB resident).
  - data/bot_chats/*.jsonl + index.json — rate fitting and lane/origin.
  - data/token_usage.json — the ledger this fills (entries + backfill meta).
  - scripts/usage_ledger.py — rollup() is invoked at the end to fold days.

Kept Flask-free like the rest of scripts/ — runnable from cron or a shell.

Prompt that produced it: "isn't there data somewhere about this? … just have
it go and do the backfill" + "i want to monitor the agent usage and be able to
define with granularity where everything is going."

    EXOCORTEX_DATA_DIR=... venv/bin/python3 scripts/usage_backfill.py [--dry-run]
"""
import argparse
import json
import os
import re
import shutil
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import store  # noqa: E402
from scripts import usage_ledger  # noqa: E402
from scripts.claude_transcripts import CLAUDE_HOME, _parse_timestamp  # noqa: E402

PROJECTS_DIR = CLAUDE_HOME / "projects"

# The four counters everything downstream speaks, in transcript-field order.
_USAGE_FIELDS = ("input_tokens", "output_tokens",
                 "cache_read_input_tokens", "cache_creation_input_tokens")


# --- reading one session's transcript ----------------------------------------

def scan_session(path):
    """One transcript file -> one session summary, or None if it has no
    countable usage.

    Streams the file line by line (never loads it) with a cheap substring
    prefilter, deduplicates by message.id, and skips "<synthetic>" lines —
    those are produced locally and never hit the API. Returns:

      {"session_id", "entrypoint", "dir", "started", "finished",
       "models": {model: {"in","out","cache_r","cache_w","cache_w_1h"}},
       "skills": Counter, "messages": int}

    started/finished are tz-aware UTC datetimes of the first/last counted
    message. Never raises; unreadable files yield None.
    """
    models = {}
    skills = Counter()
    entrypoints = Counter()
    seen = set()
    first = last = None
    messages = 0
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return None

    with fh:
        for line in fh:
            if '"usage"' not in line:
                continue
            try:
                rec = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(rec, dict):
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            model = msg.get("model") or "unknown"
            if model == "<synthetic>":
                continue
            msg_id = msg.get("id")
            if msg_id:
                if msg_id in seen:
                    continue
                seen.add(msg_id)

            try:
                inp, out, cache_r, cache_w = (int(usage.get(f) or 0)
                                              for f in _USAGE_FIELDS)
            except (TypeError, ValueError):
                continue
            # The 1h/5m cache-write split is what the price formula needs
            # (1h writes cost 2x input, 5m writes 1.25x).
            cc = usage.get("cache_creation")
            cache_1h = 0
            if isinstance(cc, dict):
                try:
                    cache_1h = int(cc.get("ephemeral_1h_input_tokens") or 0)
                except (TypeError, ValueError):
                    cache_1h = 0

            slot = models.setdefault(model, {"in": 0, "out": 0, "cache_r": 0,
                                             "cache_w": 0, "cache_w_1h": 0})
            slot["in"] += inp
            slot["out"] += out
            slot["cache_r"] += cache_r
            slot["cache_w"] += cache_w
            slot["cache_w_1h"] += cache_1h
            messages += 1

            if rec.get("entrypoint"):
                entrypoints[rec["entrypoint"]] += 1
            if rec.get("attributionSkill"):
                skills[rec["attributionSkill"]] += 1
            ts = _parse_timestamp(rec.get("timestamp"))
            if ts is not None:
                first = ts if first is None or ts < first else first
                last = ts if last is None or ts > last else last

    if not models:
        return None
    return {
        "session_id": path.stem,
        "entrypoint": entrypoints.most_common(1)[0][0] if entrypoints else None,
        "dir": path.parent.name,
        "started": first,
        "finished": last,
        "models": models,
        "skills": skills,
        "messages": messages,
    }


def scan_projects(root=None, limit=None):
    """Every session summary under ~/.claude/projects, sorted for stable
    output. `limit` caps the file count for a trial run on a subset."""
    root = Path(root) if root else PROJECTS_DIR
    paths = sorted(root.rglob("*.jsonl"))
    if limit:
        paths = paths[:limit]
    out = []
    for path in paths:
        sess = scan_session(path)
        if sess is not None:
            out.append(sess)
    return out


# --- pricing, fit from her own receipts --------------------------------------

# Anthropic prices cache reads/writes as fixed multiples of the input rate
# (read 0.1x, 5-minute write 1.25x, 1-hour write 2x), which turns pricing into
# a two-unknown least-squares fit per model: rate_in and rate_out. Fitting
# against the real total_cost_usd receipts in bot_chats reproduced them to
# median error < 1% for every model with receipts (2026-08-04).
_CACHE_READ_X = 0.1
_CACHE_5M_X = 1.25
_CACHE_1H_X = 2.0


def _canonical(model):
    """Receipt model ids carry a context-window suffix ("[1m]") the transcript
    ids don't; the underlying per-token rates matched when fit separately, so
    both spellings fold to one rate key."""
    return re.sub(r"\[\w+\]$", "", model or "")


def fit_rates(chats_dir=None):
    """{canonical model: (rate_in, rate_out)} in $/token, fit from the
    `result` receipts in bot_chats. Only single-model turns are used (a
    multi-model turn's usage can't be attributed). Never raises; no receipts
    -> {}."""
    chats_dir = Path(chats_dir) if chats_dir else (store.DATA_DIR / "bot_chats")
    samples = {}  # model -> list of (weighted_input_units, output_tokens, cost)
    try:
        files = sorted(chats_dir.glob("*.jsonl"))
    except OSError:
        return {}
    for path in files:
        try:
            fh = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"total_cost_usd"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if not isinstance(rec, dict) or rec.get("type") != "result":
                    continue
                mu = rec.get("modelUsage")
                usage = rec.get("usage")
                if not (isinstance(mu, dict) and len(mu) == 1
                        and isinstance(usage, dict)):
                    continue
                try:
                    cost = float(rec.get("total_cost_usd") or 0)
                    inp = int(usage.get("input_tokens") or 0)
                    out = int(usage.get("output_tokens") or 0)
                    cache_r = int(usage.get("cache_read_input_tokens") or 0)
                    cc = usage.get("cache_creation") or {}
                    c5 = int(cc.get("ephemeral_5m_input_tokens") or 0)
                    c1 = int(cc.get("ephemeral_1h_input_tokens") or 0)
                except (TypeError, ValueError):
                    continue
                if cost <= 0:
                    continue
                units = (inp + _CACHE_READ_X * cache_r
                         + _CACHE_5M_X * c5 + _CACHE_1H_X * c1)
                samples.setdefault(_canonical(next(iter(mu))), []).append(
                    (units, out, cost))

    rates = {}
    for model, rows in samples.items():
        fit = _lstsq2(rows)
        if fit is not None:
            rates[model] = fit
    return rates


def _lstsq2(rows):
    """Least squares for cost = a*units + b*out over (units, out, cost) rows —
    the 2x2 normal equations, solved directly so there's no numpy dependency.
    Returns (a, b), or None if the system is degenerate (too few / colinear
    samples)."""
    saa = sab = sbb = sac = sbc = 0.0
    for units, out, cost in rows:
        saa += units * units
        sab += units * out
        sbb += out * out
        sac += units * cost
        sbc += out * cost
    det = saa * sbb - sab * sab
    if abs(det) < 1e-9:
        return None
    a = (sac * sbb - sbc * sab) / det
    b = (saa * sbc - sab * sac) / det
    if a < 0 or b < 0:
        return None
    return (a, b)


def price(model, counters, rates):
    """(cost_usd, priced?) for one entry's counters. Unpriced models are an
    honest zero, flagged so a $0 never reads as free."""
    fit = rates.get(_canonical(model))
    if fit is None:
        return 0.0, False
    rate_in, rate_out = fit
    cache_1h = counters.get("cache_w_1h", 0)
    cache_5m = counters.get("cache_w", 0) - cache_1h
    units = (counters.get("in", 0) + _CACHE_READ_X * counters.get("cache_r", 0)
             + _CACHE_5M_X * cache_5m + _CACHE_1H_X * cache_1h)
    return round(rate_in * units + rate_out * counters.get("out", 0), 6), True


# --- turning sessions into ledger entries ------------------------------------

def load_conv_index(chats_dir=None):
    """{claude_session_id: index entry} from the Observatory's conversation
    index — the only place lane/origin/bot exist for historical work."""
    chats_dir = Path(chats_dir) if chats_dir else (store.DATA_DIR / "bot_chats")
    try:
        raw = json.loads((chats_dir / "index.json").read_text())
    except (OSError, ValueError):
        return {}
    out = {}
    if isinstance(raw, dict):
        for conv_id, entry in raw.items():
            if isinstance(entry, dict) and entry.get("claude_session_id"):
                entry = dict(entry, conv_id=conv_id)
                out[entry["claude_session_id"]] = entry
    return out


def _local_iso(dt):
    """Transcript UTC -> the ledger's local ISO seconds, or None."""
    if dt is None:
        return None
    try:
        return dt.astimezone().isoformat(timespec="seconds")[:19]
    except (ValueError, OSError):
        return None


def entries_for(sess, rates, conv_index):
    """One session summary -> ledger entries, one per model the session ran
    on (a per-model split keeps the days fold's model attribution exact —
    a haiku title call doesn't get billed to the main model).

    Shape matches usage_ledger.entry_for's records, with the backfill's
    provenance on top: backfilled, session_id, dir, entrypoint, skill,
    priced. Lane/kind come from the conversation index where the session
    resolves there, else "unknown"/"backfill_session" — never guessed.
    """
    conv = conv_index.get(sess["session_id"], {})
    lane = conv.get("lane") or "unknown"
    kind = conv.get("origin") or ("observatory" if conv else "backfill_session")
    skill = sess["skills"].most_common(1)[0][0] if sess["skills"] else None
    started = _local_iso(sess["started"])
    finished = _local_iso(sess["finished"])

    out = []
    for model, counters in sorted(sess["models"].items()):
        cost, priced = price(model, counters, rates)
        out.append({
            "id": f"bf-{sess['session_id']}-{_canonical(model)}",
            "lane": lane,
            "kind": kind,
            "mem_class": None,
            "status": "done",
            "model": model,
            "started": started,
            "finished": finished,
            "duration_sec": None,
            "tokens": {"in": counters["in"], "out": counters["out"],
                       "cache_r": counters["cache_r"],
                       "cache_w": counters["cache_w"]},
            "cost_usd": cost,
            "priced": priced,
            "throttled": False,
            "backfilled": True,
            "session_id": sess["session_id"],
            "conv_id": conv.get("conv_id"),
            "dir": sess["dir"],
            "entrypoint": sess["entrypoint"],
            "skill": skill,
            "messages": sess["messages"],
        })
    return out


# --- the write ---------------------------------------------------------------

def backup_ledger():
    """Copy token_usage.json beside itself with a timestamp before the first
    real write. Returns the backup path, or None if there was nothing to
    back up."""
    src = store.DATA_DIR / usage_ledger.LEDGER
    if not src.exists():
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = src.with_name(f"{src.name}.bak-{stamp}")
    shutil.copy2(src, dst)
    return dst


def write_entries(entries, meta=None):
    """Append the backfill entries the ledger doesn't already have, stamp the
    backfill metadata, and delete days[] for every backfilled date so the
    next rollup() re-folds them from complete entries (the one deliberate
    exception to write_days' never-overwrite rule — a backfilled day is
    strictly more complete than what the fold knew). Returns
    (added, skipped, refold_days)."""
    added, skipped = [], []
    with store.mutate(usage_ledger.LEDGER, usage_ledger._ledger_default()) as data:
        existing = {e.get("id") for e in data.get("entries", [])
                    if isinstance(e, dict)}
        for entry in entries:
            if entry["id"] in existing:
                skipped.append(entry["id"])
            else:
                data.setdefault("entries", []).append(entry)
                added.append(entry["id"])
        refold = sorted({(e.get("finished") or "")[:10]
                         for e in entries if e.get("finished")})
        days = data.setdefault("days", {})
        refold = [d for d in refold if d in days]
        for day in refold:
            del days[day]
        if meta is not None:
            data["backfill"] = meta
    return added, skipped, refold


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Backfill token_usage.json from existing Claude Code "
                    "transcripts (sdk-cli sessions only).")
    parser.add_argument("--limit", type=int, default=None,
                        help="scan only the first N transcript files (trial run)")
    parser.add_argument("--dry-run", action="store_true",
                        help="scan and price, print the summary, write nothing")
    args = parser.parse_args(argv)

    sessions = [s for s in scan_projects(limit=args.limit)
                if s["entrypoint"] == "sdk-cli"]
    rates = fit_rates()
    conv_index = load_conv_index()
    entries = [e for s in sessions for e in entries_for(s, rates, conv_index)]

    total_tokens = sum(sum(e["tokens"].values()) for e in entries)
    total_cost = round(sum(e["cost_usd"] for e in entries), 2)
    unpriced = sorted({e["model"] for e in entries if not e["priced"]})
    print(f"scanned: {len(sessions)} sdk-cli sessions -> {len(entries)} entries, "
          f"{total_tokens / 1e9:.2f}B tokens, ${total_cost} "
          f"(rates fit for {len(rates)} models; unpriced: {', '.join(unpriced) or 'none'})")

    if args.dry_run:
        print("dry run: nothing written")
        return 0

    backup = backup_ledger()
    meta = {
        "ran": datetime.now().isoformat(timespec="seconds"),
        "source": "~/.claude/projects (entrypoint sdk-cli only, deduplicated "
                  "by message.id)",
        "coverage_note": "transcripts see ~90% of Claude Code's own /usage "
                         "request counter (retries and background calls never "
                         "reach a transcript)",
        "unpriced_models": unpriced,
        "sessions": len(sessions),
    }
    added, skipped, refold = write_entries(entries, meta)
    print(f"wrote {len(added)} entries ({len(skipped)} already present), "
          f"backup at {backup}")
    if refold:
        print(f"cleared {len(refold)} folded day(s) for refold: "
              f"{refold[0]}..{refold[-1]}")
    written, _ = usage_ledger.rollup()
    print(f"rollup folded {len(written)} day(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
