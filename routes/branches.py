"""branches.py — what the unattended sessions have built and not yet handed over.

Plain English: agents that build for you work in their own copy of the app
(worktrees.py) and leave their work on a branch called `agent/…`. Nothing
merges by itself, so those branches pile up and the only way to see them was
`git worktree list` in a terminal. This page is that pile, made readable: one
card per branch saying what it changed, who made it, and whether anything is
stranded — all of it read from git rather than narrated by the agent.

EVIDENCE ONLY — THERE IS NO CLAIM HALF ANY MORE. Every number here is read from
git by worktrees.branch_evidence(). Sessions used to also write a REPORT.md of
their own prose, returned as a separate field and kept visibly apart on the page
because a well-written explanation of broken code reads exactly like a good
outcome. Those were removed 2026-08-22 — nobody read them (8 written across 42
spinoffs, 0 read), and the account moved into the session's closing message
instead. What's left is the half that was never the agent's word for it, the
same reason scripts/nightcrew_run.py runs the tests itself instead of believing
the worker. The evidence answers "what changed", not "does it work": running the
gates belongs with the merge tap, which isn't built.

Read-only, with ONE deliberate exception: the steward door (POST
/api/branches/steward). Replying to a finished branch's card wakes a *steward*
— a fresh session stood on that existing branch in its own worktree
(worktrees.adopt via routes/spinoff.py's adopt-mode), briefed with the literal
evidence plus her message. The steward reads the record; it does NOT remember
the session that built the branch — that one is gone, and nothing here
pretends otherwise. One steward per branch: a live session already claiming
the branch (steward or original builder) is rejoined, never duplicated.
There is still no merge button here on purpose — merging is her tap and it
lands with the ship-it card, where the gates can run first.

Touches: worktrees.py (all the git, and adopt()), routes/spinoff.py (the spawn
door the steward rides through), routes/observatory.py (the session behind
a branch, and its evidence endpoint), night_runs.json (the overnight crew's
branches, which come from scripts/nightcrew_run.py rather than a spinoff).

Prompt that produced it: "is there any way to make this into a visual UI that i
can look at to understand it better?"
"""
import re
import subprocess
from datetime import datetime

from flask import jsonify, request

import store
import worktrees

# Branches the night crew makes are named agent/<note-id> and have no spinoff
# behind them; spinoff branches are agent/<slug>-<date>. Both are listed — the
# question "what has been built for me that I haven't taken?" doesn't care
# which crew made it.
BRANCH_PREFIX = "refs/heads/agent/"


def _git(*args):
    return subprocess.run(["git", "-C", str(worktrees.SKELETON), *args],
                          capture_output=True, text=True)


def _branch_rows():
    """(name, iso date, subject) for every agent/* branch, newest first."""
    r = _git("for-each-ref", "--sort=-committerdate",
             "--format=%(refname:short)%09%(committerdate:iso8601)%09%(contents:subject)",
             BRANCH_PREFIX)
    rows = []
    for line in (r.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and parts[0]:
            rows.append(tuple(parts))
    return rows


def _merged_branches():
    """Branches already contained in main — kept visible but marked, so a
    branch she's already taken doesn't look like something still owed."""
    r = _git("branch", "--merged", "main", "--format=%(refname:short)")
    return {ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip()}


def _live_worktrees():
    """{branch: path} for worktrees that still exist on disk."""
    r = _git("worktree", "list", "--porcelain")
    out, path = {}, None
    for line in (r.stdout or "").splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):]
        elif line.startswith("branch ") and path:
            out[line[len("branch refs/heads/"):]] = path
    return out


def _sessions_by_branch(index):
    """The conversation that made each branch, if one still claims it."""
    out = {}
    for conv_id, entry in (index or {}).items():
        if isinstance(entry, dict) and entry.get("branch"):
            out[entry["branch"]] = {
                "conversation_id": conv_id,
                "title": entry.get("title"),
                "slug": entry.get("spinoff_slug"),
                "archived": bool(entry.get("archived")),
                "lane": entry.get("lane"),
            }
    return out


def _night_runs_by_branch():
    """The overnight crew records its own verdict per branch — including a
    real test result, which is the one place we currently have one."""
    out = {}
    for run in store.read("night_runs.json", {"runs": []}).get("runs", []) or []:
        if isinstance(run, dict) and run.get("branch"):
            out[run["branch"]] = {
                "status": run.get("status"),
                "note": run.get("note_text"),
                "reason": run.get("reason"),
                "tested": bool(run.get("test_tail")),
            }
    return out


