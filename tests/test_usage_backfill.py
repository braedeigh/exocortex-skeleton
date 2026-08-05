"""scripts/usage_backfill.py — folding existing Claude Code transcripts into
the token ledger.

Same house style as test_usage_ledger.py: everything on a tmp data dir via the
`data_dir` fixture, transcripts and receipts written as small synthetic jsonl
files, nothing shells out. The pricing fit is tested by synthesizing receipts
from known rates and checking the fit recovers them — the same shape the real
derivation ran against her real receipts.
"""
import json

import store
from scripts import usage_backfill as bf
from scripts import usage_ledger


# --- building synthetic transcripts ------------------------------------------

def _assistant_line(msg_id, model="claude-opus-5", ts="2026-08-01T10:00:00.000Z",
                    inp=10, out=100, cache_r=1000, cache_w=50, cache_1h=None,
                    entrypoint="sdk-cli", skill=None):
    rec = {
        "entrypoint": entrypoint,
        "timestamp": ts,
        "message": {
            "id": msg_id, "role": "assistant", "model": model,
            "usage": {
                "input_tokens": inp, "output_tokens": out,
                "cache_read_input_tokens": cache_r,
                "cache_creation_input_tokens": cache_w,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 0,
                    "ephemeral_1h_input_tokens": cache_1h if cache_1h is not None else cache_w,
                },
            },
        },
    }
    if skill:
        rec["attributionSkill"] = skill
    return json.dumps(rec)


def _write_transcript(root, dirname, session_id, lines):
    d = root / dirname
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{session_id}.jsonl").write_text("\n".join(lines) + "\n")


# --- scan_session -------------------------------------------------------------

def test_scan_dedupes_duplicate_message_lines(tmp_path):
    _write_transcript(tmp_path, "-proj", "s1", [
        _assistant_line("m1", out=100),
        _assistant_line("m1", out=100),   # same message, second content block
        _assistant_line("m2", out=40),
    ])
    sess = bf.scan_session(tmp_path / "-proj" / "s1.jsonl")
    assert sess["models"]["claude-opus-5"]["out"] == 140
    assert sess["messages"] == 2


def test_scan_skips_synthetic_model_lines(tmp_path):
    _write_transcript(tmp_path, "-proj", "s1", [
        _assistant_line("m1", model="<synthetic>", out=999),
        _assistant_line("m2", out=5),
    ])
    sess = bf.scan_session(tmp_path / "-proj" / "s1.jsonl")
    assert list(sess["models"]) == ["claude-opus-5"]


def test_scan_splits_counters_by_model_and_collects_skill(tmp_path):
    _write_transcript(tmp_path, "-proj", "s1", [
        _assistant_line("m1", model="claude-opus-5", out=100, skill="spark"),
        _assistant_line("m2", model="claude-haiku-4-5", out=7, skill="spark"),
    ])
    sess = bf.scan_session(tmp_path / "-proj" / "s1.jsonl")
    assert sess["models"]["claude-opus-5"]["out"] == 100
    assert sess["models"]["claude-haiku-4-5"]["out"] == 7
    assert sess["skills"].most_common(1)[0][0] == "spark"


def test_scan_a_file_with_no_usage_yields_none(tmp_path):
    _write_transcript(tmp_path, "-proj", "s1", [json.dumps({"type": "user"})])
    assert bf.scan_session(tmp_path / "-proj" / "s1.jsonl") is None


def test_only_sdk_cli_sessions_survive_the_filter(tmp_path):
    _write_transcript(tmp_path, "-proj", "app", [_assistant_line("m1")])
    _write_transcript(tmp_path, "-proj", "term",
                      [_assistant_line("m2", entrypoint="cli")])
    sessions = [s for s in bf.scan_projects(root=tmp_path)
                if s["entrypoint"] == "sdk-cli"]
    assert [s["session_id"] for s in sessions] == ["app"]


# --- pricing ------------------------------------------------------------------

def _receipt(model="claude-opus-5[1m]", inp=1000, out=2000, cache_r=100000,
             c5=0, c1=20000, rate_in=5e-6, rate_out=25e-6):
    """A result record whose total_cost_usd is computed from known rates —
    the fit should recover exactly those rates."""
    cost = rate_in * (inp + 0.1 * cache_r + 1.25 * c5 + 2 * c1) + rate_out * out
    return json.dumps({
        "type": "result", "total_cost_usd": cost,
        "usage": {"input_tokens": inp, "output_tokens": out,
                  "cache_read_input_tokens": cache_r,
                  "cache_creation_input_tokens": c5 + c1,
                  "cache_creation": {"ephemeral_5m_input_tokens": c5,
                                     "ephemeral_1h_input_tokens": c1}},
        "modelUsage": {model: {}},
    })


def test_fit_recovers_the_rates_the_receipts_were_priced_at(tmp_path):
    chats = tmp_path / "bot_chats"
    chats.mkdir()
    (chats / "c1.jsonl").write_text("\n".join([
        _receipt(inp=1000, out=2000),
        _receipt(inp=50, out=9000, cache_r=2000000),
        _receipt(inp=0, out=100, cache_r=500000, c1=100000),
    ]) + "\n")
    rates = bf.fit_rates(chats_dir=chats)
    rate_in, rate_out = rates["claude-opus-5"]   # [1m] suffix folded away
    assert abs(rate_in - 5e-6) < 1e-9
    assert abs(rate_out - 25e-6) < 1e-9


