"""To-dos as typed rows (todostore.py).

The things that can silently misreport a to-do list, in order of how badly they
bite: a completion date read from the wrong one of three fields, a front tag
dropped because it isn't in the registry, and an ordering or a bucket-vs-done
state flattened away. Everything here is a version of one of those.
"""
import json

import todostore
import sqlstore
import store


def seed(buckets, fronts=None):
    """Write a todos.json shaped the way the app writes it, plus a registry."""
    store.write("todos", {name: {"items": items} for name, items in buckets.items()})
    store.write("fronts", {"fronts": fronts if fronts is not None else [
        {"id": "job", "name": "Job", "created": "2026-07-13 15:30"},
        {"id": "health", "name": "Health", "created": "2026-07-13 15:30"},
    ]})


def item(**over):
    base = {"id": "t1", "text": "Pay rent", "done": False}
    base.update(over)
    return base


def rows(sql, params=()):
    conn = sqlstore.open_db()
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


# --- the completion fold --------------------------------------------------------

def test_hand_assigned_finish_wins_over_the_tap_stamp(data_dir):
    """finished_on is her claim about when it actually happened; done_at is
    just when she tapped the box. The claim wins, and says so."""
    seed({"done": [item(done=True, finished_on="2026-07-22",
                        finished_time="07:45", done_at="2026-08-01T09:12",
                        completed="2026-08-02")]})
    todostore.rebuild()
    assert rows("SELECT finished_on, finished_time, finished_source FROM todos") \
        == [("2026-07-22", "07:45", "claimed")]


def test_tap_stamp_wins_over_the_legacy_field(data_dir):
    seed({"done": [item(done=True, done_at="2026-08-01T09:12",
                        completed="2026-06-03")]})
    todostore.rebuild()
    assert rows("SELECT finished_on, finished_time, finished_source FROM todos") \
        == [("2026-08-01", "09:12", "marked")]


def test_legacy_completed_is_read_and_labelled(data_dir):
    """66 of the finished items carry only this field — they must not vanish
    from a 'what got done' query just for being old."""
    seed({"done": [item(done=True, completed="2026-06-03")]})
    todostore.rebuild()
    assert rows("SELECT finished_on, finished_time, finished_source FROM todos") \
        == [("2026-06-03", None, "legacy")]


def test_day_only_done_at_yields_no_invented_time(data_dir):
    """A day-only stamp has no minute in it. Reporting midnight would be a
    confident wrong answer rather than a missing one."""
    seed({"done": [item(done=True, done_at="2026-06-15")]})
    todostore.rebuild()
    assert rows("SELECT finished_on, finished_time FROM todos") == [("2026-06-15", None)]


def test_unfinished_todo_has_no_completion_at_all(data_dir):
    seed({"now": [item()]})
    todostore.rebuild()
    assert rows("SELECT finished_on, finished_time, finished_source FROM todos") \
        == [(None, None, None)]


# --- fronts ---------------------------------------------------------------------

def test_front_tags_become_joinable_rows(data_dir):
    seed({"now": [item(fronts=["job", "health"])]})
    todostore.rebuild()
    assert {r[0] for r in rows("SELECT front FROM todo_fronts WHERE todo_id = 't1'")} \
        == {"job", "health"}


def test_unregistered_front_is_kept_and_flagged(data_dir):
    """'life'/'admin'/'work' were retired from the registry but still ride old
    items. Dropping them would lose data; the flag makes the drift queryable."""
    seed({"done": [item(done=True, fronts=["admin"])]})
    todostore.rebuild()
    assert rows("SELECT id, name, registered FROM fronts WHERE id = 'admin'") \
        == [("admin", "admin", 0)]
    assert rows("SELECT front FROM todo_fronts") == [("admin",)]


def test_registered_front_with_no_todos_still_listed(data_dir):
    """The dropdown needs the empty ones too."""
    seed({"now": [item(fronts=["job"])]})
    todostore.rebuild()
    health = [f for f in todostore.by_front() if f["id"] == "health"]
    assert health == [{"id": "health", "name": "Health", "registered": True,
                       "total": 0, "finished": 0, "live": 0}]


