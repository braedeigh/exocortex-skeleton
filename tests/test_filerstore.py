"""filerstore.py — the filer's nomination + verdict provenance tables.

Isolated per-test via the `data_dir` fixture (store.DATA_DIR -> tmp_path), so
each test gets its own exo.db, mirroring tests/test_jobstore.py.

The two most important tests here both guard the same thing — that a decision
the owner made by hand can never be lost, because it is the ground truth a model
is meant to be trained on later and nothing can regenerate it:

  - `test_rule_raises_rather_than_swallowing` — unlike every other write in the
    module, her verdict must never fail quietly.
  - `test_a_changed_mind_keeps_both_verdicts` — a reversal is signal, not a
    correction to apply over the top of the old row.
"""
import json

import pytest

import filerstore
import sqlstore
import store


@pytest.fixture
def db(data_dir):
    """A migrated database in the isolated data dir."""
    sqlstore.open_db().close()
    return data_dir


def noms():
    conn = sqlstore.open_db()
    try:
        cols = ["id", "run_id", "file_id", "path", "sha256", "observed",
                "model", "saw", "proposal", "reasoning", "confidence",
                "alternatives", "verdict", "applied", "applied_at"]
        return [dict(zip(cols, r)) for r in conn.execute(
            f"SELECT {', '.join(cols)} FROM filer_nominations ORDER BY id"
        ).fetchall()]
    finally:
        conn.close()


def verdicts():
    conn = sqlstore.open_db()
    try:
        cols = ["id", "nomination_id", "verdict", "at", "by", "note",
                "corrected"]
        return [dict(zip(cols, r)) for r in conn.execute(
            f"SELECT {', '.join(cols)} FROM filer_verdicts ORDER BY id"
        ).fetchall()]
    finally:
        conn.close()


def a_nomination(**kw):
    kw.setdefault("path", "uploads-archive/20260725_IMG_2801.png")
    kw.setdefault("proposal", {"destination": "housing", "front": "Living space"})
    kw.setdefault("reasoning", "a residential lease agreement for the address")
    kw.setdefault("confidence", 0.91)
    kw.setdefault("alternatives", [{"destination": "documents", "score": 0.06}])
    kw.setdefault("model", "claude-sonnet-5")
    kw.setdefault("saw", "a 12-page PDF titled 4204 Speedway 202")
    return filerstore.nominate(**kw)


# --- what the machine proposed --------------------------------------------

def test_a_nomination_starts_pending(db):
    nid = a_nomination()
    (row,) = noms()
    assert row["id"] == nid
    assert row["verdict"] == "pending"
    assert row["applied"] == 0


def test_structured_columns_round_trip_as_objects(db):
    a_nomination()
    (queued,) = filerstore.pending()
    assert queued["proposal"]["destination"] == "housing"
    assert queued["alternatives"][0]["destination"] == "documents"


def test_the_rejected_alternatives_are_kept(db):
    """The runner-up is where the decision boundary lives — it is free to store
    now and unrecoverable later."""
    a_nomination(alternatives=[{"destination": "money", "score": 0.31},
                               {"destination": "documents", "score": 0.06}])
    (row,) = noms()
    assert len(json.loads(row["alternatives"])) == 2


