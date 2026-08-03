#!/usr/bin/env python3
"""nightcrew_run.py — the overnight fix crew. One green-lit dev note per branch.

Plain English: while she sleeps, this picks up dev notes she has green-lit,
and for each one it makes a throwaway copy of the repo, lets a Claude agent fix
that one note in the copy, runs the whole test suite itself, commits to a branch
if everything passes, and throws the copy away. In the morning the Observatory's
third lane shows her one card per attempt. Nothing merges. She merges.

    0 0 * * * EXOCORTEX_DATA_DIR=<VAULT_DIR>/data \
        <SKELETON_DIR>/venv/bin/python3 \
        <SKELETON_DIR>/scripts/nightcrew_run.py \
        >> <VAULT_DIR>/scripts/nightcrew.log 2>&1

    (Placeholders as in deploy/crontab.template.txt: the skeleton checkout
    and the private data vault of whichever install this is.)

WHY THE LIVE CHECKOUT IS NEVER TOUCHED. The other two Observatory rooms are
defined by whether she's watching: Personal just acts, Orchestra stops and asks
before anything irreversible. This crew can do neither — she's asleep, so it
cannot ask, and an agent that cannot ask must be structurally unable to do the
thing worth asking about. So every attempt happens in a git worktree under
/tmp on its own `agent/<note-id>` branch. The worker never pushes, never
merges, never restarts the service, and never sees /opt/exocortex/skeleton.
The blast radius of a bad night is some junk branches and some usage.

WHY THIS SCRIPT RUNS THE TESTS, NOT THE AGENT. An agent reporting its own smoke
is the failure this design can least afford, because she doesn't read code and
can't catch a false green. So the agent's claims are ignored entirely: after
its turn ends, THIS script runs pytest, vitest and tsc in the worktree and the
literal output it captures is the only evidence that reaches the morning card.
A worker that says "done!" and a worker that says nothing are scored the same.

WHY IT'S SERIAL. The box is 3.7 GB with no swap, and gunicorn serving her
exocortex lives on it. A worker's real peak isn't the ~400 MB agent — it's the
verify step (full pytest + a vitest run + tsc), and two of those at once is
what would actually reach for gunicorn's memory. Wall-clock isn't the
constraint here anyway (three notes fit in an hour and the night is eight).
MAX_NOTES is the knob that matters, not concurrency.

WHAT ACTUALLY LIMITS A NIGHT. Not money: this box authenticates with a Claude
Max subscription over OAuth and no API key is set anywhere, so the `cost_usd`
figures recorded here and shown on the morning cards are the CLI's usage
ESTIMATES at API-equivalent rates — not charges. The real ceiling is the
subscription's rolling usage window, which this run shares with the 3 AM keeper
rollover and the 5 AM Morning Spark. Midnight is deliberately three hours
clear of the rollover so a long night can't crowd the two jobs she actually
meets in the morning. That's also why a throttled turn stops the whole night
(see looks_throttled) instead of spending the rest of the queue against the
same wall.

Touches: tools/nightcrew/triage.py (what's allowed), routes/nightcrew.py (the
morning surface), routes/observatory.py (the headless-turn machinery, shared
with scripts/spark_morning.py), night_runs.json in the data dir (the records).

Prompt that produced this: "automate the easy tasks and make like a checklist
of things it has done for me so I can go see what it did ... these fixes run at
night and keep track of my memory allocation so they are always running a
maximum fleet without killing my [gunicorn]."
"""
import json
import os
import queue
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store                                    # noqa: E402
from routes import observatory as rr            # noqa: E402
from tools.nightcrew import shots                # noqa: E402
from tools.nightcrew import triage              # noqa: E402

SKELETON = Path(__file__).resolve().parents[1]
ORIGIN = "nightcrew"
RUN_ID = "nightcrew"
WORKTREE_ROOT = Path("/tmp")

# How many notes to attempt per night. This is the usage knob: at roughly
# $1.50-$3 of API-equivalent usage an attempt, 3 adds about $5-9 equivalent on
# top of the ~$6-9 the 3 AM and 5 AM crons already draw from the same rolling
# window. Raise it only after a few nights of real data.
MAX_NOTES = 3

# Memory guard, mirroring scripts/research_dispatcher.py's numbers so the two
# fleets reason about this box the same way. Checked before EVERY note, not
# just at the start — a night that begins with room can lose it if she leaves
# something running.
FLOOR_MB = 1024
NEED_MB = 900        # an agent (~400) plus its verify step (~500) at peak

# Branches from failed nights are swept after this long. The run record and its
# reason are kept forever: the branch is the corpse, the lesson is the humus.
BRANCH_TTL_DAYS = 14

TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "TodoWrite"]

# Shapes a throttled turn's error takes. This matters more than it looks: the
# subscription's usage window — not money — is the real ceiling on a night, and
# a rate-limited turn changes NO files, which would otherwise be scored
# identically to "the agent read the note and sensibly declined". Two very
# different mornings, so they must not share a card.
LIMIT_MARKERS = ("rate limit", "rate_limit", "usage limit", "429",
                 "quota", "overloaded", "too many requests")


def looks_throttled(error):
    """True when a turn's error reads as a usage-limit refusal."""
    low = (error or "").lower()
    return any(m in low for m in LIMIT_MARKERS)


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def now():
    return datetime.now().isoformat(timespec="seconds")


def mem_available_mb():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return 0


def enabled():
    """The Automations page's pause switch — same contract every cron script
    here honors, so the crew can be turned off without touching crontab."""
    for r in store.read("scheduled_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("id") == RUN_ID:
            return r.get("enabled", True)
    return True


# --- the brief --------------------------------------------------------------

BRIEF = """You are a night-crew worker. You fix exactly ONE small thing, then stop.

THE NOTE (from her dev notes, {tab} tab — this is the whole ask, verbatim):

    {text}

WHERE YOU ARE. cwd is {worktree} — a throwaway git worktree on branch
{branch}. It is a full copy of the app. Nothing you do here reaches the running
site. Do NOT cd anywhere else. Do NOT touch /opt/exocortex/skeleton (the live
checkout) or the private vault beside it. If your cwd is not {worktree}, stop
immediately and say so.

WHAT TO DO
1. Read {worktree}/CLAUDE.md and follow its conventions — especially the
   plain-language layer (a top-of-file block in plain English on any file you
   create, an inline note in present tense on meaningful code, and the
   technical part of this note baked in next to what it produced).
2. Find the code the note is about. Read it before changing it.
3. Make the SMALLEST change that satisfies the note. Nothing else. No drive-by
   refactors, no fixing things you notice on the way, no renaming.
4. If the app's behavior can silently break from your change, add or update a
   test for it.

HARD LIMITS
- Do NOT run git commit, git push, git merge, or any git command that writes.
  This script commits for you after it verifies your work.
- Do NOT run systemctl, sudo, npm install, or anything that touches services.
- Do NOT edit CLAUDE.md, README.md, dev_todo.md, or anything under docs/.
- Stay inside the files the note is actually about. If the fix needs changes
  across more than about three files, that means the note is bigger than it
  looked: STOP, change nothing further, and say exactly what you found.

WHEN YOU'RE STUCK. There is no one awake to ask. If you cannot do this safely
or the note turns out to be ambiguous, make no changes and end your turn with a
single line starting with `PARKED:` and a plain sentence saying why. That is a
good outcome, not a failure — a parked note costs her one tap tomorrow, and a
wrong guess costs her a broken app before work.

DO NOT claim your work passes. This script runs the full test suite itself
after you finish, and its output is the only evidence that counts. Just make
the change well and end your turn.
"""


# --- worktree lifecycle -----------------------------------------------------

def make_worktree(note_id):
    """A throwaway copy of the repo on its own branch.

    venv/ and node_modules/ are gitignored, so a fresh worktree has neither and
    nothing could be verified in it. Symlinking the main checkout's copies in
    is what makes the verify step possible at all — they're read-only during a
    test run, so sharing them is safe and saves an `npm ci` per note.
    """
    path = WORKTREE_ROOT / f"nightcrew-{note_id}"
    branch = f"agent/{note_id}"
    if path.exists():
        subprocess.run(["git", "-C", str(SKELETON), "worktree", "remove",
                        "--force", str(path)], capture_output=True)
    subprocess.run(["git", "-C", str(SKELETON), "branch", "-D", branch],
                   capture_output=True)
    r = subprocess.run(
        ["git", "-C", str(SKELETON), "worktree", "add", str(path), "-b", branch, "HEAD"],
        capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"worktree add failed: {r.stderr.strip()}")

    linked = []
    for shared_dir in ("venv", "frontend/node_modules"):
        src, dst = SKELETON / shared_dir, path / shared_dir
        if src.exists() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.symlink_to(src)
            linked.append(shared_dir)

    # .gitignore lists these as `venv/` and `node_modules` — patterns with a
    # trailing slash match DIRECTORIES, and what we just made are symlinks,
    # which git sees as files. So they show up as untracked, `git add -A` would
    # commit them, and she'd merge a symlink to this machine's venv into main.
    # The per-worktree exclude file fixes it without touching her checkout's.
    if linked:
        git_dir = subprocess.run(["git", "-C", str(path), "rev-parse", "--absolute-git-dir"],
                                 capture_output=True, text=True).stdout.strip()
        if git_dir:
            info = Path(git_dir) / "info"
            info.mkdir(parents=True, exist_ok=True)
            (info / "exclude").write_text("\n".join(linked) + "\n")
    return path, branch


def drop_worktree(path):
    """Remove the working copy. The BRANCH survives — that's the deliverable."""
    subprocess.run(["git", "-C", str(SKELETON), "worktree", "remove",
                    "--force", str(path)], capture_output=True)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)


