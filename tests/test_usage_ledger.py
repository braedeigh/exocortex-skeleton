"""scripts/usage_ledger.py — the receipt book: what each background run spent,
and how full the subscription was when it finished.

The /usage parser is tested against REAL captured output (2026-08-03), because
that output is human prose from an undocumented command — the only way the
parser stays honest is to pin it to what the command actually printed. Every
other dependency (token summing, the CLI itself, the clock) is injected, so
nothing here shells out or reads a real transcript.
"""
import json

import store
from scripts import usage_ledger as ledger


# Verbatim from `claude -p "/usage" --output-format json` on 2026-08-03 — the
# `result` field, newlines and all. Pinned so a shape change fails loudly here
# instead of silently zeroing the gauge in the ledger.
REAL_USAGE = (
    "You are currently using your subscription to power your Claude Code usage\n\n"
    "Current session: 13% used · resets Aug 3, 5:39pm (America/Chicago)\n"
    "Current week (all models): 12% used · resets Aug 8, 10:59pm (America/Chicago)\n"
    "Current week (Fable): 8% used · resets Aug 8, 10:59pm (America/Chicago)\n\n"
    "What's contributing to your limits usage?\n"
    "Approximate, based on local sessions on this machine.\n\n"
    "Last 24h · 855 requests · 122 sessions\n"
    "  69% of your usage was at >150k context\n"
    "Last 7d · 8,204 requests · 1,420 sessions\n"
    "  71% of your usage was at >150k context"
)


# --- the subscription gauge ---------------------------------------------------

def test_it_reads_the_three_percentages_out_of_real_usage_output():
    out = ledger.parse_usage_text(REAL_USAGE)
    assert out["session_pct"] == 13
    assert out["week_pct"] == 12
    assert out["week_by_model"] == {"all models": 12, "Fable": 8}


def test_it_reads_the_request_and_session_counts():
    out = ledger.parse_usage_text(REAL_USAGE)
    assert (out["requests_24h"], out["sessions_24h"]) == (855, 122)
    assert (out["requests_7d"], out["sessions_7d"]) == (8204, 1420)


def test_it_reads_the_reset_times():
    out = ledger.parse_usage_text(REAL_USAGE)
    assert out["session_resets"].startswith("Aug 3, 5:39pm")
    assert out["week_resets"].startswith("Aug 8, 10:59pm")


def test_a_new_model_tier_needs_no_code_change():
    text = "Current week (Cadenza): 3% used · resets Aug 8, 10:59pm (UTC)"
    assert ledger.parse_usage_text(text)["week_by_model"] == {"Cadenza": 3}


def test_unrecognizable_output_yields_nothing_rather_than_raising():
    assert ledger.parse_usage_text("the command changed shape entirely") == {}
    assert ledger.parse_usage_text("") == {}
    assert ledger.parse_usage_text(None) == {}


def test_a_snapshot_never_raises_even_when_the_reader_explodes():
    def boom():
        raise OSError("no claude on PATH")

    assert ledger.usage_snapshot(boom) == {}


# --- the throttle test --------------------------------------------------------

def test_it_recognizes_the_shapes_a_usage_limit_takes():
    for error in ("Claude usage limit reached", "429 Too Many Requests",
                  "rate_limit_error", "model overloaded"):
        assert ledger.looks_throttled(error), error


def test_an_ordinary_failure_is_not_a_throttle():
    assert not ledger.looks_throttled("FileNotFoundError: no such file")
    assert not ledger.looks_throttled(None)


# --- conversation token totals ------------------------------------------------