def _state(commits, merged, night, working=False):
    """What this branch IS to her, which is not what git alone can say.

    `waiting` is the only state that asks anything of her, and it's the one
    this page exists for: work that was built and never taken.

    The other two need care. An empty branch reads as `merged` to git —
    nothing in it is missing from main, so it's trivially contained — and on
    the real repo three of the four branches were exactly that: night runs
    that parked or failed and built nothing. Calling those "taken" would tell
    her she'd accepted work that never existed.

    But once a branch really IS merged, its commits are in main and the count
    ahead drops to zero too — so a taken branch and an empty one become
    indistinguishable by refs alone. Rather than guess, `done` says only what
    is true: nothing here needs you. The night crew's own record is the one
    place we can do better, so `empty` is claimed ONLY when it says so.
    """
    # Checked FIRST: a copy that still has uncommitted files in it means
    # somebody is mid-build. The page's own screenshot caught this — a card
    # read "nothing to take" while warning in the next breath that 8 files
    # would be missed by a merge. Both were true of git and together they were
    # nonsense. Work in progress is neither owed to her nor finished.
    if working:
        return "working"
    if commits:
        return "waiting" if not merged else "taken"
    if (night or {}).get("status") in ("parked", "failed"):
        return "empty"        # the crew tried and built nothing — it says so
    return "done"             # taken, or empty and unknowable — either way, nothing owed


def _age_days(iso):
    try:
        return (datetime.now() - datetime.fromisoformat(iso.strip()[:19])).days
    except (TypeError, ValueError):
        return None


def collect():
    """One row per agent/* branch: what it carries, who made it, where it
    stands. A plain function, not just a route body, because routes/nightcrew.py
    folds these into the room's card list — the Observatory has ONE place
    finished work waits, and two endpoints answering "what's waiting for me?"
    is how a surface starts lying by disagreeing with itself.

    Everything here is read from git — there is no second, narrated half."""
    index = store.read("bot_chats/index", {})
    merged = _merged_branches()
    live = _live_worktrees()
    sessions = _sessions_by_branch(index)
    nights = _night_runs_by_branch()

    rows = []
    for name, date, subject in _branch_rows():
        session = sessions.get(name)
        ev = worktrees.branch_evidence(name)
        # Only a live worktree can hold work that never reached the branch —
        # the gap between what the session did and what a merge would get.
        uncommitted = (worktrees.evidence(live[name], name).get("uncommitted")
                       if name in live else [])
        rows.append({
            "branch": name,
            "subject": subject,
            "committed": date,
            "age_days": _age_days(date),
            "merged": name in merged,
            "state": _state(len(ev["commits"]), name in merged,
                            nights.get(name), working=bool(uncommitted)),
            "worktree": live.get(name),
            "session": session,
            "night_run": nights.get(name),
            "commits": len(ev["commits"]),
            # The first few commit subjects, sha stripped — the card's face
            # speaks in first person from literal evidence, and these lines are
            # most of what's known of a branch.
            "commit_lines": [c.split(" ", 1)[1] if " " in c else c
                             for c in ev["commits"][:5]],
            "diff_stat": ev["diff_stat"],
            "files": ev["files"],
            "uncommitted": uncommitted,
        })
    return rows


# How a branch's state reads in the room's own vocabulary. The room sorts by
# `status` and it already had four values; `working` is the one genuinely new
# thing a spinoff branch brought — a night run is never in progress (she's
# asleep and it's over by morning), but a daytime session's copy can be
# mid-edit right now.
_STATE_TO_STATUS = {
    "waiting": "ready",     # built, not taken — the only card that asks her
    "working": "working",   # a live copy with uncommitted files in it
    "empty": "parked",      # tried, built nothing
    "taken": "merged",
    "done": "merged",
}


def as_card(row):
    """A branch, in the shape the Night crew room's cards already speak.

    Deliberately NO merge affordance rides along. The room's merge button posts
    a night-RUN id, and a night run earned it by being verified in its worktree
    before the card ever appeared. A spinoff branch has had no gate run against
    it at all, so a one-tap merge here would be a button that ships unverified
    work — worse than making her type it. Merging these belongs with the
    ship-it card, where the gates run against the MERGED result."""
    session = row.get("session") or {}
    return {
        "id": f"branch:{row['branch']}",
        "source": "branch",
        "note_text": session.get("title") or row["subject"],
        "status": _STATE_TO_STATUS.get(row["state"], "parked"),
        "branch": row["branch"],
        "diff_stat": row["diff_stat"],
        "finished": row["committed"],
        "conv_id": session.get("conversation_id"),
        # Whether somebody is still standing on this branch — a live
        # (non-archived) session, builder or steward. The compose box hides
        # behind this: a branch with a living session is talked to THROUGH
        # that session, never given a second voice.
        "session_live": bool(session) and not session.get("archived"),
        "files": row["files"],
        "uncommitted": row["uncommitted"],
        "worktree": row["worktree"],
        "commits": row["commits"],
        "commit_lines": row["commit_lines"],
    }


# --- the steward door ---------------------------------------------------
# Her ask, verbatim (2026-08-07): "I need them to be more like, sessions I can
# interact with if I need to. I want them to have all the same capacities as
# other sessions in the room but they describe what they've done." The card's
# face describes (frontend, from these same evidence fields, no model call);
# replying is what wakes. The steward is minted through the spinoff door's
# adopt-mode — a mode of the existing organ, because the same seam later
# serves the checker-escalation spawner.