def test_nominate_returns_none_instead_of_raising(db, monkeypatch):
    """A recording failure must not take the filer run down with it — the
    caller counts the None as a failure on its jobstore recorder."""
    monkeypatch.setattr(sqlstore, "open_db",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no db")))
    assert a_nomination() is None


# --- what she decided ------------------------------------------------------

def test_ruling_appends_and_updates_the_cached_verdict(db):
    nid = a_nomination()
    filerstore.rule(nid, "accepted", note="yes, that's the lease")
    (v,) = verdicts()
    assert v["nomination_id"] == nid and v["verdict"] == "accepted"
    assert v["by"] == "her"
    assert noms()[0]["verdict"] == "accepted"


def test_a_redirect_records_where_it_should_have_gone(db):
    """The richest row in either table: the wrong answer and the right one."""
    nid = a_nomination()
    filerstore.rule(nid, "redirected", note="that's the deposit, it goes in money",
                    corrected={"destination": "money"})
    (v,) = verdicts()
    assert json.loads(v["corrected"])["destination"] == "money"
    assert noms()[0]["verdict"] == "redirected"


def test_a_redirect_must_say_where(db):
    nid = a_nomination()
    with pytest.raises(ValueError):
        filerstore.rule(nid, "redirected", note="wrong")


def test_unknown_verdicts_are_refused(db):
    nid = a_nomination()
    with pytest.raises(ValueError):
        filerstore.rule(nid, "maybe")


def test_rule_raises_rather_than_swallowing(db):
    """Her verdict has no second copy anywhere. Losing one quietly is the exact
    failure this module exists to prevent, so this write — alone in the file —
    is allowed to blow up."""
    with pytest.raises(KeyError):
        filerstore.rule(9999, "accepted")


def test_a_changed_mind_keeps_both_verdicts(db):
    """A reversal is signal. The old ruling stays on the record and the newest
    one wins."""
    nid = a_nomination()
    filerstore.rule(nid, "rejected", note="no")
    filerstore.rule(nid, "accepted", note="actually yes")
    assert [v["verdict"] for v in verdicts()] == ["rejected", "accepted"]
    assert noms()[0]["verdict"] == "accepted"
    (trained,) = filerstore.training_set()
    assert trained["verdict"] == "accepted"


# --- applied is not the same as accepted ----------------------------------

def test_applying_is_tracked_apart_from_the_verdict(db):
    """Accepted-but-not-yet-moved is a real state; conflating them is how a
    crash between her tap and the move becomes invisible."""
    nid = a_nomination()
    filerstore.rule(nid, "accepted")
    assert noms()[0]["applied"] == 0
    filerstore.mark_applied(nid, new_path="housing/lease.pdf")
    row = noms()[0]
    assert row["applied"] == 1 and row["applied_at"]
    assert row["path"] == "housing/lease.pdf"


# --- the review queue and the training set ---------------------------------

def test_pending_holds_only_unruled_nominations(db):
    first = a_nomination(path="a.png")
    a_nomination(path="b.png")
    assert len(filerstore.pending()) == 2
    filerstore.rule(first, "accepted")
    assert [n["path"] for n in filerstore.pending()] == ["b.png"]


def test_training_set_can_exclude_machine_verdicts(db):
    """A machine agreeing with another machine is not ground truth, which is
    the whole reason `by` is a column."""
    hers = a_nomination(path="hers.png")
    its = a_nomination(path="its.png")
    filerstore.rule(hers, "accepted")
    filerstore.rule(its, "accepted", by="nightcrew")
    assert [r["path"] for r in filerstore.training_set()] == ["hers.png"]
    both = filerstore.training_set(only_hers=False)
    assert len(both) == 2


def test_training_set_skips_nominations_she_never_ruled_on(db):
    a_nomination()
    assert filerstore.training_set() == []


# --- the mirror that is these tables' only backup -------------------------

def test_export_day_writes_both_tables(db):
    nid = a_nomination()
    filerstore.rule(nid, "redirected", corrected={"destination": "money"})
    day = noms()[0]["observed"][:10]

    written = filerstore.export_day(day)
    assert written == 2   # one nomination + one verdict

    path = store.DATA_DIR / filerstore.MIRROR_DIR / f"{day}.json"
    payload = json.loads(path.read_text())
    assert payload["day"] == day
    assert len(payload["nominations"]) == 1
    assert len(payload["verdicts"]) == 1
    assert payload["nominations"][0]["path"].endswith("IMG_2801.png")


def test_export_day_is_empty_for_a_quiet_day(db):
    assert filerstore.export_day("2020-01-01") == 0
