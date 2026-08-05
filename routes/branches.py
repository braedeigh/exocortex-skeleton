"""branches.py — what the unattended sessions have built and not yet handed over.

Plain English: agents that build for you work in their own copy of the app
(worktrees.py) and leave their work on a branch called `agent/…`. Nothing
merges by itself, so those branches pile up and the only way to see them was
`git worktree list` in a terminal. This page is that pile, made readable: one
card per branch saying what it changed, who made it, whether anything is
stranded, and — when the session wrote one — its own plain-English account of
what it did and why.

WHAT'S EVIDENCE AND WHAT'S A CLAIM. Every number here is read from git by
worktrees.branch_evidence(). The `report` is the agent's own prose. They are
returned as separate fields and the page keeps them visibly apart, because a
well-written explanation of broken code reads exactly like a good outcome — the
same reason scripts/nightcrew_run.py runs the tests itself instead of believing
the worker. Today the evidence answers "what changed", not "does it work":
running the gates belongs with the merge tap, which isn't built.

Read-only. There is no merge button here on purpose — merging is her tap and it
lands with the ship-it card, where the gates can run first.

Touches: worktrees.py (all the git), routes/observatory.py (the session behind
a branch, and its own report endpoint), night_runs.json (the overnight crew's
branches, which come from scripts/nightcrew_run.py rather than a spinoff).

Prompt that produced it: "is there any way to make this into a visual UI that i
can look at to understand it better?"
"""
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


def register(app):

    @app.route("/api/branches", methods=["GET"])
    def branches_list():
        """One row per agent/* branch: what it carries, who made it, where it
        stands. The report BODY isn't included — it's fetched per branch, so
        opening the page doesn't read a dozen files off disk."""
        index = store.read("bot_chats/index", {})
        merged = _merged_branches()
        live = _live_worktrees()
        sessions = _sessions_by_branch(index)
        nights = _night_runs_by_branch()

        rows = []
        for name, date, subject in _branch_rows():
            session = sessions.get(name)
            slug = (session or {}).get("slug")
            has_report = bool(
                slug and (store.SPINOFF_DIR / slug / "REPORT.md").is_file())
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
                "has_report": has_report,
                "commits": len(ev["commits"]),
                "diff_stat": ev["diff_stat"],
                "files": ev["files"],
                "uncommitted": uncommitted,
            })
        return jsonify({"branches": rows,
                        "worktree_root": str(worktrees.WORKTREE_ROOT)})

    @app.route("/api/branches/report", methods=["GET"])
    def branches_report():
        """The session's own account, by branch. Separate from the numbers on
        purpose — this is what it SAYS it did, and it's the half nothing
        verifies."""
        branch = (request.args.get("branch") or "").strip()
        if not branch.startswith("agent/"):
            return jsonify({"error": "not an agent branch"}), 400
        index = store.read("bot_chats/index", {})
        slug = (_sessions_by_branch(index).get(branch) or {}).get("slug")
        if not slug:
            return jsonify({"branch": branch, "report": None,
                            "reason": "no spinoff behind this branch"}), 200
        path = store.SPINOFF_DIR / slug / "REPORT.md"
        try:
            return jsonify({"branch": branch, "slug": slug,
                            "report": path.read_text(encoding="utf-8")})
        except OSError:
            return jsonify({"branch": branch, "slug": slug, "report": None,
                            "reason": "the session never wrote one"}), 200
