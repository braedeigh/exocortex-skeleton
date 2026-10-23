"""scripts/question_stats.py — each filed set's outcome and wait, read off the
transcripts the way the chat reads them, summed per day."""
import json

from scripts import question_stats


def _transcript(chats, conv, lines):
    chats.mkdir(parents=True, exist_ok=True)
    (chats / f"{conv}.jsonl").write_text("\n".join(json.dumps(l) for l in lines) + "\n")


def test_outcomes_and_waits_come_out_of_the_transcripts(data_dir):
    chats = data_dir / "bot_chats"
    option = {"label": "A", "detail": "", "recommended": True}
    _transcript(chats, "c1", [
        # replaced before she replied, then the new set answered 30 minutes on
        {"type": "questions", "questions": ["a?"], "ts": "2026-10-20T10:00:00"},
        {"type": "questions", "questions": ["a?", "b?"], "about": "ctx",
         "options": [[option, option], []], "ts": "2026-10-20T10:05:00"},
        # claude's tool-result echo is not her answer
        {"type": "user", "message": {"content": "tool output"}, "ts": "2026-10-20T10:10:00"},
        {"type": "user", "text": "1. A", "ts": "2026-10-20T10:35:00"},
        # withdrawn: her answer came another way
        {"type": "questions", "questions": ["c?"], "about": "ctx", "ts": "2026-10-21T09:00:00"},
        {"type": "questions-withdrawn", "questions": ["c?"], "source": "relayed", "ts": "2026-10-21T09:30:00"},
    ])
    _transcript(chats, "c2", [
        {"type": "questions", "questions": ["d?"], "ts": "2026-10-20T12:00:00"},
        {"type": "user", "text": "yes", "ts": "2026-10-20T14:00:00"},
        {"type": "questions", "questions": ["e?"], "ts": "2026-10-21T08:00:00"},   # never answered
        "not json at all",
    ])
    (chats / "c2.jsonl").write_text((chats / "c2.jsonl").read_text() + "{broken\n")

    sets = question_stats.question_sets()
    assert sorted((s["conv"], s["outcome"], s["wait_minutes"]) for s in sets) == [
        ("c1", "answered", 30.0), ("c1", "elsewhere", None), ("c1", "replaced", None),
        ("c2", "answered", 120.0), ("c2", "open", None),
    ]
    days = {row["day"]: row for row in question_stats.by_day(sets)}
    assert days["2026-10-20"] == {
        "day": "2026-10-20", "sets": 3, "questions": 4,
        "about_share": 1 / 3, "options_share": 1 / 3,
        "wait_median": 75.0, "wait_p75": 120.0,
        "answered": 2, "replaced": 1, "elsewhere": 0, "open": 0,
    }
    assert (days["2026-10-21"]["elsewhere"], days["2026-10-21"]["open"]) == (1, 1)
    assert [row["day"] for row in question_stats.by_day(sets, since="2026-10-21")] == ["2026-10-21"]
