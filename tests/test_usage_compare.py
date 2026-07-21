"""Pure-function contract for scripts/usage_compare.py (bundle validation,
top-N ordering, page-prefixed control merge, only-in-X divergence)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "scripts"))

import usage_compare as uc  # noqa: E402


def bundle(days, label=None):
    b = {"schema": "usage-export/1", "generated": "2026-07-20",
         "range": {"from": None, "to": None}, "days": days}
    if label is not None:
        b["label"] = label
    return b


# --- schema validation -------------------------------------------------------

def test_valid_bundle_accepts_the_export_shape():
    assert uc.valid_bundle(bundle({}))


def test_valid_bundle_rejects_wrong_schema_and_shapes():
    assert not uc.valid_bundle({"schema": "usage-export/2", "days": {}})
    assert not uc.valid_bundle({"days": {}})
    assert not uc.valid_bundle({"schema": "usage-export/1", "days": []})
    assert not uc.valid_bundle([])
    assert not uc.valid_bundle("nope")


def test_load_bundles_warns_and_skips_bad_files(tmp_path, capsys):
    good = tmp_path / "good.json"
    good.write_text('{"schema": "usage-export/1", "days": {}}')
    bad_schema = tmp_path / "bad.json"
    bad_schema.write_text('{"schema": "other/1", "days": {}}')
    not_json = tmp_path / "junk.json"
    not_json.write_text("{nope")
    loaded = uc.load_bundles([str(good), str(bad_schema), str(not_json),
                              str(tmp_path / "missing.json")])
    assert [label for _, label in loaded] == ["good.json"]
    err = capsys.readouterr().err
    assert err.count("warning: skipping") == 3


def test_bundle_label_prefers_label_over_filename():
    assert uc.bundle_label(bundle({}, label="fern"), "x.json") == "fern"
    assert uc.bundle_label(bundle({}), "x.json") == "x.json"
    assert uc.bundle_label(bundle({}, label="   "), "x.json") == "x.json"


# --- aggregation + top-N ordering --------------------------------------------

def test_top_tabs_orders_by_seconds_then_visits_then_name():
    days = {
        "2026-07-01": {"time": {"a": 100, "b": 500}, "tabs": {"a": 5}},
        "2026-07-02": {"time": {"a": 200, "c": 300}, "tabs": {"c": 9}},
    }
    # b leads on seconds (500); a and c tie at 300 -> c wins on visits (9 > 5).
    assert [t for t, _ in uc.top_tabs(days)] == ["b", "c", "a"]
    totals = dict(uc.top_tabs(days))
    assert totals["a"] == {"seconds": 300, "visits": 5}


def test_top_tabs_truncates_to_n():
    days = {"2026-07-01": {"time": {f"t{i}": i + 1 for i in range(12)}}}
    top = uc.top_tabs(days)
    assert len(top) == 8
    assert top[0][0] == "t11"  # biggest dwell first


def test_control_merge_is_page_prefixed_across_days():
    days = {
        "2026-07-01": {"clicks": {"journal": {"card-edit": 3},
                                  "todos": {"card-edit": 2}}},
        "2026-07-02": {"clicks": {"journal": {"card-edit": 4}}},
    }
    totals = uc.control_totals(days)
    # Same control name on different pages stays distinct; same page+control
    # merges across days.
    assert totals == {"journal/card-edit": 7, "todos/card-edit": 2}


def test_top_controls_orders_by_taps_then_name_and_caps_at_10():
    days = {"2026-07-01": {"clicks": {
        "p": {f"c{i:02d}": 5 for i in range(12)} | {"big": 99},
    }}}
    top = uc.top_controls(days)
    assert len(top) == 10
    assert top[0] == ("p/big", 99)
    # the tied-at-5 tail is alphabetical
    assert [name for name, _ in top[1:4]] == ["p/c00", "p/c01", "p/c02"]


def test_top_routes_sums_reads_and_writes():
    days = {
        "2026-07-01": {"api": {"habits": {"reads": 3, "writes": 1},
                               "todos": {"reads": 10}}},
        "2026-07-02": {"api": {"habits": {"reads": 2}}},
    }
    assert uc.top_routes(days) == [("todos", 10), ("habits", 6)]


# --- only-in-X divergence ----------------------------------------------------

def test_only_in_excludes_anything_any_other_set_has():
    sets = [{"a", "b", "c"}, {"b", "d"}, {"c"}]
    assert uc.only_in(sets) == [["a"], ["d"], []]


def test_divergence_reports_exclusive_tabs_and_controls_per_bundle():
    mine = {"2026-07-01": {"time": {"journal": 60, "wiki": 10},
                           "clicks": {"journal": {"card-edit": 1}}}}
    theirs = {"2026-07-01": {"time": {"journal": 90, "money": 20},
                             "clicks": {"money": {"row-add": 2}}}}
    div = uc.divergence([mine, theirs])
    assert div[0] == {"tabs": ["wiki"], "controls": ["journal/card-edit"]}
    assert div[1] == {"tabs": ["money"], "controls": ["money/row-add"]}


def test_build_report_labels_columns_and_lists_divergence():
    mine = bundle({"2026-07-01": {"time": {"wiki": 3600}}}, label="fern")
    theirs = bundle({"2026-07-02": {"time": {"money": 7200}}}, label="moss")
    lines = uc.build_report([mine, theirs], ["fern", "moss"])
    text = "\n".join(lines)
    assert "fern" in lines[0] and "moss" in lines[0]
    assert "only in fern:" in text and "only in moss:" in text
    assert "wiki" in text and "money" in text
