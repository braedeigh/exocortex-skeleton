#!/usr/bin/env python3
"""nightly_tests.py — run the whole test suite at night, and send an agent after what broke.

Plain English: during the day, sessions run only the tests their change could
affect (pytest-testmon, see CLAUDE.md "Testing"). That misses a few things —
changes to data files, code that only runs inside a subprocess — so once a
night, from cron, this runs EVERYTHING. It also rebuilds testmon's record of
which test touches which code, so the next day's picks start from a full,
fresh map.

If tests fail, each failure is re-run once on its own. One that passes alone
is listed as flaky rather than broken. Anything still failing becomes a brief,
and a Coding session is opened on it (the spinoff door, routes/spinoff.py),
already working — nobody has to open it. The brief tells it to fix what is
plainly a broken test or a small bug and commit that, to leave anything bigger
for the owner, and to MESSAGE the session that owns the half-finished work
rather than "fixing" a test to match it.

Nothing fails → no session, just a line in the log and a job_runs row.

Touches: routes/spinoff.py (open_spinoff), store.SPINOFF_DIR (the brief),
jobstore.py (the run record), scheduled_runs.json (the Automations pause
switch, id "nightly_tests"), tests/test_nightly_tests.py.

Prompt that produced this: "maybe run the full suite at night and then deploy
an agent to fix them ... run it at 4 am. it should commit fixes as long as they
don't change anything too crazy about the app. but it has to coordinate with
whatever agent is in that session maybe"
"""
import argparse
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKELETON))

import store  # noqa: E402

RUN_ID = "nightly_tests"
PYTHON = str(SKELETON / "venv" / "bin" / "python3")
# Where each night's output lands. /var/tmp, not /tmp: it survives a reboot.
OUT_ROOT = Path(os.environ.get("EXOCORTEX_NIGHTLY_TESTS_DIR", "/var/tmp/exo-nightly-tests"))
SUITE_TIMEOUT = 3 * 60 * 60     # a hung suite gives up after three hours
RERUN_TIMEOUT = 20 * 60
# Pytest's end-of-run summary lines: "FAILED tests/x.py::test_y - message".
_SUMMARY_RE = re.compile(r"^(FAILED|ERROR) (\S+)(?: - (.*))?$")


def enabled():
    """The Automations page's pause switch — same contract every cron script
    here honors, so this can be turned off without touching crontab."""
    for r in store.read("scheduled_runs.json", {"runs": []}).get("runs", []):
        if isinstance(r, dict) and r.get("id") == RUN_ID:
            return r.get("enabled", True)
    return True


def parse_failures(output):
    """Pull the failing test ids (and their one-line reasons) out of pytest's summary.

    Returns a dict of node id -> reason, in the order pytest listed them. A
    test that shows up as both FAILED and ERROR (a failure plus a broken
    teardown) is listed once."""
    failures = {}
    for line in output.splitlines():
        match = _SUMMARY_RE.match(line.strip())
        if match and match.group(2) not in failures:
            failures[match.group(2)] = (match.group(3) or match.group(1)).strip()
    return failures


def run_pytest(args, log_path, timeout):
    """Run pytest in the checkout, teeing its output to a log. Returns (exit code, output)."""
    command = [PYTHON, "-m", "pytest", "-q", "-rfE", "--tb=short", *args]
    try:
        done = subprocess.run(command, cwd=SKELETON, capture_output=True, text=True,
                              timeout=timeout)
        output, code = done.stdout + done.stderr, done.returncode
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or b"").decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        output += f"\n[nightly_tests] gave up after {timeout}s\n"
        code = -1
    log_path.write_text(output)
    return code, output


def split_flaky(failures, out_dir):
    """Re-run the failures once, alone. Returns (still failing, passed alone).

    Alone means in one small run of just these tests, without the other
    thousands around them — a test that passes there was failing because of
    ordering, timing or load, not because the code is broken."""
    if not failures:
        return {}, {}
    _, output = run_pytest(list(failures), out_dir / "rerun.log", RERUN_TIMEOUT)
    again = parse_failures(output)
    # Anything that didn't show up as failing the second time passed alone.
    still = {node: again.get(node, reason) for node, reason in failures.items() if node in again}
    flaky = {node: reason for node, reason in failures.items() if node not in again}
    return still, flaky