def test_by_front_splits_live_from_finished(data_dir):
    seed({"now": [item(id="a", fronts=["job"])],
          "done": [item(id="b", done=True, completed="2026-06-03", fronts=["job"])]})
    todostore.rebuild()
    job = [f for f in todostore.by_front() if f["id"] == "job"][0]
    assert (job["total"], job["live"], job["finished"]) == (2, 1, 1)


def test_duplicate_front_on_one_todo_collapses(data_dir):
    seed({"now": [item(fronts=["job", "job"])]})
    todostore.rebuild()
    assert rows("SELECT COUNT(*) FROM todo_fronts") == [(1,)]


# --- identity, bucket, order ----------------------------------------------------

def test_bucket_is_an_attribute_not_the_identity(data_dir):
    """The same id in `done` after a move is the same row — its history
    survives the move, which is the whole reason for a stable key."""
    seed({"up_next": [item(id="t1")]})
    todostore.rebuild()
    assert rows("SELECT bucket FROM todos WHERE id = 't1'") == [("up_next",)]
    seed({"done": [item(id="t1", done=True, completed="2026-08-02")]})
    todostore.rebuild()
    assert rows("SELECT bucket, done FROM todos WHERE id = 't1'") == [("done", 1)]


def test_done_flag_and_bucket_can_disagree(data_dir):
    """One live item is currently done:true while still sitting in `now` — the
    sweep only archives yesterday's. Neither column may be derived from the
    other."""
    seed({"now": [item(done=True, done_at="2026-08-08T10:00")]})
    todostore.rebuild()
    assert rows("SELECT bucket, done FROM todos") == [("now", 1)]


def test_manual_order_is_carried(data_dir):
    """Her ordering lives only as array position in the blob; it has to be a
    column or it's lost the moment rows leave the list."""
    seed({"now": [item(id="a"), item(id="b"), item(id="c")]})
    todostore.rebuild()
    assert rows("SELECT id FROM todos WHERE bucket = 'now' ORDER BY position") \
        == [("a",), ("b",), ("c",)]


def test_item_without_an_id_is_skipped_not_invented(data_dir):
    """No id means no identity — a generated one would differ every rebuild."""
    seed({"now": [item(id="a"), {"text": "orphan", "done": False}]})
    result = todostore.rebuild()
    assert result["skipped"] == 1
    assert rows("SELECT id FROM todos") == [("a",)]


def test_rebuild_is_idempotent(data_dir):
    seed({"now": [item(fronts=["job"], subtasks=[{"id": "s", "text": "x", "done": True}])]})
    first = todostore.rebuild()
    second = todostore.rebuild()
    assert first == second
    assert rows("SELECT COUNT(*) FROM todos") == [(1,)]
    assert rows("SELECT COUNT(*) FROM todo_fronts") == [(1,)]


def test_rebuild_drops_rows_for_deleted_todos(data_dir):
    """A to-do gone from the blob is a deletion she made, not an incident —
    unlike the card pool, the mirror simply stops carrying it."""
    seed({"now": [item(id="a"), item(id="b")]})
    todostore.rebuild()
    seed({"now": [item(id="a")]})
    todostore.rebuild()
    assert rows("SELECT id FROM todos") == [("a",)]


# --- subtasks -------------------------------------------------------------------

def test_subtasks_keep_their_order_and_done_state(data_dir):
    seed({"now": [item(subtasks=[
        {"id": "sd_desk", "text": "Desk", "done": True},
        {"id": "sd_monitor", "text": "Monitor", "done": False},
    ])]})
    todostore.rebuild()
    assert rows("SELECT position, subtask_id, text, done FROM todo_subtasks"
                " ORDER BY position") == [
        (0, "sd_desk", "Desk", 1), (1, "sd_monitor", "Monitor", 0)]


# --- the queries ----------------------------------------------------------------