def sweep_old_branches():
    """Delete agent/* branches older than the TTL. Runs before the night's work
    so a long-abandoned branch never accumulates; skips anything still checked
    out by a live worktree."""
    r = subprocess.run(
        ["git", "-C", str(SKELETON), "for-each-ref", "--format=%(refname:short) %(committerdate:iso8601)",
         "refs/heads/agent/"], capture_output=True, text=True)
    cutoff = datetime.now() - timedelta(days=BRANCH_TTL_DAYS)
    swept = 0
    for line in (r.stdout or "").splitlines():
        name, _, date = line.partition(" ")
        if not name or not date:
            continue
        try:
            when = datetime.fromisoformat(date.strip()[:19])
        except ValueError:
            continue
        if when < cutoff:
            d = subprocess.run(["git", "-C", str(SKELETON), "branch", "-D", name],
                               capture_output=True)
            swept += d.returncode == 0
    if swept:
        log(f"swept {swept} branch(es) older than {BRANCH_TTL_DAYS}d")


# --- verification: the only evidence that counts ----------------------------

def verify(worktree):
    """Run the project's real gates in the worktree and capture literal output.

    Returns (green: bool, tail: str). Nothing here asks the agent anything —
    the whole point is that the evidence is produced by this script, so a
    confidently-wrong worker cannot manufacture a green card.

    THE BUILD RUNS FIRST, AND IT HAS TO. frontend/dist/ is gitignored, so a
    fresh worktree has no built frontend — and one route test reads
    dist/index.html. Without this step every single night reported "failed" for
    a reason that had nothing to do with the change, which is a false red: just
    as corrosive as a false green, because three of those mornings and she
    stops opening the lane. Building also subsumes the typecheck (the project's
    build script is `vite build && tsc --noEmit`) and costs about two seconds.
    """
    gates = [
        ("build", ["npm", "run", "build"], worktree / "frontend"),
        ("pytest", [str(SKELETON / "venv/bin/python3"), "-m", "pytest", "-q"], worktree),
        ("vitest", ["npx", "vitest", "run"], worktree / "frontend"),
    ]
    green, parts = True, []
    env = {**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR)}
    for name, cmd, cwd in gates:
        try:
            r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                               timeout=900, env=env)
        except subprocess.TimeoutExpired:
            green = False
            parts.append(f"{name}: TIMED OUT after 15m")
            continue
        out = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
        # Last few lines only: the summary is what she'd read, and a full
        # pytest dump would bury the card.
        tail = "\n".join(out[-6:]) if out else "(no output)"
        if r.returncode != 0:
            green = False
        parts.append(f"{name}: {'ok' if r.returncode == 0 else 'FAILED'}\n{tail}")
    return green, "\n\n".join(parts)


# Belt and braces with make_worktree's exclude file: even if that write fails,
# the shared symlinks must never be counted as the agent's work or committed.
NEVER_OURS = ("venv", "frontend/node_modules", "frontend/dist")


def changed_files(worktree):
    r = subprocess.run(["git", "-C", str(worktree), "status", "--porcelain"],
                       capture_output=True, text=True)
    paths = [ln[3:].strip() for ln in (r.stdout or "").splitlines() if ln.strip()]
    return [p for p in paths
            if not any(p == n or p.startswith(n + "/") for n in NEVER_OURS)]


def diff_stat(worktree):
    r = subprocess.run(["git", "-C", str(worktree), "diff", "--shortstat", "HEAD"],
                       capture_output=True, text=True)
    return (r.stdout or "").strip()


def commit(worktree, note):
    """Commit the agent's work to the branch. Returns True only if a commit
    actually landed — the caller must not present an empty branch as `ready`.
    Adds only what we counted as the agent's work — never `add -A`, which
    would sweep in the shared symlinks and the built frontend."""
    files = changed_files(worktree)
    if not files:
        return False
    subprocess.run(["git", "-C", str(worktree), "add", "--", *files], capture_output=True)
    msg = (f"nightcrew: {note['text'][:60]}\n\n"
           f"Dev note {note['id']} ({note['tab']} tab), fixed overnight.\n"
           f"Verified by scripts/nightcrew_run.py before commit. Not merged.\n")
    r = subprocess.run(["git", "-C", str(worktree), "commit", "-m", msg],
                       capture_output=True, text=True)
    return r.returncode == 0