def test_an_unpriced_model_costs_zero_and_says_so():
    cost, priced = bf.price("claude-sonnet-5",
                            {"in": 10, "out": 10, "cache_r": 0,
                             "cache_w": 0, "cache_w_1h": 0}, rates={})
    assert (cost, priced) == (0.0, False)


def test_pricing_uses_the_1h_5m_cache_write_split():
    rates = {"claude-opus-5": (5e-6, 25e-6)}
    counters = {"in": 0, "out": 0, "cache_r": 0,
                "cache_w": 1000, "cache_w_1h": 1000}   # all 1h -> 2x input rate
    cost_all_1h, _ = bf.price("claude-opus-5", counters, rates)
    counters["cache_w_1h"] = 0                          # all 5m -> 1.25x
    cost_all_5m, _ = bf.price("claude-opus-5", counters, rates)
    assert cost_all_1h > cost_all_5m


# --- entries ------------------------------------------------------------------

def _session(models=None, skills=None):
    import collections
    from datetime import datetime, timezone
    return {
        "session_id": "sid-1", "entrypoint": "sdk-cli", "dir": "-opt-exocortex",
        "started": datetime(2026, 8, 1, 15, 0, tzinfo=timezone.utc),
        "finished": datetime(2026, 8, 1, 16, 0, tzinfo=timezone.utc),
        "models": models or {"claude-opus-5": {"in": 1, "out": 2, "cache_r": 3,
                                               "cache_w": 4, "cache_w_1h": 4}},
        "skills": collections.Counter(skills or {}),
        "messages": 5,
    }


def test_a_session_becomes_one_entry_per_model():
    sess = _session(models={
        "claude-opus-5": {"in": 1, "out": 2, "cache_r": 3, "cache_w": 4, "cache_w_1h": 4},
        "claude-haiku-4-5": {"in": 5, "out": 6, "cache_r": 0, "cache_w": 0, "cache_w_1h": 0},
    })
    entries = bf.entries_for(sess, rates={}, conv_index={})
    assert sorted(e["model"] for e in entries) == ["claude-haiku-4-5", "claude-opus-5"]
    assert all(e["backfilled"] and e["id"].startswith("bf-sid-1-") for e in entries)


def test_lane_and_kind_come_from_the_conversation_index_or_stay_unknown():
    conv_index = {"sid-1": {"lane": "coding", "origin": "spark_morning",
                            "conv_id": "2026-08-01.050001"}}
    known = bf.entries_for(_session(), {}, conv_index)[0]
    unknown = bf.entries_for(_session(), {}, {})[0]
    assert (known["lane"], known["kind"]) == ("coding", "spark_morning")
    assert (unknown["lane"], unknown["kind"]) == ("unknown", "backfill_session")


def test_the_entry_folds_cleanly_into_a_day():
    """The whole point: entries must be food the existing fold can eat."""
    entries = bf.entries_for(_session(), rates={}, conv_index={})
    folded = usage_ledger.fold_entries(entries)
    day = folded[entries[0]["finished"][:10]]
    assert day["runs"] == 1
    assert day["models"]["claude-opus-5"]["tokens"] == 1 + 2 + 3 + 4


# --- the write ----------------------------------------------------------------

def _entry(eid="bf-s1-claude-opus-5", finished="2026-08-01T16:00:00"):
    return {"id": eid, "lane": "unknown", "model": "claude-opus-5",
            "finished": finished, "cost_usd": 1.0,
            "tokens": {"in": 1, "out": 2, "cache_r": 3, "cache_w": 4}}


def test_write_is_idempotent_across_reruns(data_dir):
    added, skipped, _ = bf.write_entries([_entry()])
    assert (len(added), len(skipped)) == (1, 0)
    added, skipped, _ = bf.write_entries([_entry()])
    assert (len(added), len(skipped)) == (0, 1)
    assert len(store.read(usage_ledger.LEDGER)["entries"]) == 1


def test_write_preserves_existing_real_entries(data_dir):
    store.write(usage_ledger.LEDGER,
                {"entries": [{"id": "rq-real", "lane": "hers"}], "days": {}})
    bf.write_entries([_entry()])
    ids = [e["id"] for e in store.read(usage_ledger.LEDGER)["entries"]]
    assert ids == ["rq-real", "bf-s1-claude-opus-5"]


def test_write_clears_backfilled_days_so_the_rollup_refolds_them(data_dir):
    """A folded day made from one entry must not block the refold that now
    knows about the whole day — the deliberate exception to never-overwrite."""
    store.write(usage_ledger.LEDGER,
                {"entries": [], "days": {"2026-08-01": {"runs": 1}}})
    _, _, refold = bf.write_entries([_entry()])
    assert refold == ["2026-08-01"]
    data = store.read(usage_ledger.LEDGER)
    assert "2026-08-01" not in data["days"]
    written, _ = usage_ledger.rollup(today="2026-08-04")
    assert "2026-08-01" in written


def test_write_leaves_unrelated_days_alone(data_dir):
    store.write(usage_ledger.LEDGER,
                {"entries": [], "days": {"2026-07-15": {"runs": 3}}})
    bf.write_entries([_entry(finished="2026-08-01T16:00:00")])
    assert store.read(usage_ledger.LEDGER)["days"]["2026-07-15"] == {"runs": 3}


def test_backup_copies_the_ledger_before_writing(data_dir):
    store.write(usage_ledger.LEDGER, {"entries": [{"id": "precious"}], "days": {}})
    backup = bf.backup_ledger()
    assert backup is not None and backup.exists()
    assert json.loads(backup.read_text())["entries"][0]["id"] == "precious"
