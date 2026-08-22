"""What the filer proposed, and what she decided about it — the training record.

**What this file is for.** A filer agent looks at a file, works out where it
belongs, and *proposes* a home for it. It never moves anything on its own. This
module writes down both halves of that exchange: the machine's proposal (what it
saw, where it wanted to put it, why, how sure it was, and what it considered and
rejected) and her ruling on it (accept / reject / redirect, and for a redirect,
where it should have gone).

**Why it's built this way.** The stated purpose is to train a model on her filing
decisions eventually. That goal changes the design in three places:

  - **The rejections are the point.** A record of only the accepted proposals has
    no negative examples in it, so it can't teach where the boundary is. A
    *redirect* is the richest row of all: it carries the wrong answer and the
    right one together.
  - **Verdicts are append-only.** She's allowed to change her mind, and the
    change is itself signal, so a new ruling writes a new row in
    `filer_verdicts` instead of overwriting the old one.
  - **What it considered and rejected gets stored too.** The runner-up is where
    the decision boundary lives. It's free to record now and unrecoverable later.

**Who it talks to.** Tables live in `sqlstore.py` (rung 13, which has the full
column-by-column reasoning). Runs are recorded by `jobstore.py` and joined here
through `run_id`, so "what did the filer do on the 4th" is one query. File
identity comes from `codestore.py`'s `files` table — path is an attribute there,
not identity, so a nomination survives the move it proposed.

**Two rules that differ from jobstore on purpose:**

  - `nominate()` swallows and returns None, the same as jobstore — a recording
    failure shouldn't kill the run. But `rule()` **raises**. Her verdict is
    ground truth and there is no second copy of it anywhere; losing one quietly
    is the exact failure this whole module exists to prevent.
  - **There is no `prune()`.** `job_runs` ages out at 180 days because it's
    operational telemetry. This is a training set, and it only gets more
    valuable with age.

Prompt that produced this file: "retain as much information about my decisions
and what it does so that I can train ML on it eventually ... whatever best
practices are that gets me the most and best organized data".
"""
from datetime import datetime
import hashlib
import json
import sys

import sqlstore
import store

# Where export_day() writes the JSON mirrors, under the data dir. Same job as
# jobstore's MIRROR_DIR: these tables are not derived from anything, so the
# vault's hourly git commit is the only real backup they have.
MIRROR_DIR = "filer"

_NOTE_MAX = 2000


def _now():
    """This system's clock: LOCAL, naive, second resolution — matching
    `job_runs.started`, `cards.ts` and `commits.authored_at`. Deliberately not
    UTC: `session_files.last` is UTC, and mixing the two draws a day's work five
    hours off the axis while looking entirely plausible."""
    return datetime.now().replace(microsecond=0).isoformat(sep="T")


def _clip(text):
    if text is None:
        return None
    text = str(text).strip()
    return text[:_NOTE_MAX] if text else None


def _json(obj):
    """Structured columns are JSON text. A value that won't serialize is stored
    as None rather than raising — a nomination with a missing `alternatives` is
    still worth having."""
    if obj is None:
        return None
    try:
        return json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        return None


def sha256_of(path):
    """Content identity for a file on disk, or None if it can't be read.

    Stored beside the path because the duplicate problem in the uploads archive
    is one photo arriving three times under three server-generated names — only
    the bytes tie those together.
    """
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def nominate(path, proposal, run_id=None, file_id=None, sha256=None,
             model=None, saw=None, reasoning=None, confidence=None,
             alternatives=None):
    """Record one proposal. Returns the nomination id, or None if recording
    failed.

    Returning None rather than raising is deliberate and matches jobstore: a
    filer that dies because its bookkeeping failed is worse than a filer with a
    missing row. The caller should count a None as a failure on its jobstore
    recorder so the gap is visible rather than silent.
    """
    try:
        conn = sqlstore.open_db()
        try:
            sqlstore.begin_immediate(conn)
            cur = conn.execute(
                "INSERT INTO filer_nominations"
                " (run_id, file_id, path, sha256, observed, model, saw,"
                "  proposal, reasoning, confidence, alternatives, verdict)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
                (run_id, file_id, str(path), sha256, _now(), model,
                 _clip(saw), _json(proposal) or "{}", _clip(reasoning),
                 confidence, _json(alternatives)),
            )
            conn.execute("COMMIT")
            return cur.lastrowid
        finally:
            conn.close()
    except Exception as e:
        print(f"filerstore.nominate failed for {path}: {e}", file=sys.stderr)
        return None


def rule(nomination_id, verdict, by="her", note=None, corrected=None):
    """Record her ruling on a nomination. Appends to `filer_verdicts` and
    refreshes the denormalized copy on the nomination.

    **This one raises.** Everywhere else in this module a recording failure is
    swallowed, because a lost machine-proposal can be regenerated by running the
    filer again. A verdict cannot: it happened once, in her head, and there is no
    other copy. A caller that gets an exception here has to deal with it.

    `corrected` is for redirects — where it should have gone. Storing it is the
    difference between knowing she said no and knowing what yes looked like.
    """
    if verdict not in ("accepted", "rejected", "redirected"):
        raise ValueError(f"unknown verdict {verdict!r}")
    if verdict == "redirected" and corrected is None:
        raise ValueError("a redirect must say where it should have gone")

    conn = sqlstore.open_db()
    try:
        sqlstore.begin_immediate(conn)
        row = conn.execute(
            "SELECT id FROM filer_nominations WHERE id = ?", (nomination_id,)
        ).fetchone()
        if row is None:
            conn.execute("ROLLBACK")
            raise KeyError(f"no nomination {nomination_id}")
        cur = conn.execute(
            "INSERT INTO filer_verdicts (nomination_id, verdict, at, by, note,"
            " corrected) VALUES (?, ?, ?, ?, ?, ?)",
            (nomination_id, verdict, _now(), by, _clip(note),
             _json(corrected)),
        )
        # The nomination's own column is a cache of the latest ruling so the
        # review queue is one cheap query; filer_verdicts stays authoritative,
        # and an earlier ruling is never touched.
        conn.execute(
            "UPDATE filer_nominations SET verdict = ? WHERE id = ?",
            (verdict, nomination_id),
        )
        conn.execute("COMMIT")
        return cur.lastrowid
    finally:
        conn.close()


