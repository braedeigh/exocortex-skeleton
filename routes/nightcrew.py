"""Night crew — the overnight fix queue and the morning review surface.

Plain English: overnight, agents pick up dev notes she has green-lit, fix each
one in a throwaway git worktree on its own branch, run the tests, and stop.
Nothing merges and nothing touches the live checkout. In the morning this
endpoint hands the Observatory's third lane one card per attempt, so the whole
night is a short stack of finished things waiting for a yes or a no. A yes
(merge) goes live by itself — frontend build + a sudo-free gunicorn reload —
and a merged card grows a revert tap that undoes exactly that merge and goes
live again, so trying a change on the real site is a safe way to review it.

Two files back it, both in the vault:
  - dev_notes.json  — her notes; `night: true` is the green light (lock 1).
    Set by her moon tap OR by the crew nominating for itself
    (tools/nightcrew/nominate.py, oldest never-answered notes first); either
    way the moon shows lit and un-mooning is a permanent no. A worker that
    found a note ambiguous leaves `night_questions` on it; she answers by
    editing the note, which clears the questions and re-queues it.
  - night_runs.json — one record per attempt, written by the overnight worker

Eligibility is NOT decided here. It lives in tools/nightcrew/triage.py so it
can be unit-tested away from HTTP, and because the rule that matters (a filter
checks facts, it never judges) is easier to hold in one small pure module.

Touches: tools/nightcrew/triage.py, store.py, frontend NightCrewLane.tsx.

Prompt that produced this: "automate the easy tasks and make like a checklist
of things it has done for me so I can go see what it did ... these fixes run at
night."
"""
import os
import re
import signal
import subprocess
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from flask import jsonify, request, send_file

import store
from tools.nightcrew import triage

SKELETON = Path(__file__).resolve().parents[1]

# The verdicts a finished attempt can carry. `ready` is the only one that
# offers a merge; the other two are informational and cost her a tap to clear.
TERMINAL = ("ready", "failed", "parked")


def _set_live(run_id, value):
    """One line of go-live status on the run record ("building the
    frontend…", "live", "stuck: …") — the card reads it verbatim."""
    with store.mutate("night_runs.json", {"runs": []}) as data:
        for r in data.get("runs", []) or []:
            if isinstance(r, dict) and r.get("id") == run_id:
                r["live"] = value


# How long a go-live waits for live turns to end before giving up and leaving
# the reload for later. Long enough for an ordinary turn; short enough that one
# wedged session can't hold a merge hostage all morning.
_QUIET_WAIT_SEC = 300
_QUIET_POLL_SEC = 10


def _live_turn_count():
    """How many conversations are mid-turn right now, judged by
    _effective_running rather than the bare `running` flag — so a session
    stranded by an earlier crash can't block a reload forever.

    Cross-worker this leans on `last_at`, which the turn relay heartbeats
    every 30s (observatory._HEARTBEAT_SEC); without that heartbeat this count
    would go blind to any turn older than ten minutes, which is exactly the
    kind of long turn most worth not cutting off.

    Imported lazily because routes.observatory drags in a good deal of the app
    and this module is imported at startup."""
    from routes.observatory import _effective_running
    index = store.read("bot_chats/index", {})
    if not isinstance(index, dict):
        return 0
    return sum(1 for conv_id, entry in index.items()
               if isinstance(entry, dict) and _effective_running(conv_id, entry))


def _wait_for_quiet(run_id, sleep_fn=time.sleep, now_fn=time.monotonic):
    """Wait until nothing is mid-turn, up to _QUIET_WAIT_SEC. True if the room
    went quiet (or already was), False if it timed out with a turn still live.
    Injected clock/sleep so the tests don't."""
    deadline = now_fn() + _QUIET_WAIT_SEC
    announced = False
    while True:
        busy = _live_turn_count()
        if not busy:
            return True
        if now_fn() >= deadline:
            return False
        if not announced:
            _set_live(run_id, f"built — holding the reload while {busy} live "
                              f"session{'' if busy == 1 else 's'} finish"
                              f"{'es' if busy == 1 else ''}…")
            announced = True
        sleep_fn(_QUIET_POLL_SEC)