def steward_slug(branch):
    """One branch → one slug, deterministically — the idempotency key.

    The spinoff door rejoins a slug that already has a live conversation, so
    deriving the slug from the branch name (rather than minting a fresh one
    per reply) is the whole one-steward-per-branch rule. Lowercased and
    squeezed to the spinoff slug alphabet; agent/ prefix dropped."""
    tail = re.sub(r"[^a-z0-9-]+", "-", branch.split("/", 1)[-1].lower())
    return f"steward-{tail}"[:39].strip("-")


def _steward_brief(branch, message, ev, night):
    """The steward's BRIEF.md: literal evidence + her message + the rails.

    Written fresh at every wake (a rejoin never gets this far), grounded in
    git rather than in anything a previous agent said. The honesty rail is
    spelled out because it's the one promise the UI makes about stewards:
    it reads the record, it does not remember the night."""
    commits = "\n".join(f"  - {c}" for c in ev["commits"]) or "  - (none)"
    files = "\n".join(f"  - {f}" for f in ev["files"][:40]) or "  - (none)"
    tested = ("the overnight run recorded a real test result on its card"
              if (night or {}).get("tested")
              else "NO tests have been recorded against this branch")
    return f"""# Steward of `{branch}`

You are the STEWARD of this branch — finished work waiting in the
Observatory's "Built for you" room. The owner replied to its card; her
message is below, and answering it is this session's job.

## What you are (the honesty rail — do not soften it)
- You are NOT the session that built this branch. That session is gone.
  You read the record — git and the run log — and you never claim
  to remember the building. If asked about intent the record doesn't show,
  say the record doesn't show it.
- Your working directory IS a worktree standing on `{branch}`. Work there:
  add commits forward (never rewrite history), run the tests yourself, and
  report what they actually said — never claim a green you didn't watch.
- NOTHING MERGES WITHOUT HER TAP. You never merge, never touch main, never
  restart services. Your work stays on this branch until she takes it.
- Follow this repo's CLAUDE.md (plain-English notes, tests for behavior).

## The evidence (read from git at wake time — verify it yourself in cwd)
- Diff against main: {ev['diff_stat'] or '(empty)'}
- Commits on the branch:
{commits}
- Files it touches:
{files}
- Tests: {tested}
- There is no builder's narrative to lean on. Git is the whole record.

## Her message
> {message}

## Protocol
1. Ground yourself: `git log`/`git diff main...` in your own directory, and
   read the builder's account if one exists (it is unverified prose).
2. Do what her message asks, on this branch, with tests run fresh.
3. Answer her conversationally — she reads this session in the Observatory.
   Describe what you did and what the tests said, evidence apart from claim.
"""


def open_steward(branch, message):
    """Wake (or rejoin) the one steward for `branch`. Returns (payload, status).

    The order of refusals is the design: not an agent branch / no such
    branch / already merged (nothing left to amend — follow-ups belong in a
    fresh session) / a LIVE session already claims it (builder or steward —
    talk to that one; git would refuse a second worktree on the branch
    anyway, and that refusal is correct). Only then does the spinoff door's
    adopt-mode mint, with the brief written first so the kickoff has
    something to read."""
    if not branch.startswith("agent/"):
        return {"error": "not an agent branch"}, 400
    if not message:
        return {"error": "say something for the steward to answer"}, 400
    if _git("rev-parse", "--verify", "--quiet",
            f"refs/heads/{branch}").returncode != 0:
        return {"error": "no such branch"}, 404
    if branch in _merged_branches():
        return {"error": "this branch is already merged — its work is live; "
                         "follow-ups belong in a fresh session"}, 409

    index = store.read("bot_chats/index", {})
    live = _sessions_by_branch(index).get(branch)
    if live and not live.get("archived"):
        return {"ok": True, "conversation_id": live["conversation_id"],
                "existing": True,
                "note": "a session is already standing on this branch — "
                        "say it there"}, 200

    slug = steward_slug(branch)
    ev = worktrees.branch_evidence(branch)
    night = _night_runs_by_branch().get(branch)
    d = store.SPINOFF_DIR / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "BRIEF.md").write_text(
        _steward_brief(branch, message, ev, night),
        encoding="utf-8")

    # Import at call time, not module top: spinoff imports observatory, and
    # keeping this module import-light is what lets nightcrew.py fold our
    # cards in without dragging the whole observatory machinery along.
    from routes.spinoff import open_spinoff
    payload, status = open_spinoff(slug, lane="orchestra", branch=branch)
    if status != 200:
        return payload, status
    return {"ok": True, "conversation_id": payload["conversation_id"],
            "existing": not payload.get("newly_spawned", False),
            "branch": branch, "slug": slug}, 200


def register(app):

    @app.route("/api/branches/steward", methods=["POST"])
    def branches_steward():
        data = request.get_json(silent=True) or {}
        payload, status = open_steward(
            (data.get("branch") or "").strip(),
            (data.get("message") or "").strip())
        return jsonify(payload), status

    @app.route("/api/branches", methods=["GET"])
    def branches_list():
        return jsonify({"branches": collect(),
                        "worktree_root": str(worktrees.WORKTREE_ROOT)})