# --- the agent turn ---------------------------------------------------------

def run_agent(note, worktree, branch):
    """One headless Claude turn, cwd'd into the worktree.

    Reuses the observatory's own turn machinery (the same path
    scripts/spark_morning.py takes), so the attempt shows up as a session she
    can open and read — which is the "go see what it did" half of the ask.
    Returns (conv_id, cost_usd, last_text, error). `error` is whatever
    _run_turn recorded on the conversation entry — the only way to tell a
    throttled turn from a turn that simply chose to change nothing.
    """
    rr._chats_dir()
    with store.mutate("bot_chats/index", {}) as index:
        conv_id = rr._new_conv_id(index)
        index[conv_id] = {
            "bot": "keeper",
            "origin": ORIGIN,
            # Explicit, not derived: without this the /tmp cwd would derive the
            # PERSONAL lane ("her, talking, in real time") for a run that is
            # precisely the opposite. Orchestra is the gated, unattended room.
            "lane": "orchestra",
            "started": now(), "last_at": now(),
            "claude_session_id": None,
            "title": f"night · {note['text'][:40]}",
            "cost_usd": 0.0,
            "journal": False,            # build work, never her diary
            "cwd": str(worktree),
            "running": True,
        }

    brief = BRIEF.format(tab=note["tab"], text=note["text"],
                         worktree=worktree, branch=branch)
    log_path = rr._chats_dir() / f"{conv_id}.jsonl"
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "user", "text": brief,
                             "ts": now(), "journaled": False}) + "\n")

    bot = dict(rr._bot("keeper") or {}, allowed_tools=TOOLS)
    proc, stderr_f = rr._spawn(bot, brief, None, cwd_override=str(worktree))
    rr._run_turn(proc, stderr_f, conv_id, log_path, None, queue.Queue())

    entry = store.read("bot_chats/index", {}).get(conv_id, {})
    last = ""
    try:
        for line in log_path.read_text(encoding="utf-8").splitlines():
            ev = json.loads(line)
            if ev.get("type") == "assistant" and ev.get("text"):
                last = ev["text"]
    except Exception:
        pass
    return conv_id, entry.get("cost_usd") or 0.0, last, entry.get("last_error")


# --- records ----------------------------------------------------------------

def record(run):
    with store.mutate("night_runs.json", {"runs": []}) as data:
        data.setdefault("runs", []).append(run)


