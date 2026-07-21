"""scripts/usage_doctor.py — the architecture-pulse aggregation.

Two layers, mirroring test_usage_rollup.py: the pure folds over a literal
`days` dict (no store), and the --devnote path through the store into the
isolated data_dir (mirroring test_research_doctor.py's devnote tests).
"""
import store
from scripts import usage_doctor as ud


def _c(reads, writes):
    return {"reads": reads, "writes": writes}


# --- window + top-N ordering -------------------------------------------------

def test_window_keeps_only_the_trailing_28_days_including_today():
    days = {
        "2026-06-22": {"api": {}},   # day 29 — out
        "2026-06-23": {"api": {}},   # day 28 — in
        "2026-07-20": {"api": {}},   # today — in
        "2026-07-21": {"api": {}},   # future junk — out
    }
    assert set(ud.window(days, "2026-07-20")) == {"2026-06-23", "2026-07-20"}


def test_top_routes_orders_by_total_ops_and_sums_across_days():
    days = {
        "2026-07-18": {"api": {"habits": _c(3, 1), "kitchen": _c(1, 0)}},
        "2026-07-19": {"api": {"habits": _c(2, 0), "todos": _c(9, 9)}},
    }
    assert ud.top_routes(days) == [
        ("todos", _c(9, 9)),
        ("habits", _c(5, 1)),
        ("kitchen", _c(1, 0)),
    ]


def test_top_routes_truncates_to_n_and_breaks_ties_by_name():
    days = {"2026-07-19": {"api": {"b": _c(1, 0), "a": _c(1, 0), "c": _c(2, 0)}}}
    assert ud.top_routes(days, n=2) == [("c", _c(2, 0)), ("a", _c(1, 0))]


def test_top_collections_sums_across_callers():
    days = {
        "2026-07-18": {"store": {"gunicorn": {"todos": _c(10, 2)},
                                 "usage_rollup": {"todos": _c(1, 0),
                                                  "places": _c(0, 5)}}},
        "2026-07-19": {"store": {"gunicorn": {"places": _c(1, 0)}}},
    }
    assert ud.top_collections(days) == [
        ("todos", _c(11, 2)),
        ("places", _c(1, 5)),
    ]


def test_caller_breakdown_gives_each_caller_its_own_top_5():
    per = {f"c{i}": _c(i, 0) for i in range(1, 8)}  # c7 busiest ... c1 quietest
    days = {"2026-07-19": {"store": {"gunicorn": per,
                                     "cron": {"todos": _c(2, 1)}}}}
    got = ud.caller_breakdown(days)
    assert list(got) == ["cron", "gunicorn"]  # callers sorted by name
    assert got["cron"] == [("todos", 3)]
    assert got["gunicorn"] == [("c7", 7), ("c6", 6), ("c5", 5), ("c4", 4), ("c3", 3)]


def test_top_tabs_pairs_visits_with_hours_seconds():
    days = {
        "2026-07-18": {"tabs": {"habits": 3}, "time": {"habits": 1800}},
        "2026-07-19": {"tabs": {"habits": 1, "kitchen": 2}, "time": {"kitchen": 60}},
    }
    assert ud.top_tabs(days) == [
        ("habits", {"visits": 4, "seconds": 1800}),
        ("kitchen", {"visits": 2, "seconds": 60}),
    ]


# --- zero-traffic diffing ----------------------------------------------------

def test_zero_traffic_routes_diffs_module_features_against_seen():
    module_features = {
        "habits": {"habits", "edges", "growth"},   # edges fired -> alive
        "travel": {"travel"},                      # nothing fired -> quiet
        "decisions": {"decisions"},                # nothing fired -> quiet
        "broken": set(),                           # no /api surface -> skipped
    }
    seen = {"edges", "kitchen"}
    assert ud.zero_traffic_routes(module_features, seen) == ["decisions", "travel"]


def test_zero_traffic_collections_diffs_known_minus_seen_minus_feature_usage():
    known = {"todos", "places", "media", "feature_usage"}
    seen = {"todos"}
    assert ud.zero_traffic_collections(known, seen) == ["media", "places"]


def test_known_collections_is_sql_collections_union_data_dir_files(data_dir):
    (data_dir / "todos.json").write_text("{}")
    (data_dir / "some_legacy_thing.json").write_text("{}")
    known = ud.known_collections()
    assert "some_legacy_thing" in known         # a file only on disk
    assert "media" in known                     # SQL-backed, no file yet
    assert set(store.SQL_COLLECTIONS) <= known


# --- the honesty line --------------------------------------------------------

def test_first_date_seen_finds_the_earliest_day_carrying_the_key():
    days = {
        "2026-07-10": {"tabs": {"habits": 1}},
        "2026-07-14": {"store": {"gunicorn": {"todos": _c(1, 0)}}},
        "2026-07-12": {"store": {"cron": {"places": _c(1, 0)}}},
    }
    assert ud.first_date_seen(days, "store") == "2026-07-12"
    assert ud.first_date_seen(days, "api") is None


def test_report_labels_zero_traffic_with_collection_start_date():
    days = {"2026-07-14": {"store": {"gunicorn": {"todos": _c(1, 0)}}}}
    report = "\n".join(ud.build_report(
        days, "2026-07-20",
        module_features={"travel": {"travel"}},
        known={"todos", "places"},
    ))
    assert "collection started 2026-07-14" in report      # store data exists
    assert "no data of this kind collected yet" in report  # api data doesn't
    assert "- travel" in report
    assert "- places" in report
    assert "- todos" not in report


# --- the real routes/ package probe ------------------------------------------

def test_route_module_features_maps_modules_to_real_api_features():
    feats = ud.route_module_features()
    assert feats["habits"] >= {"habits"}
    assert "body" in feats["food_test"]      # module name != feature name
    assert "research" in feats["research_search"]  # shared feature prefix
    assert "spa" not in feats and "shell" not in feats  # infra excluded


# --- --devnote through the store (mirrors test_research_doctor.py) -----------

def test_devnote_posts_usage_summary(data_dir):
    days = {"2026-07-19": {"api": {"habits": _c(3, 1)},
                           "store": {"gunicorn": {"todos": _c(5, 2)}}}}
    store.write("feature_usage.json", {"days": days})

    ud._post_devnote(ud.summary_line(days, "2026-07-20",
                                     module_features={"travel": {"travel"}},
                                     known={"todos"}))

    notes = store.read("dev_notes.json")["tabs"]["usage"]
    pulse_notes = [n for n in notes if n["text"].startswith("[usage] ")]
    assert len(pulse_notes) == 1
    assert "top route habits (4)" in pulse_notes[0]["text"]
    assert "top collection todos (7)" in pulse_notes[0]["text"]


def test_devnote_replaces_not_appends_and_keeps_other_notes(data_dir):
    store.write("dev_notes.json", {"tabs": {"usage": [
        {"id": "keep1", "text": "unrelated note", "created": "2026-07-01 09:00"},
        {"id": "old-pulse", "text": "[usage] stale pulse", "created": "2026-07-06 09:00"},
    ]}})

    ud._post_devnote("fresh pulse")

    notes = store.read("dev_notes.json")["tabs"]["usage"]
    pulse_notes = [n for n in notes if n["text"].startswith("[usage] ")]
    assert len(pulse_notes) == 1
    assert pulse_notes[0]["text"] == "[usage] fresh pulse"
    assert pulse_notes[0]["id"] != "old-pulse"       # replaced, not edited
    assert any(n["id"] == "keep1" for n in notes)    # unrelated note untouched