def mark_applied(nomination_id, new_path=None):
    """Note that the proposed move actually happened.

    Kept separate from the verdict because accepted-but-not-yet-moved is a real
    state: conflating the two is how a crash between her tap and the `mv` turns
    into a file that the record insists was filed.
    """
    try:
        conn = sqlstore.open_db()
        try:
            sqlstore.begin_immediate(conn)
            if new_path is None:
                conn.execute(
                    "UPDATE filer_nominations SET applied = 1, applied_at = ?"
                    " WHERE id = ?", (_now(), nomination_id))
            else:
                conn.execute(
                    "UPDATE filer_nominations SET applied = 1, applied_at = ?,"
                    " path = ? WHERE id = ?",
                    (_now(), str(new_path), nomination_id))
            conn.execute("COMMIT")
            return True
        finally:
            conn.close()
    except Exception as e:
        print(f"filerstore.mark_applied failed for {nomination_id}: {e}",
              file=sys.stderr)
        return False


def pending(limit=200):
    """The review queue: nominations she hasn't ruled on, oldest first."""
    conn = sqlstore.open_db()
    try:
        cols = ["id", "run_id", "file_id", "path", "sha256", "observed",
                "model", "saw", "proposal", "reasoning", "confidence",
                "alternatives"]
        rows = conn.execute(
            f"SELECT {', '.join(cols)} FROM filer_nominations"
            " WHERE verdict = 'pending' ORDER BY observed, id LIMIT ?",
            (limit,),
        ).fetchall()
    finally:
        conn.close()
    return [_decode(dict(zip(cols, r))) for r in rows]


def _decode(d):
    """JSON columns come back out as objects — callers shouldn't have to know
    which columns are text and which are structure."""
    for k in ("proposal", "alternatives", "corrected"):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except (ValueError, TypeError):
                pass
    return d


def training_set(only_hers=True):
    """Every ruled nomination joined to its FINAL verdict, shaped for training.

    `only_hers` keeps rows she personally ruled on. A machine's agreement with
    another machine is not ground truth, and being able to filter it out is why
    `filer_verdicts.by` exists at all.

    Reversals are respected rather than hidden: the newest verdict wins, and the
    earlier ones stay in the table for anyone who wants to study the changes of
    mind.
    """
    conn = sqlstore.open_db()
    try:
        cols = ["n.id", "n.path", "n.sha256", "n.observed", "n.model", "n.saw",
                "n.proposal", "n.reasoning", "n.confidence", "n.alternatives",
                "v.verdict", "v.at", "v.by", "v.note", "v.corrected"]
        names = [c.split(".", 1)[1] for c in cols]
        sql = (
            f"SELECT {', '.join(cols)} FROM filer_nominations n"
            " JOIN filer_verdicts v ON v.id = ("
            "   SELECT id FROM filer_verdicts WHERE nomination_id = n.id"
            "   ORDER BY at DESC, id DESC LIMIT 1)"
        )
        if only_hers:
            sql += " WHERE v.by = 'her'"
        sql += " ORDER BY n.observed, n.id"
        rows = conn.execute(sql).fetchall()
    finally:
        conn.close()
    return [_decode(dict(zip(names, r))) for r in rows]


def export_day(day):
    """Write one sealed day's nominations and verdicts to
    data/filer/<day>.json — the mirror that rides the vault's hourly git backup.

    Same contract as jobstore.export_day: called for a day that will never
    change again, so the file is write-once and the git diff stays clean. These
    tables are not derived from anything, so this mirror is their only backup.
    """
    conn = sqlstore.open_db()
    try:
        ncols = ["id", "run_id", "file_id", "path", "sha256", "observed",
                 "model", "saw", "proposal", "reasoning", "confidence",
                 "alternatives", "verdict", "applied", "applied_at"]
        noms = conn.execute(
            f"SELECT {', '.join(ncols)} FROM filer_nominations"
            " WHERE observed LIKE ? ORDER BY id", (day + "%",),
        ).fetchall()
        vcols = ["id", "nomination_id", "verdict", "at", "by", "note",
                 "corrected"]
        verds = conn.execute(
            f"SELECT {', '.join(vcols)} FROM filer_verdicts"
            " WHERE at LIKE ? ORDER BY id", (day + "%",),
        ).fetchall()
    finally:
        conn.close()

    payload = {
        "day": day,
        "nominations": [dict(zip(ncols, r)) for r in noms],
        "verdicts": [dict(zip(vcols, r)) for r in verds],
    }
    path = store.DATA_DIR / MIRROR_DIR / f"{day}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    store.write_text_file(path, json.dumps(payload, indent=2,
                                           ensure_ascii=False))
    return len(payload["nominations"]) + len(payload["verdicts"])