def _go_live(run_id):
    """Make the checkout that just changed (merge or revert) BE the running
    site: rebuild the frontend, then signal gunicorn's master to reload.

    Why this is sudo-free: the frontend is static files served from
    frontend/dist/, so a rebuild is live on the next refresh — and the
    service template runs gunicorn WITHOUT --preload, so a SIGHUP to the
    master (this worker's parent process) gracefully re-imports the Python
    code into fresh workers. No systemctl, no root. The healthcheck timer
    (deploy/exocortex-healthcheck.*) is the net under the reload.

    Runs in a background thread (_start_go_live): the build takes ~30s and
    the merge response shouldn't hang on it. Progress lands on the run
    record via _set_live, which the card shows verbatim.

    The reload is graceful for HTTP and brutal for agents: fresh workers
    replace the old ones, and a live turn's relay thread lives INSIDE a
    worker, so reloading mid-turn kills the relay and strands the reply
    half-written. Tapping Approve is not a request to stop whatever else is
    talking, so this waits for the room to go quiet first.
    """
    build = subprocess.run(["npm", "run", "build"],
                           cwd=str(SKELETON / "frontend"),
                           capture_output=True, text=True, timeout=900)
    if build.returncode != 0:
        tail = ((build.stdout or "") + (build.stderr or "")).strip().splitlines()[-3:]
        _set_live(run_id, "stuck: the frontend build failed — the change is "
                          "merged but the site still runs the old build. "
                          + " / ".join(tail))
        return
    if not _wait_for_quiet(run_id):
        _set_live(run_id, "built and merged, reload held — a session is still "
                          "mid-turn and reloading now would cut its reply off. "
                          "The change goes live on the next reload or restart.")
        return
    try:
        # This worker's parent IS the gunicorn master. PID 1 would mean
        # there's no master over us (a dev run) — nothing to reload.
        ppid = os.getppid()
        if ppid > 1:
            os.kill(ppid, signal.SIGHUP)
    except OSError as e:
        _set_live(run_id, f"stuck: built, but the reload signal failed ({e}) "
                          "— restart the service to finish going live")
        return
    _set_live(run_id, "live")


def _start_go_live(run_id):
    """The thread wrapper tests stub out — nothing else belongs here."""
    _set_live(run_id, "going live — building the frontend…")
    threading.Thread(target=_go_live, args=(run_id,), daemon=True).start()


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _runs():
    data = store.read("night_runs.json", {"runs": []})
    runs = data.get("runs", []) if isinstance(data, dict) else []
    return [r for r in runs if isinstance(r, dict)]


def _notes():
    return store.read("dev_notes.json", {"tabs": {}}).get("tabs", {})