def _write_conv(data_dir, conv_id, records):
    path = store.DATA_DIR / "bot_chats"
    path.mkdir(parents=True, exist_ok=True)
    (path / f"{conv_id}.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in records))
    return path


def _result(out=100, cost=0.5, model="claude-sonnet-5"):
    return {"type": "result",
            "usage": {"input_tokens": 10, "output_tokens": out,
                      "cache_read_input_tokens": 900, "cache_creation_input_tokens": 5},
            "total_cost_usd": cost,
            "modelUsage": {model: {}}}


def test_it_sums_a_conversations_result_records(data_dir):
    chats = _write_conv(data_dir, "c1", [_result(out=100), _result(out=40)])
    totals = ledger.conv_totals("c1", offset=0, chats_dir=chats)
    assert totals["output"] == 140
    assert totals["cache_read"] == 1800
    assert totals["cost_usd"] == 1.0
    assert totals["model"] == "claude-sonnet-5"


def test_the_offset_excludes_turns_that_predate_the_run(data_dir):
    """A queued session may already have history. The dispatcher records the
    log's size at spawn so the receipt counts only what THIS run produced."""
    first = json.dumps(_result(out=999)) + "\n"
    chats = _write_conv(data_dir, "c2", [_result(out=999), _result(out=7)])
    totals = ledger.conv_totals("c2", offset=len(first.encode()), chats_dir=chats)
    assert totals["output"] == 7


def test_a_missing_conversation_log_yields_zeros_not_an_error(data_dir):
    totals = ledger.conv_totals("nope", offset=0)
    assert totals["total"] == 0


def test_junk_lines_are_skipped_rather_than_fatal(data_dir):
    path = store.DATA_DIR / "bot_chats"
    path.mkdir(parents=True, exist_ok=True)
    (path / "c3.jsonl").write_text("not json\n" + json.dumps(_result(out=5)) + "\n")
    assert ledger.conv_totals("c3", offset=0, chats_dir=path)["output"] == 5


# --- receipts -----------------------------------------------------------------

def _run(**extra):
    run = {"id": "r1", "lane": "research", "kind": "research_worker",
           "mem_class": "agent", "status": "done",
           "started": "2026-08-03T15:00:00", "finished": "2026-08-03T15:10:00"}
    run.update(extra)
    return run


def test_a_worker_receipt_comes_from_its_own_transcript(data_dir):
    seen = {}

    def fake_sum(sid, cwd, since=None, until=None):
        seen.update({"sid": sid, "cwd": cwd, "since": since, "until": until})
        return {"input": 1, "output": 2, "cache_read": 3, "cache_creation": 4}

    out = ledger.receipt(_run(claude_session="sid-1", claude_cwd="/tmp/w"),
                         sum_fn=fake_sum, snapshot_fn=lambda: "")
    assert out["tokens"] == {"in": 1, "out": 2, "cache_r": 3, "cache_w": 4}
    assert seen["sid"] == "sid-1"
    assert seen["since"] is not None and seen["until"] is not None


def test_an_observatory_run_falls_back_to_its_conversation_log(data_dir):
    out = ledger.receipt(
        _run(conv_id="c9", log_offset=0),
        conv_fn=lambda cid, off: {"input": 1, "output": 5, "cache_read": 0,
                                  "cache_creation": 0, "cost_usd": 2.5,
                                  "model": "claude-opus-5"},
        snapshot_fn=lambda: "")
    assert out["tokens"]["out"] == 5
    assert out["cost_usd"] == 2.5
    assert out["model"] == "claude-opus-5"


def test_a_run_with_no_token_source_still_gets_a_receipt(data_dir):
    """A zero we can see beats a run that silently vanishes from the ledger."""
    out = ledger.receipt(_run(), snapshot_fn=lambda: "")
    assert out["tokens"] == {"in": 0, "out": 0, "cache_r": 0, "cache_w": 0}
    assert out["duration_sec"] == 600.0


def test_the_receipt_carries_the_subscription_reading(data_dir):
    out = ledger.receipt(_run(), snapshot_fn=lambda: REAL_USAGE)
    assert out["usage_at_reap"]["session_pct"] == 13


def test_a_broken_token_source_degrades_to_zeros(data_dir):
    def boom(sid, cwd, since=None, until=None):
        raise OSError("transcript gone")

    out = ledger.receipt(_run(claude_session="s", claude_cwd="/tmp"),
                         sum_fn=boom, snapshot_fn=lambda: "")
    assert out["tokens"]["out"] == 0


def test_the_ledger_entry_keeps_the_fields_the_rollup_needs(data_dir):
    entry = ledger.entry_for(_run(), ledger.receipt(_run(), snapshot_fn=lambda: ""))
    assert set(entry) >= {"lane", "kind", "model", "started", "finished",
                          "tokens", "cost_usd", "throttled", "status"}


def test_appending_a_receipt_persists_it(data_dir):
    ledger.append_entry({"id": "r1", "lane": "research"})
    ledger.append_entry({"id": "r2", "lane": "night"})
    assert [e["id"] for e in store.read(ledger.LEDGER)["entries"]] == ["r1", "r2"]


def test_appending_to_a_missing_ledger_does_not_pollute_the_default(data_dir, tmp_path_factory, monkeypatch):
    """When the file doesn't exist, store.mutate fills in the DEFAULT OBJECT
    itself — so the default must be fresh per call. A shared module-level
    dict's inner list accumulated every entry ever appended to a missing
    ledger and leaked them into later reads (found 2026-08-04)."""
    ledger.append_entry({"id": "r1", "lane": "research"})
    other = tmp_path_factory.mktemp("second-install")
    monkeypatch.setattr(store, "DATA_DIR", other)
    assert store.read(ledger.LEDGER, ledger._ledger_default())["entries"] == []


# --- the daily fold -----------------------------------------------------------

def _entry(lane="research", model="sonnet", out=100, cost=1.0,
           finished="2026-08-02T23:00:00"):
    return {"id": "x", "lane": lane, "model": model, "finished": finished,
            "cost_usd": cost,
            "tokens": {"in": 10, "out": out, "cache_r": 0, "cache_w": 0}}


def test_the_fold_totals_a_day_by_lane_and_by_model():
    folded = ledger.fold_entries([
        _entry(lane="research", model="sonnet", out=100, cost=1.0),
        _entry(lane="research", model="sonnet", out=50, cost=0.5),
        _entry(lane="night", model="opus", out=200, cost=3.0),
    ])
    day = folded["2026-08-02"]
    assert day["runs"] == 3
    assert day["cost_usd"] == 4.5
    assert day["tokens"]["out"] == 350
    assert day["lanes"]["research"]["runs"] == 2
    assert day["lanes"]["night"]["cost_usd"] == 3.0
    assert day["models"]["opus"]["tokens"] == 210


def test_a_run_with_no_finish_time_is_skipped_not_guessed_at():
    assert ledger.fold_entries([_entry(finished=None)]) == {}


def test_missing_lane_and_model_fold_into_unknown():
    folded = ledger.fold_entries([_entry(lane=None, model=None)])
    day = folded["2026-08-02"]
    assert "unknown" in day["lanes"] and "unknown" in day["models"]


def test_today_is_never_written_because_it_is_still_growing(data_dir):
    written, _ = ledger.write_days(
        ledger.fold_entries([_entry(finished="2026-08-03T10:00:00")]), "2026-08-03")
    assert written == []


def test_a_day_already_rolled_up_is_never_overwritten(data_dir):
    folded = ledger.fold_entries([_entry(cost=1.0)])
    ledger.write_days(folded, "2026-08-03")
    written, skipped = ledger.write_days(
        ledger.fold_entries([_entry(cost=99.0)]), "2026-08-03")
    assert written == [] and skipped == ["2026-08-02"]
    assert store.read(ledger.LEDGER)["days"]["2026-08-02"]["cost_usd"] == 1.0


def test_rollup_reads_the_ledgers_own_entries(data_dir):
    store.write(ledger.LEDGER, {"entries": [_entry(cost=2.0)], "days": {}})
    written, _ = ledger.rollup(today="2026-08-03")
    assert written == ["2026-08-02"]
    assert store.read(ledger.LEDGER)["days"]["2026-08-02"]["runs"] == 1
