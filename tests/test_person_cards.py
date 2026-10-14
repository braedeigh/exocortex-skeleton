"""scripts/person_cards.py — the fact-sheet reader for one person.

Each test builds a small made-up vault and card mirror in a temp database,
then runs the script's own `main` and reads what it prints.
"""
import importlib.util
import json
from pathlib import Path

import pytest

import sqlstore
import store

_spec = importlib.util.spec_from_file_location(
    "person_cards", Path(__file__).resolve().parents[1] / "scripts" / "person_cards.py")
person_cards = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(person_cards)


def add_card(conn, card_id, body, who="B", tags=()):
    day = card_id[:10]
    ts = f"{day} {card_id[11:13]}:{card_id[13:15]}:00"
    conn.execute(
        "INSERT INTO cards (id, day, ts, who, kind, body, first_seen, last_seen)"
        " VALUES (?, ?, ?, ?, 'line', ?, 'x', 'x')", (card_id, day, ts, who, body))
    for tag in tags:
        conn.execute("INSERT INTO card_tags (card_id, tag) VALUES (?, ?)", (card_id, tag))


def make_vault(data_dir, tmp_path, monkeypatch, people):
    content = tmp_path / "content"
    (content / "people").mkdir(parents=True)
    for slug, text in people.items():
        (content / "people" / f"{slug}.md").write_text(text)
    monkeypatch.setattr(store, "CONTENT_DIR", content)
    return content


def run(capsys, *argv):
    code = person_cards.main(list(argv))
    out = capsys.readouterr()
    return code, out.out, out.err


def test_tagged_named_and_alias_cards_in_full_oldest_first(data_dir, tmp_path, monkeypatch, capsys):
    make_vault(data_dir, tmp_path, monkeypatch, {
        "robin": "---\naliases: [my landlord]\n---\n# Robin Vale\n\nMade up.\n"})
    long_body = "Robin texted about the deposit. " + "more words " * 300
    conn = sqlstore.open_db()
    add_card(conn, "2026-03-22.0900b", "my landlord came by again")
    add_card(conn, "2026-03-20.0900b", long_body)
    add_card(conn, "2026-03-21.0900b", "he still hasn't fixed the sink", tags=["robin"])
    add_card(conn, "2026-03-23.0900k", "Robin sounds stressed", who="K")
    add_card(conn, "2026-03-24.0900b", "watched a robinson crusoe film")
    conn.commit()
    conn.close()

    code, out, _ = run(capsys, "robin", "--json")
    report = json.loads(out)
    assert code == 0
    assert [c["id"] for c in report["cards"]] == [
        "2026-03-20.0900b", "2026-03-21.0900b", "2026-03-22.0900b"]
    assert [c["matched"] for c in report["cards"]] == ["text", "tag", "text"]
    assert report["cards"][0]["body"] == long_body
    assert report["file"].endswith("people/robin.md")
    assert report["same_name"] == []

    code, out, _ = run(capsys, "robin", "--since", "2026-03-21")
    assert "2026-03-20.0900b" not in out and "2026-03-21.0900b" in out


def test_two_people_sharing_a_first_name_stay_apart(data_dir, tmp_path, monkeypatch, capsys):
    make_vault(data_dir, tmp_path, monkeypatch, {
        "sam": "# Sam\n\nMade up.\n", "sam-okafor": "# Sam Okafor\n\nMade up.\n"})
    conn = sqlstore.open_db()
    add_card(conn, "2026-03-20.0900b", "lunch with the first one", tags=["sam"])
    add_card(conn, "2026-03-21.0900b", "lunch with the second one", tags=["sam-okafor"])
    add_card(conn, "2026-03-22.0900b", "Sam called today")
    conn.commit()
    conn.close()

    _, out, _ = run(capsys, "sam", "--json")
    first = json.loads(out)
    _, out, _ = run(capsys, "sam-okafor", "--json")
    second = json.loads(out)
    assert [c["id"] for c in first["cards"]] == ["2026-03-20.0900b"]
    assert [c["id"] for c in second["cards"]] == ["2026-03-21.0900b"]
    assert [o["slug"] for o in first["same_name"]] == ["sam-okafor"]
    assert first["same_name"][0]["file"].endswith("people/sam-okafor.md")
    assert [o["slug"] for o in second["same_name"]] == ["sam"]
    assert "sam" in [t.lower() for t in first["untrusted_terms"]]


def test_unknown_slug_exits_two(data_dir, tmp_path, monkeypatch, capsys):
    make_vault(data_dir, tmp_path, monkeypatch, {"robin": "# Robin\n"})
    code, out, err = run(capsys, "nobody")
    assert code == 2 and out == "" and "nobody" in err
