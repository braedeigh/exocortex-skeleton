"""Night crew — the overnight fix queue and the morning review surface.

Plain English: overnight, agents pick up dev notes she has green-lit, fix each
one in a throwaway git worktree on its own branch, run the tests, and stop.
Nothing merges and nothing touches the live checkout. In the morning this
endpoint hands the Observatory's third lane one card per attempt, so the whole
night is a short stack of finished things waiting for a yes or a no.

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
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

from flask import jsonify, request, send_file

import store
from tools.nightcrew import triage

SKELETON = Path(__file__).resolve().parents[1]

# The verdicts a finished attempt can carry. `ready` is the only one that
# offers a merge; the other two are informational and cost her a tap to clear.
TERMINAL = ("ready", "failed", "parked")


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

        # Ready first, then still-being-built, then failed, then parked — the
        # only card that asks anything of her floats to the top, the same law
        # the other rooms use. Sorted AFTER the two sources are joined, so a
        # branch and a night run of the same age sit together rather than in
        # two blocks: newest first inside a status (the stable first sort),
        # then status (the second).
        runs.sort(key=lambda r: r.get("finished") or "", reverse=True)
        order = {"ready": 0, "working": 1, "failed": 2, "parked": 3}
        runs.sort(key=lambda r: order.get(r.get("status"), 4))

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

        It does NOT restart the service or rebuild the frontend — that stays
        her deliberate act, so a merge can never change what's running under
        her without her knowing.
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

        with store.mutate("night_runs.json", {"runs": []}) as data:
            for r in data.get("runs", []) or []:
                if isinstance(r, dict) and r.get("id") == run_id:
                    r["status"] = "merged"
                    r["merged_at"] = _now()
        return jsonify({"ok": True, "branch": branch,
                        "note": "merged locally — rebuild the frontend and restart "
                                "the service when you're ready for it to go live"})

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
