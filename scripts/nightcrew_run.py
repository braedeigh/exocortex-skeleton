#!/usr/bin/env python3
"""nightcrew_run.py — the overnight fix crew. One dev note per branch.

Plain English: while she sleeps, this works the dev-note backlog. It attempts
notes she has green-lit (the moon tap). Its own initiative is a three-rung
ladder (see pick_mode): off / picks / full. The current rung is PICKS — each
night it PROPOSES up to five notes as "picked" cards (the newest
never-answered gate-passers from the last week, tools/nightcrew/nominate.py)
and works none of them; she judges
the picks in the morning (would-want / not-this, with a why), so the picking
policy is tuned on real judgments before any tokens act on it. Her own moons
still run as always. For each note it works, it makes a throwaway copy of the
repo, lets a Claude agent fix that one note in the copy, runs the whole test
suite itself, commits to a branch if everything passes, and throws the copy
away. In the morning the Observatory's third lane shows her one card per
attempt. Nothing merges. She merges.

WHEN A NOTE ISN'T OBVIOUS, THE CREW ASKS INSTEAD OF GUESSING. A worker that
finds the note ambiguous changes nothing and ends with a QUESTIONS: block —
whatever questions would shape the note enough to act. The questions land on
the morning card AND on the note itself (`night_questions`), where she answers
by editing the note in place. The edit is the whole re-queue signal: a note
whose text has changed since its last attempt is fair game again
(already_pending compares texts), so an answered note re-enters the rotation
by itself and an unanswered one is left alone while the crew moves down the
backlog.

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
rollover and Morning Spark. The night runs 3:30–5 AM (her call, 2026-08-11):
cron starts it at 3:30, LAST_START_HOUR refuses to begin a new note at or after
5, and a note already in flight finishes rather than being killed. Morning Spark
moved to 6 AM in the same change so an overrun still lands clear of it. That's
also why a throttled turn stops the whole night (see looks_throttled) instead of
spending the rest of the queue against the same wall.

Touches: tools/nightcrew/triage.py (what's allowed), tools/nightcrew/nominate.py
(what it picks for itself), routes/nightcrew.py (the morning surface),
routes/devnotes.py (editing a note clears its questions), routes/observatory.py
(the headless-turn machinery, shared with scripts/spark_morning.py),
night_runs.json in the data dir (the records).

Prompts that produced this: "automate the easy tasks and make like a checklist
of things it has done for me so I can go see what it did ... these fixes run at
night and keep track of my memory allocation so they are always running a
maximum fleet without killing my [gunicorn]" — then "I want it to find things
to queue for itself. Starting with the oldest ones until we're caught up ...
ask me to clarify on ones that aren't totally completely obvious. And then
they'll run again later when I have time to look through and amend them. And
then it moves onto a next one until I do."
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

import devnote_judgments                        # noqa: E402
import store                                    # noqa: E402
from routes import observatory as rr            # noqa: E402
from tools.nightcrew import nominate            # noqa: E402
from tools.nightcrew import shots                # noqa: E402
from tools.nightcrew import triage              # noqa: E402

SKELETON = Path(__file__).resolve().parents[1]
ORIGIN = "nightcrew"
RUN_ID = "nightcrew"
WORKTREE_ROOT = Path("/tmp")

# How many notes to attempt per night. This is the usage knob: at roughly
# $1.50-$3 of API-equivalent usage an attempt, 3 adds about $5-9 equivalent on
# top of the ~$6-9 the 3 AM and 6 AM crons already draw from the same rolling
# window. Raise it only after a few nights of real data.
MAX_NOTES = 3

# The window she set (2026-08-11): cron starts the night at 3:30 AM and no NEW
# note begins at or after 5. A note already running is allowed to FINISH —
# killing a worker mid-verify would leave a half-built worktree and no card to
# show for it, which is worse than running late. Morning Spark moved 5 AM → 6 AM
# in the same change, so an overrunning note still lands clear of the job she
# actually meets at breakfast.
LAST_START_HOUR = 5

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


def last_assistant_text(log_path):
    """The worker's final message, pulled from the conversation log.

    The log holds Claude Code's raw stream-json events: an assistant event
    nests its words at message.content[].text — there is NO top-level "text"
    on assistant events (only on the user events this script writes itself).
    Reading the wrong level is how the question loop's first night lost every
    question the workers asked (2026-08-05): the script saw empty finals,
    found no QUESTIONS: block, and filed honest work as "made no changes"."""
    last = ""
    try:
        for line in log_path.read_text(encoding="utf-8").splitlines():
            ev = json.loads(line)
            if ev.get("type") != "assistant":
                continue
            if ev.get("text"):  # tolerate a flattened event, should one appear
                last = ev["text"]
                continue
            msg = ev.get("message") or {}
            parts = [b.get("text", "") for b in (msg.get("content") or [])
                     if isinstance(b, dict) and b.get("type") == "text"]
            if any(parts):
                last = "\n".join(p for p in parts if p)
    except Exception:
        pass
    return last


def parse_questions(last):
    """The worker's QUESTIONS: block from its final message, or "".

    Everything from the marker line to the end of the message is the block —
    the brief tells the worker to end its turn with it, and taking "the rest"
    means a multi-line list of questions survives intact rather than being
    truncated to its first line the way PARKED: reasons are.
    """
    lines = (last or "").splitlines()
    for i, line in enumerate(lines):
        s = line.strip()
        if s.upper().startswith("QUESTIONS:") or s.upper().startswith("QUESTION:"):
            head = s.split(":", 1)[1].strip()
            rest = ([head] if head else []) + [ln.rstrip() for ln in lines[i + 1:]]
            return "\n".join(ln for ln in rest if ln.strip()).strip()
    return ""


def annotate_note_questions(note, questions):
    """Write the worker's questions onto the note itself (`night_questions`),
    so they meet her where she already reads and edits notes — the panel card —
    not only on a morning card she might clear without acting. Editing the
    note's text clears the field again (routes/devnotes.py), because her edit
    IS the answer and a stale question sitting under an amended note would
    read as still-unanswered."""
    with store.mutate("dev_notes.json", {"tabs": {}}) as data:
        for notes in (data.get("tabs") or {}).values():
            for n in notes or []:
                if isinstance(n, dict) and n.get("id") == note["id"]:
                    n["night_questions"] = questions
                    return


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


def pick_mode():
    """How much initiative the crew has over its own queue — three rungs,
    read off `self_queue` on the Night crew row in scheduled_runs.json:

      "off"   (absent/false) — hand-picked moons only.
      "picks" ("picks")      — the crew PROPOSES nightly but works nothing it
                               picked: each candidate becomes a "picked" card
                               she judges in the morning (would-want / not-
                               this, with a why), so the picking policy gets
                               tuned on real judgments before any tokens are
                               spent acting on it. Her own moons still run.
      "full"  (true)         — picks go straight to work (the original
                               self-queue; earned back once picking is
                               hammered out).

    The ladder exists because the first self-queued night (2026-08-05)
    picked the oldest gate-passers — notes she'd been ignoring on purpose.
    Old wasn't the same as wanted; now wanted gets learned first.
    [prompt: "I want information about what it's picking too, so I can
    target that correctly. Kinda not wanting it to work yet, just pick
    things for now, then once that is hammered out, we go onto making"]"""
    for r in store.read("scheduled_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("id") == RUN_ID:
            v = r.get("self_queue")
            return "full" if v is True else ("picks" if v == "picks" else "off")
    return "off"


# Proposals per night in "picks" mode. More generous than MAX_NOTES because a
# pick costs no tokens — it's a card, not an agent turn — and the tuning week
# wants a real stream of judgments to learn from.
PICKS_PER_NIGHT = 5


def record_picks(tabs):
    """One "picked" card per nominee — a proposal, not work. Nothing on the
    note itself changes here: her verdict reaches the note's judgments only
    when she answers the card (routes/nightcrew.py `/pick`).

    Skipped: notes already carrying an unjudged pick card (a proposal she
    hasn't answered must not repeat — that's the pestering the burn's
    refugium rule exists to prevent) and notes whose earlier pick was
    already judged either way."""
    already = set()
    for r in store.read("night_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("status") == "picked":
            already.add(r.get("note_id"))
    fresh = {t: [n for n in notes or [] if isinstance(n, dict)
                 and n.get("id") not in already]
             for t, notes in (tabs or {}).items()}
    candidates = nominate.nominate(fresh, PICKS_PER_NIGHT)
    total = len(nominate.nominate(fresh, 10**6))
    for i, p in enumerate(candidates):
        record({"id": f"p-{datetime.now():%m%d-%H%M}-{p['id'][:8]}",
                "status": "picked", "note_id": p["id"], "tab": p["tab"],
                "note_text": p["text"], "note_created": p["created"],
                "pick_reason": f"newest never-answered note from the last "
                               f"{nominate.WINDOW_DAYS} days that passes the "
                               f"gate — #{i + 1} of {total} candidates",
                "finished": now()})
        log(f"picked [{p['id']}] ({p['tab']}, {p['created'] or 'undated'}) "
            f"— {p['text'][:60]}")
    return len(candidates)


def self_queue(tabs, need):
    """Full rung: the crew lights up to `need` notes for itself and returns them
    as queue rows. Each gets an `approved` judgment with `by: "crew"`, so the
    note knows it was lit and by whom — the green light triage.py reads, and the
    answer that keeps nominate.py from proposing it again."""
    picked = nominate.nominate(tabs, need) if need > 0 else []
    if not picked:
        return []
    ids = {p["id"] for p in picked}
    with store.mutate("dev_notes.json", {"tabs": {}}) as data:
        for notes in (data.get("tabs") or {}).values():
            for n in notes or []:
                if isinstance(n, dict) and n.get("id") in ids:
                    devnote_judgments.append(n, "approved", by="crew")
    for p in picked:
        log(f"self-queued [{p['id']}] ({p['tab']}, {p['created'] or 'undated'}) "
            f"— {p['text'][:60]}")
    return [{"id": p["id"], "tab": p["tab"], "text": p["text"]} for p in picked]


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

WHEN THE NOTE ISN'T TOTALLY OBVIOUS. There is no one awake to ask, so ask in
writing. If — after reading the code — the note is ambiguous, underspecified,
or could reasonably mean two different things, make NO changes and end your
turn with a block starting `QUESTIONS:` followed by whatever questions (one or
several) would shape the note enough to act on. Write them for someone who
does not read code, and name what you found where it helps her decide. Her
answers get folded into the note and a future night picks it up again.

WHEN YOU'RE STUCK for a reason questions can't fix (you cannot do this safely,
or it's bigger than it looked), make no changes and end your turn with a single
line starting with `PARKED:` and a plain sentence saying why. Questions and
parking are both good outcomes, not failures — a wrong guess costs her a
broken app before work.

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
    """Delete the crew's own branches once they're older than the TTL. Runs
    before the night's work so a long-abandoned branch never accumulates.

    Only branches a night run recorded are eligible. Spinoff worktrees share the
    `agent/` prefix, and a spinoff whose worktree was archived can leave a
    branch with commits nobody merged — a prefix match would force-delete that
    work at 14 days. Anything still checked out by a live worktree is refused
    by git anyway."""
    ours = {run.get("branch") for run in
            store.read("night_runs.json", {"runs": []}).get("runs", [])
            if isinstance(run, dict) and run.get("branch")}
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
        if when < cutoff and name in ours:
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
        if r.returncode != 0 and name == "pytest":
            inherited = failures_main_shares(failed_test_ids(out), env)
            if inherited:
                parts.append(f"pytest: ok — the only failures also fail on main, "
                             f"so not this change: {', '.join(inherited)}\n{tail}")
                continue
        if r.returncode != 0:
            green = False
        parts.append(f"{name}: {'ok' if r.returncode == 0 else 'FAILED'}\n{tail}")
    return green, "\n\n".join(parts)


def failed_test_ids(lines):
    """The test ids pytest's short summary lists as failed ("FAILED path::name
    - message"), in order."""
    ids = []
    for line in lines:
        if line.startswith("FAILED "):
            ids.append(line[len("FAILED "):].split(" - ", 1)[0].strip())
    return ids


def failures_main_shares(ids, env):
    """Were these failures already there before the change? Returns the ids
    when every one of them also fails in the live checkout (main), else [].

    This is the false-red guard again, for tests instead of the build. On
    2026-08-12..16 seven night runs were marked failed by one observatory test
    that was broken on main at the time — none of those changes touched it, and
    the cards said the crew's work had failed. Only the failing ids are rerun,
    so this costs seconds. An empty list (no ids parsed, a collection error,
    main passes) means the red stands."""
    if not ids:
        return []
    try:
        r = subprocess.run([str(SKELETON / "venv/bin/python3"), "-m", "pytest", "-q", *ids],
                           cwd=str(SKELETON), capture_output=True, text=True,
                           timeout=300, env=env)
    except subprocess.TimeoutExpired:
        return []
    out = ((r.stdout or "") + (r.stderr or "")).splitlines()
    return ids if set(failed_test_ids(out)) == set(ids) else []


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
            # precisely the opposite. Orchestra is the unattended room.
            "lane": "orchestra",
            # But Orchestra's act-vs-ask gate is OFF for this crew: the gate
            # raises an Approve/Deny card and waits, and at midnight nobody
            # answers — the first real night (2026-08-05) had workers denied
            # plain grep and limping through read-only. This crew's safety is
            # structural instead: cwd is a throwaway worktree, the brief
            # forbids git-writes/services, this script does the committing,
            # and nothing merges without her. (_conv_config honors an explicit
            # per-session override over the lane default.)
            "act_gate": False,
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

    # conv_id rides along so the spawned process carries EXOCORTEX_CONV_ID in
    # its environment. Without it, procmem.py can't attribute this turn's
    # memory to the card it's sitting behind — and a card silently showing
    # nothing reads as "using no memory", which is a lie.
    bot = dict(rr._bot("keeper") or {}, allowed_tools=TOOLS, conv_id=conv_id)
    proc, stderr_f = rr._spawn(bot, brief, None, cwd_override=str(worktree))
    rr._run_turn(proc, stderr_f, conv_id, log_path, None, queue.Queue())

    entry = store.read("bot_chats/index", {}).get(conv_id, {})
    return (conv_id, entry.get("cost_usd") or 0.0,
            last_assistant_text(log_path), entry.get("last_error"))


# --- records ----------------------------------------------------------------

def record(run):
    with store.mutate("night_runs.json", {"runs": []}) as data:
        data.setdefault("runs", []).append(run)


def already_pending(note):
    """Skip a note that already has an undismissed card waiting for her — the
    crew must not re-attempt work she simply hasn't looked at yet, or one
    ignored morning turns into three identical branches.

    UNLESS SHE'S EDITED THE NOTE SINCE. Each run records the note's text
    verbatim, so text-changed means she amended it — answered the worker's
    questions, sharpened the ask — and the whole design of the question loop
    is that her edit is the re-queue signal, no extra tap. A card whose
    recorded text differs from the note's current text no longer blocks.
    (A run with no recorded text is treated as blocking: can't-tell defaults
    to the cautious side.)

    A THROTTLED card doesn't count either way: nothing was attempted, and its
    card promises "still queued for tomorrow" — so tomorrow must actually pick
    the note up, dismissed or not."""
    for r in store.read("night_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("note_id") == note["id"] and not r.get("dismissed"):
            if r.get("throttled"):
                continue
            if "note_text" in r and r.get("note_text") != note["text"]:
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
        entry["schedule"] = "30 3 * * *"
        entry["schedule_human"] = "Nightly, 3:30–5 AM"
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
            # A QUESTIONS: block outranks everything else an empty diff could
            # mean: the worker read the code and is asking for the words it
            # needs. The questions go on the note itself as well as this card,
            # and her editing the note is what re-queues it (already_pending).
            questions = parse_questions(last)
            if questions:
                try:
                    annotate_note_questions(note, questions)
                except Exception as e:
                    log(f"[{note['id']}] couldn't annotate the note: "
                        f"{type(e).__name__}: {e}")
                return {**base, "status": "parked", "question": questions,
                        "reason": "needs your word — it left questions on the "
                                  "note; edit the note to answer and it'll "
                                  "retry the next night"}
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

    tabs = store.read("dev_notes.json", {"tabs": {}}).get("tabs", {})
    eligible = triage.triage(tabs)["eligible"]
    queued = [n for n in eligible if not already_pending(n)]
    log(f"{len(eligible)} eligible, {len(queued)} not already waiting on her")

    # The crew's own initiative, by rung (see pick_mode):
    #   "picks" — write proposal cards only; her moons below still run, but
    #             nothing the crew picked is worked tonight.
    #   "full"  — top the night up to MAX_NOTES with nominate.py's picks, each
    #             approved on the note itself with `by: "crew"` so the record
    #             shows the crew lit it, not her (devnote_judgments.py). Her
    #             taps go first; they're fresher intent.
    mode = pick_mode()
    if mode == "picks":
        n = record_picks(tabs)
        log(f"pick-only mode: proposed {n} note(s), worked none of them")
    elif mode == "full":
        queued += self_queue(tabs, MAX_NOTES - len(queued))

    spent, done = 0.0, 0
    for note in queued[:MAX_NOTES]:
        # The window closes before the note does: checked before every note, the
        # same shape as the memory gate below, because a night that starts in
        # the window can run out of it.
        if datetime.now().hour >= LAST_START_HOUR:
            log(f"stopping: past {LAST_START_HOUR} AM — remaining notes stay queued "
                f"for tomorrow rather than crowding the morning")
            break
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
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
