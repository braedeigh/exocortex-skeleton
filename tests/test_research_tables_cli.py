"""Behavioral tests for scripts/research_tables.py — the agents' door for
research tables. The ones that matter most: a number with a passage the source
doesn't contain is refused and leaves nothing behind, and nothing an agent
writes arrives reviewed.
"""
import importlib.util
import os

import pytest

import foodstore
import hazardstore
import sqlstore
import store

_SCRIPTS_PATH = os.path.join(os.path.dirname(__file__), "..", "scripts", "research_tables.py")
_spec = importlib.util.spec_from_file_location("research_tables_cli", _SCRIPTS_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
main = _mod.main

SOURCE = "2026-09-24.1000"


@pytest.fixture
def seeded(data_dir):
    store.write("research.json", {
        "topics": [],
        "entries": [{"id": SOURCE, "kind": "source",
                     "text": "Chlorpropham was found in 89.1% of potato samples.",
                     "topics": [], "url": "https://example.org", "verdict": "", "status": "",
                     "reply_to": None, "created": "2026-09-24 10:00"}],
        "sessions": [],
    })
    foodstore.add_food("potatoes")
    hazardstore.seed_starter_map()
    hazardstore.add_hazard("Chlorpropham", parents=["Plant growth regulator"])
    return data_dir


def count(sql):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql).fetchone()[0]
    finally:
        conn.close()


def measure_args(*extra):
    return ["measure", "--food", "potatoes", "--hazard", "chlorpropham",
            "--measure", "detection_rate", "--amount", "89.1", "--unit", "%",
            "--source", SOURCE, *extra]


def test_measure_with_a_real_passage_lands_unreviewed_with_its_highlight(seeded, capsys):
    assert main(measure_args("--passage", "found in 89.1% of potato samples")) == 0
    measure_id = int(capsys.readouterr().out.split()[1])
    detail = hazardstore.measure_detail(measure_id)
    assert detail["review"] == "unreviewed" and detail["author"] == "llm"
    assert detail["passage"]["exact"] == "found in 89.1% of potato samples"


def test_a_passage_the_source_lacks_is_refused_and_leaves_nothing(seeded, capsys):
    assert main(measure_args("--passage", "found in 95% of samples")) == 1
    assert "passage not found" in capsys.readouterr().err
    assert count("SELECT COUNT(*) FROM hazard_measures") == 0
    assert count("SELECT COUNT(*) FROM research_annotations") == 0


def test_an_unknown_food_is_refused_before_any_highlight(seeded, capsys):
    args = measure_args("--passage", "found in 89.1% of potato samples")
    args[args.index("potatoes")] = "rutabaga"
    assert main(args) == 1
    assert count("SELECT COUNT(*) FROM research_annotations") == 0


def test_judge_with_ground(seeded, capsys):
    main(measure_args())
    measure_id = capsys.readouterr().out.split()[1]
    assert main(["judge", "--food", "potatoes", "--lens", "health", "--verdict", "organic",
                 "--reasoning", "post-harvest residue", "--ground", measure_id]) == 0
    assert capsys.readouterr().out.startswith("created")


def test_gaps_lists_what_is_still_empty(seeded, capsys):
    table_id = hazardstore.add_table("Pesticides", "measures", hazard="Pesticide")
    main(measure_args())
    capsys.readouterr()
    assert main(["show-table", str(table_id), "--gaps"]) == 0
    out = capsys.readouterr().out
    assert "Herbicide" in out and "Plant growth regulator" not in out