def already_pending(note_id):
    """Skip a note that already has an undismissed card waiting for her — the
    crew must not re-attempt work she simply hasn't looked at yet, or one
    ignored morning turns into three identical branches.

    A THROTTLED card doesn't count: nothing was attempted, and its card
    promises "still queued for tomorrow" — so tomorrow must actually pick the
    note up, dismissed or not."""
    for r in store.read("night_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("note_id") == note_id and not r.get("dismissed"):
            if r.get("throttled"):
                continue
            return True
    return False


def status_to_registry(status, spent):
    with store.mutate("scheduled_runs.json", {"runs": []}) as data:
        runs = data.setdefault("runs", [])
        entry = next((r for r in runs if isinstance(r, dict) and r.get("id") == RUN_ID), None)
        if entry is None:
            entry = {"id": RUN_ID, "name": "Night crew",
                     "description": "Fixes green-lit dev notes overnight on their own "
                                    "branches. Nothing merges without her.",
                     "enabled": True}
            runs.append(entry)
        # Overwritten every run, not just at creation, so the Automations page
        # can never keep showing a schedule this script no longer runs on.
        entry["schedule"] = "0 0 * * *"
        entry["schedule_human"] = "Every night at midnight"
        entry["last_run"] = now()
        entry["last_status"] = status
        entry["last_cost_usd"] = round(spent, 4)


# --- one note ---------------------------------------------------------------

def do_note(note):
    """Attempt one note end to end. Always returns a record — a night that
    produces no card for an attempted note is a night she can't audit."""
    # Hour+minute in the id so a note dismissed and re-attempted the same day
    # can't collide with its earlier run (same record id would also mean the
    # same nightcrew_shots/<id>/ directory).
    base = {"id": f"r-{datetime.now():%m%d-%H%M}-{note['id'][:8]}",
            "note_id": note["id"], "tab": note["tab"],
            "note_text": note["text"], "finished": now()}
    worktree = None
    try:
        worktree, branch = make_worktree(note["id"])
        conv_id, cost, last, error = run_agent(note, worktree, branch)
        base.update({"branch": branch, "cost_usd": round(cost, 4), "conv_id": conv_id})

        # A throttled turn is not a verdict on the note — nothing was tried.
        # Park it honestly and tell main() to stop, so the rest of tonight's
        # queue isn't spent hitting the same wall.
        if error and looks_throttled(error):
            return {**base, "status": "parked", "throttled": True,
                    "reason": "hit your Claude usage limit — nothing was attempted, "
                              "so this note is still queued for tomorrow"}
        if error:
            return {**base, "status": "failed",
                    "reason": f"the agent's turn failed: {str(error)[:200]}"}

        touched = changed_files(worktree)
        if not touched:
            # The agent's own PARKED line is the best explanation available,
            # but an empty diff is parked whether it said so or not.
            reason = "made no changes"
            for line in (last or "").splitlines():
                if line.strip().startswith("PARKED:"):
                    reason = line.strip()[7:].strip() or reason
                    break
            return {**base, "status": "parked", "reason": reason}

        base["diff_stat"] = diff_stat(worktree) or f"{len(touched)} file(s) changed"
        green, tail = verify(worktree)
        base["test_tail"] = tail
        if not green:
            return {**base, "status": "failed",
                    "reason": "the change didn't pass the test suite — branch kept "
                              "so you can look, nothing merged"}

        # Before/after pictures, BEFORE the commit — capture_pair stashes the
        # change to photograph the old page, which only works while it's still
        # uncommitted. Screenshots are a nice-to-have: a failure here must never
        # turn a green run into a failed card, so it's isolated.
        try:
            shot_dir = store.DATA_DIR / "nightcrew_shots" / base["id"]
            pair = shots.capture_pair(worktree, touched, shot_dir, store.DATA_DIR)
            base["route"] = pair.get("route")
            if pair.get("before"):
                base["shot_before"] = f"/api/nightcrew/shot/{base['id']}/before.png"
            if pair.get("after"):
                base["shot_after"] = f"/api/nightcrew/shot/{base['id']}/after.png"
        except Exception as e:
            log(f"[{note['id']}] screenshots skipped: {type(e).__name__}: {e}")

        # If the screenshot step's stash pop failed, the diff is sitting in the
        # stash and the branch would be EMPTY — a mergeable card with nothing
        # behind it is the one lie this lane can least afford, so a commit that
        # lands nothing downgrades the run instead of shipping the card.
        if not commit(worktree, note):
            return {**base, "status": "failed",
                    "reason": "the change passed its tests but never reached the "
                              "branch (likely the screenshot step failed to restore "
                              "it) — nothing merged"}
        return {**base, "status": "ready"}
    except Exception as e:
        return {**base, "status": "failed",
                "reason": f"the run itself broke: {type(e).__name__}: {e}"}
    finally:
        if worktree:
            drop_worktree(worktree)


def main():
    if not store.DATA_DIR.exists():
        log(f"ERROR: DATA_DIR {store.DATA_DIR} missing — is EXOCORTEX_DATA_DIR set?")
        return 1
    if not enabled():
        log("disabled in scheduled_runs.json — skipping")
        return 0

    sweep_old_branches()

    eligible = triage.triage(store.read("dev_notes.json", {"tabs": {}}).get("tabs", {}))["eligible"]
    queued = [n for n in eligible if not already_pending(n["id"])]
    log(f"{len(eligible)} eligible, {len(queued)} not already waiting on her")

    spent, done = 0.0, 0
    for note in queued[:MAX_NOTES]:
        avail = mem_available_mb()
        if avail < FLOOR_MB + NEED_MB:
            log(f"stopping: {avail}MB available, need {FLOOR_MB + NEED_MB}MB "
                f"to run one more without crowding gunicorn")
            break
        log(f"[{note['id']}] starting ({avail}MB free) — {note['text'][:60]}")
        run = do_note(note)
        record(run)
        spent += run.get("cost_usd") or 0
        done += 1
        if run.get("throttled"):
            log("stopping: hit the subscription's usage limit — "
                "remaining notes stay queued for tomorrow")
            break
        log(f"[{note['id']}] {run['status']}  ${run.get('cost_usd', 0):.2f}"
            + (f"  — {run['reason']}" if run.get("reason") else ""))

    log(f"night done: {done} attempted, ${spent:.2f}")
    status_to_registry("ok", spent)
    return 0


if __name__ == "__main__":
    sys.exit(main())