def write_brief(slug, still, flaky, out_dir, duration_min):
    """Write the fixer session's brief into SPINOFF_DIR/<slug>/BRIEF.md."""
    brief_dir = store.SPINOFF_DIR / slug
    brief_dir.mkdir(parents=True, exist_ok=True)
    failing = "\n".join(f"- `{node}` — {reason}" for node, reason in still.items())
    flaky_lines = "\n".join(f"- `{node}` — {reason}" for node, reason in flaky.items()) or "- none"
    text = f"""# Nightly test run — {len(still)} failing

The full suite ran at {datetime.now():%Y-%m-%d %H:%M} ({duration_min:.0f} min).
Full output: `{out_dir / 'suite.log'}`. The re-run of just the failures: `{out_dir / 'rerun.log'}`.

## Still failing when re-run alone

{failing}

## Failed in the full run but passed alone (flaky — note them, don't chase them)

{flaky_lines}

## Protocol

You're the night's test fixer, working in the live skeleton checkout, unattended.
Other agent sessions may be working in this same checkout. Go one failure (or one
cluster with the same cause) at a time:

1. **Find out whose it is before touching it.** For the test and the code it
   exercises: `git status` / `git diff` (uncommitted work), `git log -3 -- <file>`,
   and who's been editing it lately —
   `./venv/bin/python3 scripts/exo_query.py` against `tool_calls` (writes to that
   path in the last 48h, and which conversation made them), then
   `./venv/bin/python3 scripts/peers.py list`.
2. **If a live or recent session owns unfinished work there** (uncommitted
   changes, or it edited those files and hasn't committed), don't fix it
   yourself. Tell it: `./venv/bin/python3 scripts/peers.py send <id> --queue "..."`
   naming the failing test and what the failure says. Never change a test just
   to match someone's half-built change.
3. **Otherwise, fix it** — and find the real cause: is the test wrong, or the code?
4. **Commit only modest fixes, one commit per cause**, staging only the files you
   changed (`git add <paths>`, never `-A`). Modest = a stale or brittle test, a
   list that needs a new entry, a small bug fix that doesn't change what the app
   does for the owner. **Don't commit** anything that changes behavior she'd
   notice, touches the database schema or her data, removes a feature, or runs
   past about 50 lines: leave those uncommitted-and-described, or undone, for her.
5. Re-run the tests you touched (`./venv/bin/python3 -m pytest <file> -q`) before
   each commit. Python edits need `kill -HUP` of the gunicorn master to go live
   (never `systemctl restart`); test-only edits need nothing.

End with a short report: what you fixed and committed, what you handed to which
session, what you left for her and why, and the flaky list.
"""
    (brief_dir / "BRIEF.md").write_text(text)
    return brief_dir / "BRIEF.md"


def open_fixer(slug):
    """Open the Coding session that works the brief. Returns open_spinoff's reply."""
    from routes.spinoff import open_spinoff
    payload, _status = open_spinoff(slug, lane="coding", via="nightly")
    return payload


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--no-agent", action="store_true",
                        help="run and report, but don't open a fixer session")
    args = parser.parse_args(argv)

    import jobstore
    with jobstore.run(RUN_ID) as record:
        if not enabled():
            record.skip("disabled")
            print(f"{datetime.now():%F %T} paused on the Automations page")
            return 0

        # Run everything, and have testmon record the whole map while it's at it.
        out_dir = OUT_ROOT / datetime.now().strftime("%Y-%m-%d")
        out_dir.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        code, output = run_pytest(["--testmon-noselect"], out_dir / "suite.log", SUITE_TIMEOUT)
        duration_min = (time.monotonic() - started) / 60
        failures = parse_failures(output)
        record.looked(1)
        tail = output.strip().splitlines()[-1:] or [""]
        print(f"{datetime.now():%F %T} suite exit {code} in {duration_min:.1f} min: {tail[0]}")

        # A crash before any summary (collection blew up, timeout) is still a failure worth a look.
        if code not in (0, 1) and not failures:
            failures = {"(the suite itself)": f"pytest exited {code} — see suite.log"}
        if not failures:
            return 0

        still, flaky = split_flaky({k: v for k, v in failures.items() if "::" in k or k.endswith(".py")}, out_dir)
        if "(the suite itself)" in failures:
            still["(the suite itself)"] = failures["(the suite itself)"]
        print(f"  {len(still)} still failing, {len(flaky)} passed alone")
        if not still:
            return 0

        # Hand the rest to a fixer session.
        record.failed(len(still), f"{len(still)} tests failing")
        slug = f"nightly-tests-{datetime.now():%Y%m%d}"
        write_brief(slug, still, flaky, out_dir, duration_min)
        if args.no_agent:
            print(f"  brief at {store.SPINOFF_DIR / slug / 'BRIEF.md'} (no agent)")
            return 0
        reply = open_fixer(slug)
        print(f"  fixer: {reply}")
        record.acted(1)
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
