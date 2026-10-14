"""The build log — everything planned, built, or decided against.

These go through the door a session really uses (`scripts/build_log.py`)
against a fresh database, and read the result back through `buildlog.py`.
"""
import importlib.util
from datetime import date
from pathlib import Path

import buildlog

_spec = importlib.util.spec_from_file_location(
    "build_log", Path(__file__).resolve().parents[1] / "scripts" / "build_log.py")
door = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(door)

OLD_FILE = """# Build TODO

## 🟡 The pond counts cards, not hours (hers, 2026-08-12)

The pond sizes topics by card count.

### Addendum — 2026-08-14

Hours would be better.

## ✅ FIXED 2026-07-29 (Beck, spinoff `gate`) — the gate blocked the CLI

Fixed in abc1234.

## Receipts "all dated 2026-06-01" — they were test fakes (found 2026-09-24 by the Keeper)

Deleted.

## Money tab

- a line with no heading facts at all
"""


def test_an_item_lives_through_the_log_from_idea_to_shipped(data_dir, capsys):
    assert door.main(["add", "--title", "Export the log", "--by", "spark", "--status", "idea",
                      "--body", "A *markdown* write-up."]) == 0
    item = buildlog.items()[0]
    assert (item["title"], item["status"], item["raised_on"]) == (
        "Export the log", "idea", date.today().isoformat())

    assert door.main(["note", str(item["id"]), "--by", "keeper", "--text", "she wants a CSV"]) == 0
    assert door.main(["status", str(item["id"]), "shipped", "--by", "spark", "--why", "abc1234"]) == 0

    shipped = buildlog.get(item["id"])
    assert shipped["closed_on"] == date.today().isoformat()
    assert [(n["kind"], n["text"]) for n in shipped["notes"]] == [
        ("note", "she wants a CSV"), ("status", "idea → shipped: abc1234")]
    # Closed items leave the default list but stay in the log, findable by their notes.
    assert buildlog.items() == []
    assert [i["id"] for i in buildlog.items(buildlog.STATUSES, search="csv")] == [item["id"]]

    # Reopening clears the closing day.
    door.main(["status", str(item["id"]), "open", "--by", "hers"])
    assert buildlog.get(item["id"])["closed_on"] is None


def test_the_old_markdown_moves_in_whole_and_only_once(data_dir):
    assert buildlog.import_markdown(OLD_FILE) == 4
    found = buildlog.items(buildlog.STATUSES)
    by_title = {item["title"][:16]: item for item in found}

    pond = by_title["The pond counts "]
    assert (pond["status"], pond["raised_by"], pond["raised_on"]) == ("open", "hers", "2026-08-12")
    assert "### Addendum — 2026-08-14\n\nHours would be better." in pond["body"]

    fixed = by_title["FIXED 2026-07-29"]
    assert (fixed["status"], fixed["raised_by"], fixed["closed_on"]) == ("shipped", "Beck", "2026-07-29")

    # A day inside the title isn't the day it was raised.
    receipts = by_title['Receipts "all da']
    assert (receipts["raised_on"], receipts["raised_by"]) == ("2026-09-24", "Keeper")

    money = by_title["Money tab"]
    assert (money["raised_on"], money["raised_by"]) == (None, "unknown")

    # The bottom of the file is the oldest, so it gets the lowest number.
    assert money["id"] < pond["id"]
    assert money["source"] == "dev_todo.md:19"

    try:
        buildlog.import_markdown(OLD_FILE)
    except ValueError as error:
        assert "already imported" in str(error)
    assert len(buildlog.items(buildlog.STATUSES)) == 4


def test_the_door_refuses_what_does_not_belong_in_the_log(data_dir, capsys):
    assert door.main(["add", "--title", "  ", "--by", "spark"]) == 2
    assert door.main(["add", "--title", "x", "--by", "spark", "--raised-on", "last week"]) == 2
    assert door.main(["note", "99", "--by", "spark", "--text", "orphan"]) == 2
    assert door.main(["status", "99", "shipped", "--by", "spark"]) == 2
    assert "no build item #99" in capsys.readouterr().err
    assert buildlog.items(buildlog.STATUSES) == []


def test_an_import_that_fails_partway_leaves_nothing_behind(data_dir, monkeypatch):
    """Regression. exo.db connections commit each statement on their own, so
    the first live import, stopped by a locked database, left 29 of 78 rows
    behind. The whole move is one write now."""
    real = buildlog.parse_heading
    calls = []

    def fails_on_the_third(heading):
        calls.append(heading)
        if len(calls) == 3:
            raise RuntimeError("stopped partway")
        return real(heading)

    monkeypatch.setattr(buildlog, "parse_heading", fails_on_the_third)
    try:
        buildlog.import_markdown(OLD_FILE)
    except RuntimeError:
        pass
    assert buildlog.items(buildlog.STATUSES) == []