def register(app):

    @app.route("/api/nightcrew")
    def nightcrew_state():
        """Everything the third lane draws, in one call.

        `queue` is what tonight would attempt; `runs` is what last night did.
        They're returned together because the lane shows both at once — the
        morning question is "what happened" and "what's teed up next", and
        splitting them into two round-trips would only make the lane flicker.
        """
        result = triage.triage(_notes())
        runs = list(_runs())
        for r in runs:
            r.setdefault("source", "night")

        # EVERY finished branch belongs in this room, not just the night crew's.
        # The room was never about a crew — its own header says so: it's the
        # finished-and-waiting room, defined by STATE rather than by who made
        # the work. A daytime session's branch is in exactly that state, and it
        # was showing up nowhere here while a separate page answered the same
        # question in different words. Two surfaces answering "what's waiting
        # for me?" is how a system starts disagreeing with itself.
        #
        # Keyed by BRANCH so nothing is drawn twice, and the night run wins the
        # tie: it carries screenshots, a real test result and a merge path that
        # a bare branch has none of. A night run that never got a branch (it
        # broke before the worktree existed) is already in `runs` and nothing
        # here drops it.
        from routes import branches as branch_source
        seen = {r.get("branch") for r in runs if r.get("branch")}
        runs += [branch_source.as_card(b) for b in branch_source.collect()
                 if b["branch"] not in seen]

        # Cards that ask something of her float to the top — ready (a merge
        # tap), then picked (a would-you-want judgment), then still-being-built,
        # then failed, then parked; same law the other two lanes use. Sorted
        # AFTER the two sources are joined, so a branch and a night run of the
        # same age sit together rather than in two blocks: newest first inside
        # a status (the stable first sort), then status (the second).
        runs.sort(key=lambda r: r.get("finished") or "", reverse=True)
        order = {"ready": 0, "picked": 1, "working": 2, "failed": 3, "parked": 4}
        runs.sort(key=lambda r: order.get(r.get("status"), 5))

        return jsonify({
            "queue": result["eligible"],
            "turned_away": result["rejected"],
            "runs": runs,
            "spend": {
                # "Last night" has to mean last night: the header figure counts
                # only runs finished in the past 24h. The all-time total rides
                # along so a month of quiet $2 nights stays visible somewhere.
                "night_usd": round(sum(
                    r.get("cost_usd") or 0 for r in runs
                    if (r.get("finished") or "") >= (datetime.now() - timedelta(days=1)).isoformat(timespec="seconds")
                ), 2),
                "total_usd": round(sum(r.get("cost_usd") or 0 for r in runs), 2),
            },
        })

    @app.route("/api/nightcrew/notes/<note_id>/greenlight", methods=["POST"])
    def nightcrew_greenlight(note_id):
        """Her ✓ — lock 1. Flips `night` on one dev note.

        Inline on the note card by design (Terra's cut): a separate triage page
        is a threshold, and thresholds don't get crossed at 11 PM. The tap is
        allowed to be wrong; triage.py is the net under it, and the response
        says immediately whether the net caught it so the card can show her.
        """
        want = bool((request.get_json(silent=True) or {}).get("night", True))
        found = None
        with store.mutate("dev_notes.json", {"tabs": {}}) as data:
            for notes in (data.get("tabs") or {}).values():
                for note in notes or []:
                    if isinstance(note, dict) and note.get("id") == note_id:
                        note["night"] = want
                        found = dict(note)
        if found is None:
            return jsonify({"ok": False, "error": "no such note"}), 404

        eligible, reason = triage.check(found)
        return jsonify({"ok": True, "night": want,
                        "eligible": eligible, "reason": reason})

    @app.route("/api/nightcrew/shot/<run_id>/<name>")
    def nightcrew_shot(run_id, name):
        """A before/after PNG for one run.

        These images are photographs of her actual app with her actual data in
        it — journal text, names, health notes. They live in the VAULT
        (EXOCORTEX_DATA_DIR/nightcrew_shots/), never in this shareable repo,
        and this route sits behind the app's normal auth gate like every other
        /api path.

        Both path segments are whitelisted rather than sanitised: `..`, slashes
        and anything else outside the allowed shapes simply don't match, so
        there's no traversal to get wrong.
        """
        if name not in ("before.png", "after.png"):
            return jsonify({"error": "no such shot"}), 404
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", run_id or ""):
            return jsonify({"error": "bad run id"}), 400
        path = (store.DATA_DIR / "nightcrew_shots" / run_id / name).resolve()
        root = (store.DATA_DIR / "nightcrew_shots").resolve()
        if not path.is_file() or root not in path.parents:
            return jsonify({"error": "no such shot"}), 404
        return send_file(path, mimetype="image/png")

    @app.route("/api/nightcrew/runs/<run_id>/merge", methods=["POST"])
    def nightcrew_merge(run_id):
        """Her tap — the ONE place a night branch reaches the live checkout.

        Everything upstream of this is deliberately incapable of touching the
        real tree, which is what makes an unattended crew safe. So this is the
        single guarded door, and it refuses on anything it isn't sure about:

          - only a run she can actually see, in `ready` (a failed branch is
            kept for reading, never for merging)
          - only a fast-forward or a clean --no-ff merge; a conflict aborts and
            reports, because resolving one is a conversation, not a tap
          - a dirty working tree blocks it. She keeps uncommitted work on main;
            merging under it would tangle her changes with the crew's and
            she'd have no clean way to tell them apart.

        A merge that lands GOES LIVE by itself (_start_go_live: frontend
        build + gunicorn reload). It used to stop at "merged locally" and
        leave rebuild/restart as her manual act — which quietly meant
        "merged" wasn't "live" until she remembered, the one gap guaranteed
        to confuse at 6 AM. Approve now means approve. The merge commit's
        sha is recorded so /revert can undo exactly this change later.
        [prompt: "if I approve it … that merges to the production server" /
        "Build the things worth doing"]
        """
        run = next((r for r in _runs() if r.get("id") == run_id), None)
        if run is None:
            return jsonify({"ok": False, "error": "no such run"}), 404
        if run.get("status") != "ready":
            return jsonify({"ok": False,
                            "error": f"only a ready run can merge (this one is "
                                     f"{run.get('status')})"}), 409
        branch = run.get("branch")
        if not branch or not branch.startswith("agent/"):
            return jsonify({"ok": False, "error": "run has no agent/ branch"}), 409

        # Tracked modifications only (-uno): those are what a merge would tangle
        # with. An untracked scratch file can't corrupt a merge — git aborts by
        # itself if one would be overwritten — and letting one block the door
        # would freeze the whole lane behind any stray draft in the checkout.
        dirty = subprocess.run(["git", "-C", str(SKELETON), "status", "--porcelain",
                                "--untracked-files=no"],
                               capture_output=True, text=True).stdout.strip()
        if dirty:
            return jsonify({"ok": False,
                            "error": "you have uncommitted changes — commit or stash "
                                     "them first so the crew's work stays separable"}), 409

        merged = subprocess.run(
            ["git", "-C", str(SKELETON), "merge", "--no-ff", "-m",
             f"merge nightcrew {branch}: {run.get('note_text', '')[:60]}", branch],
            capture_output=True, text=True)
        if merged.returncode != 0:
            subprocess.run(["git", "-C", str(SKELETON), "merge", "--abort"],
                           capture_output=True)
            return jsonify({"ok": False,
                            "error": "wouldn't merge cleanly — aborted, nothing changed",
                            "detail": (merged.stdout or merged.stderr).strip()[:400]}), 409

        sha = subprocess.run(["git", "-C", str(SKELETON), "rev-parse", "HEAD"],
                             capture_output=True, text=True).stdout.strip()
        with store.mutate("night_runs.json", {"runs": []}) as data:
            for r in data.get("runs", []) or []:
                if isinstance(r, dict) and r.get("id") == run_id:
                    r["status"] = "merged"
                    r["merged_at"] = _now()
                    if sha:
                        r["merge_commit"] = sha
        _start_go_live(run_id)
        return jsonify({"ok": True, "branch": branch,
                        "note": "merged — going live now (frontend build + "
                                "reload); give it ~30 seconds"})

    @app.route("/api/nightcrew/runs/<run_id>/revert", methods=["POST"])
    def nightcrew_revert(run_id):
        """The regret tap — undo of one merged run, and the thing that makes
        "merge it and just use production" a safe way to review: she's the
        only user, so trying a change live costs nothing once backing out is
        one tap. Same refusal discipline as the merge door:

          - only a `merged` run that recorded its merge commit (older records
            without one don't offer the button — reverting by guesswork is
            exactly the kind of sure-footedness this door must not fake)
          - a dirty tree blocks it, a conflicted revert aborts with nothing
            changed — resolving either is a conversation, not a tap.

        A revert that lands goes live the same way a merge does. The branch
        itself is untouched — the work survives for another look; only its
        landing on main is undone.
        [prompt: "a Revert button on merged cards" / "Build the things
        worth doing"]
        """
        run = next((r for r in _runs() if r.get("id") == run_id), None)
        if run is None:
            return jsonify({"ok": False, "error": "no such run"}), 404
        if run.get("status") != "merged":
            return jsonify({"ok": False,
                            "error": f"only a merged run can revert (this one is "
                                     f"{run.get('status')})"}), 409
        sha = run.get("merge_commit")
        if not sha:
            return jsonify({"ok": False,
                            "error": "this run predates revert support — its merge "
                                     "commit wasn't recorded, so undo it by hand"}), 409

        dirty = subprocess.run(["git", "-C", str(SKELETON), "status", "--porcelain",
                                "--untracked-files=no"],
                               capture_output=True, text=True).stdout.strip()
        if dirty:
            return jsonify({"ok": False,
                            "error": "you have uncommitted changes — commit or stash "
                                     "them first so the undo stays separable"}), 409

        # -m 1 names the mainline parent: "undo what the merge brought in,
        # keep everything that was already on main".
        reverted = subprocess.run(
            ["git", "-C", str(SKELETON), "revert", "--no-edit", "-m", "1", sha],
            capture_output=True, text=True)
        if reverted.returncode != 0:
            subprocess.run(["git", "-C", str(SKELETON), "revert", "--abort"],
                           capture_output=True)
            return jsonify({"ok": False,
                            "error": "wouldn't revert cleanly — aborted, nothing changed",
                            "detail": (reverted.stdout or reverted.stderr).strip()[:400]}), 409

        with store.mutate("night_runs.json", {"runs": []}) as data:
            for r in data.get("runs", []) or []:
                if isinstance(r, dict) and r.get("id") == run_id:
                    r["status"] = "reverted"
                    r["reverted_at"] = _now()
        _start_go_live(run_id)
        return jsonify({"ok": True,
                        "note": "reverted — going live now; the branch is still "
                                "there if you want another look"})

    @app.route("/api/nightcrew/runs/<run_id>/feedback", methods=["POST"])
    def nightcrew_feedback(run_id):
        """One line of her judgment onto a run record — why she discarded a
        ready run, cleared a parked one, or regretted a merge. It lands in
        night_runs.json, which already keeps failure reasons forever on the
        principle that the branch is the corpse and the lesson is the humus;
        her verdicts are the same soil. Read back in the tune-up sitting,
        never analyzed automatically.
        [prompt: "for maybe the first week or so … record what I wanted it
        to do or disapproved of so we can iterate on it"]"""
        note = ((request.get_json(silent=True) or {}).get("note") or "").strip()
        if not note:
            return jsonify({"ok": False, "error": "note required"}), 400
        hit = False
        with store.mutate("night_runs.json", {"runs": []}) as data:
            for run in data.get("runs", []) or []:
                if isinstance(run, dict) and run.get("id") == run_id:
                    run["her_note"] = note
                    hit = True
        return (jsonify({"ok": True}) if hit
                else (jsonify({"ok": False, "error": "no such run"}), 404))

    @app.route("/api/nightcrew/runs/<run_id>/pick", methods=["POST"])
    def nightcrew_pick_verdict(run_id):
        """Her judgment on a "picked" card (pick-only mode — the crew proposes,
        works nothing). Two verdicts:

          approve — "would want this": recorded on the card only. Deliberately
            NOT a moon: the point of the phase is judging the picking, and the
            approvals become the ready-made queue when she turns making on.
          reject — "not this": recorded, and writes the sticky night:false on
            the note itself, so the nominator never proposes it again (the
            refugium rule — re-proposing a spared note is how trust dies).

        Either verdict can carry a why (`note`), same soil as /feedback.
        """
        data_in = request.get_json(silent=True) or {}
        verdict = data_in.get("verdict")
        if verdict not in ("approve", "reject"):
            return jsonify({"ok": False, "error": "verdict must be approve or reject"}), 400
        note = (data_in.get("note") or "").strip()
        run = next((r for r in _runs() if r.get("id") == run_id), None)
        if run is None:
            return jsonify({"ok": False, "error": "no such run"}), 404
        if run.get("status") != "picked":
            return jsonify({"ok": False,
                            "error": f"only a picked card takes this (this one is "
                                     f"{run.get('status')})"}), 409
        with store.mutate("night_runs.json", {"runs": []}) as data:
            for r in data.get("runs", []) or []:
                if isinstance(r, dict) and r.get("id") == run_id:
                    r["verdict"] = verdict
                    r["judged_at"] = _now()
                    if note:
                        r["her_note"] = note
                    r["dismissed"] = True   # judged is answered — off the stack
        if verdict == "reject":
            with store.mutate("dev_notes.json", {"tabs": {}}) as notes:
                for tab_notes in (notes.get("tabs") or {}).values():
                    for n in tab_notes or []:
                        if isinstance(n, dict) and n.get("id") == run.get("note_id"):
                            n["night"] = False
        return jsonify({"ok": True, "verdict": verdict})

    @app.route("/api/nightcrew/runs/<run_id>/dismiss", methods=["POST"])
    def nightcrew_dismiss(run_id):
        """Clear one card off the morning stack.

        Only ever marks the record dismissed — the branch itself is left for
        the 14-day sweep, and a failed run's reason is kept forever so the next
        worker on that note can read why the last one couldn't (Terra: the
        branch is the corpse, the lesson is the humus).
        """
        hit = False
        with store.mutate("night_runs.json", {"runs": []}) as data:
            for run in data.get("runs", []) or []:
                if isinstance(run, dict) and run.get("id") == run_id:
                    run["dismissed"] = True
                    hit = True
        return (jsonify({"ok": True}) if hit
                else (jsonify({"ok": False, "error": "no such run"}), 404))