def test_finished_between_spans_all_three_completion_fields(data_dir):
    """The query the blob can't answer without knowing every field name."""
    seed({"done": [
        item(id="a", done=True, finished_on="2026-07-02"),
        item(id="b", done=True, done_at="2026-07-15T08:00"),
        item(id="c", done=True, completed="2026-07-28"),
        item(id="d", done=True, completed="2026-06-30"),   # outside the window
    ]})
    todostore.rebuild()
    got = todostore.finished_between("2026-07-01", "2026-07-31")
    assert [r["id"] for r in got] == ["c", "b", "a"]


def test_finished_between_can_filter_to_her_own_claims(data_dir):
    seed({"done": [item(id="a", done=True, finished_on="2026-07-02"),
                   item(id="b", done=True, done_at="2026-07-15T08:00")]})
    todostore.rebuild()
    got = todostore.finished_between("2026-07-01", "2026-07-31", source="claimed")
    assert [r["id"] for r in got] == ["a"]


def test_finished_between_carries_the_fronts(data_dir):
    seed({"done": [item(done=True, completed="2026-07-10", fronts=["job", "health"])]})
    todostore.rebuild()
    assert sorted(todostore.finished_between("2026-07-01", "2026-07-31")[0]["fronts"]) \
        == ["health", "job"]


def test_aging_lists_oldest_first_and_excludes_finished(data_dir):
    seed({"now": [item(id="old", created="2026-06-01"),
                  item(id="new", created="2026-08-01")],
          "done": [item(id="gone", done=True, created="2026-05-01",
                        completed="2026-06-03")]})
    todostore.rebuild()
    assert [r["id"] for r in todostore.aging()] == ["old", "new"]


def test_aging_reports_unknown_age_as_none_and_sorts_it_last(data_dir):
    """'arrived today' and 'we don't know when this arrived' are different
    answers — 54% of the older items carry no created date."""
    seed({"now": [item(id="dated", created="2026-06-01"), item(id="undated")]})
    todostore.rebuild()
    got = todostore.aging()
    assert [r["id"] for r in got] == ["dated", "undated"]
    assert got[1]["age_days"] is None
    assert got[0]["age_days"] > 0


def test_aging_can_narrow_to_one_bucket(data_dir):
    seed({"now": [item(id="a", created="2026-06-01")],
          "up_next": [item(id="b", created="2026-05-01")]})
    todostore.rebuild()
    assert [r["id"] for r in todostore.aging(bucket="now")] == ["a"]


# --- tolerance ------------------------------------------------------------------

def test_malformed_blob_does_not_raise(data_dir):
    """Written straight to disk, bypassing store.write: schemas/todos.json
    rejects these shapes, so the app itself can't produce one. A hand-edited
    file or an outside writer still can, and a mirror that raises on it would
    take the hourly cron down over a stray line."""
    store.file_path("todos").write_text(json.dumps(
        {"now": "not a section", "up_next": {"items": "nope"},
         "later": {"items": [item(id="ok"), "junk"]}}))
    store.write("fronts", {})
    assert todostore.rebuild()["todos"] == 1
    assert rows("SELECT id FROM todos") == [("ok",)]


def test_blank_fields_become_null_not_empty_string(data_dir):
    """So a query can say `IS NOT NULL` and mean it."""
    seed({"now": [item(notes="", due_by="   ", created="2026-06-01")]})
    todostore.rebuild()
    assert rows("SELECT notes, due_by FROM todos") == [(None, None)]


def test_duplicate_id_across_buckets_keeps_the_first(data_dir):
    """Ids are unique in the live blob; if that ever breaks, the row must not
    be silently overwritten by whichever bucket sorts last."""
    seed({"later": [item(id="dup", text="from later")],
          "now": [item(id="dup", text="from now")]})
    result = todostore.rebuild()
    assert result["skipped"] == 1
    # Buckets are walked in sorted name order: 'later' before 'now'.
    assert rows("SELECT bucket, text FROM todos") == [("later", "from later")]
