#!/usr/bin/env python3
"""shots.py — before/after screenshots of a night crew change.

Plain English: she reads her own app, not diffs. So the morning card leads with
two pictures of the same page — one from the code before the fix, one from
after — and a glance answers "is this right?" faster than any amount of text.
This file takes those two pictures.

HOW IT AVOIDS TOUCHING ANYTHING REAL. Each shot needs the app actually running,
which means a server, which means data. So:

  - the server is a THROWAWAY on a free port, and BOTH shots are served from
    the worktree — "before" by stashing the agent's change and popping it back
    (see capture_pair for why the live checkout is the wrong "before")
  - it reads a SCRATCH COPY of the data: the top-level *.json files (about
    1.6 MB) are copied out once, and the throwaway server opens only the copy.
    The heavy directories (uploads-archive, bot_chats, archivals — 550 MB
    between them) hold media and logs no page needs to render, so they're
    left behind entirely.
  - auth is a throwaway too: a fresh random HMAC secret is minted per run and
    handed to the temporary server via EXO_PROXY_SECRET_FILE, so the browser
    can present a valid X-Exo-Proxied header without any real credential
    existing anywhere. Without this every screenshot would be of the login page.
  - the Playwright helper script is written into the WORKTREE's frontend/, not
    the live checkout's, so this process keeps the night run's promise that
    nothing under the real repo is written to.

WHICH PAGE TO PHOTOGRAPH is read out of the router rather than guessed: a
changed file under frontend/src/features/<name>/ is matched to whichever
frontend/src/routes/*.tsx actually imports that feature. That stays correct as
routes move, because it's reading the real thing.

Touches: scripts/nightcrew_run.py (calls capture_pair after a green verify),
routes/nightcrew.py (serves the PNGs), tests/test_nightcrew_shots.py.
"""
import hashlib
import hmac
import json
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path

SKELETON = Path(__file__).resolve().parents[2]

# How long to wait for a throwaway server to answer before giving up. A shot is
# a nice-to-have: it must never hold up or fail a run that otherwise passed.
BOOT_TIMEOUT = 25
SHOT_TIMEOUT = 60


# --- which page? ------------------------------------------------------------

def features_touched(changed):
    """Feature-module names appearing in a list of repo-relative paths."""
    out = []
    for path in changed:
        m = re.match(r"frontend/src/features/([^/]+)/", path)
        if m and m.group(1) not in out:
            out.append(m.group(1))
    return out


def route_for(changed, routes_dir=None):
    """The URL path most likely to show this change, or None.

    Reads the real router: a route file that imports the changed feature wins.
    Falls back to a direct hit on frontend/src/routes/<name>.tsx, and gives up
    honestly rather than guessing — a screenshot of the wrong page is worse
    than no screenshot, because it looks like evidence.
    """
    routes_dir = Path(routes_dir or (SKELETON / "frontend/src/routes"))

    # A changed route file names its own page.
    for path in changed:
        m = re.match(r"frontend/src/routes/([A-Za-z0-9_-]+)\.tsx$", path)
        if m:
            return "/" if m.group(1) == "index" else f"/{m.group(1)}"

    feats = features_touched(changed)
    if not feats or not routes_dir.is_dir():
        return None
    for feat in feats:
        needle = f"features/{feat}/"
        for route_file in sorted(routes_dir.glob("*.tsx")):
            try:
                if needle in route_file.read_text(encoding="utf-8"):
                    stem = route_file.stem
                    if stem == "index":
                        return "/"
                    # `bots_.$botId` and friends are parameterised — they need
                    # an id we don't have, so they're not photographable.
                    if "$" in stem:
                        continue
                    return "/" + stem.replace("_", "").split(".")[0]
            except OSError:
                continue
    return None


# --- throwaway auth ---------------------------------------------------------

def mint_header(secret_hex, slug="nightcrew", now=None):
    """A valid X-Exo-Proxied value for the throwaway server's secret."""
    ts = int(now if now is not None else time.time())
    msg = f"{slug}:{ts}"
    mac = hmac.new(bytes.fromhex(secret_hex), msg.encode(), hashlib.sha256).hexdigest()
    return f"{msg}:{mac}"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def scratch_data(real_data_dir, dest):
    """A copy of just the JSON the pages read. Deliberately shallow — the big
    media directories are what make the real data dir 500 MB+, and no rendered
    page needs them."""
    dest.mkdir(parents=True, exist_ok=True)
    for f in Path(real_data_dir).glob("*.json"):
        try:
            shutil.copy2(f, dest / f.name)
        except OSError:
            pass
    return dest


# --- the server + the browser -----------------------------------------------

def serve(checkout, data_dir, port, secret_file):
    """Start the app from `checkout` on `port`. Returns the process, or None.

    Uses the Flask dev server rather than gunicorn: one worker, one process to
    kill, and nothing here serves traffic to anyone but a local browser.
    """
    env = {
        **os.environ,
        "EXOCORTEX_DATA_DIR": str(data_dir),
        "EXO_PROXY_SECRET_FILE": str(secret_file),
        "FLASK_APP": "server:app",
    }
    proc = subprocess.Popen(
        [str(SKELETON / "venv/bin/python3"), "-c",
         f"import server; server.app.run(port={port}, threaded=True)"],
        cwd=str(checkout), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + BOOT_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            return None
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return proc
        except OSError:
            time.sleep(0.4)
    proc.kill()
    return None


_SHOT_JS = """
const { chromium } = require('playwright');
(async () => {
  const [url, header, out] = process.argv.slice(2);
  const browser = await chromium.launch();
  // A phone-shaped viewport: this is where she lives, and a desktop-width
  // shot would show her a layout she rarely sees.
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 900 },
    deviceScaleFactor: 2,
    extraHTTPHeaders: { 'X-Exo-Proxied': header },
  });
  const page = await ctx.newPage();
  // domcontentloaded, NOT networkidle: this app polls forever (the roster every
  // 5.5s, terrain while anything runs), so the network is never idle and
  // networkidle just burns the whole timeout and returns nothing.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // The SPA mounts after the document is ready, so wait for real content
  // rather than a fixed guess — then a short beat for fonts and layout.
  await page.waitForSelector('main, [class*="page"], [class*="card"]', { timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
"""


def shoot(url, header, out_path, frontend_dir):
    """One screenshot via the node Playwright already in devDependencies.

    `frontend_dir` is the WORKTREE's frontend — the helper script lands there,
    never in the live checkout (node_modules there is a symlink to the real
    one, which is how Playwright resolves)."""
    # .cjs, NOT .js: frontend/package.json is "type": "module", so a .js
    # file is parsed as ESM and `require` is undefined there.
    js = Path(frontend_dir) / ".nightcrew-shot.cjs"
    js.write_text(_SHOT_JS)
    try:
        r = subprocess.run(["node", str(js), url, header, str(out_path)],
                           cwd=str(frontend_dir), capture_output=True,
                           text=True, timeout=SHOT_TIMEOUT)
        return r.returncode == 0 and Path(out_path).exists()
    except (subprocess.TimeoutExpired, OSError):
        return False
    finally:
        js.unlink(missing_ok=True)


def _one(checkout, route, out_path, data_dir, secret_file, secret_hex):
    port = free_port()
    proc = serve(checkout, data_dir, port, secret_file)
    if proc is None:
        return False
    try:
        return shoot(f"http://127.0.0.1:{port}{route}",
                     mint_header(secret_hex), out_path,
                     Path(checkout) / "frontend")
    finally:
        proc.kill()
        proc.wait(timeout=10)


def _build(worktree):
    """Rebuild the SPA in the worktree. frontend/dist is gitignored, so what a
    browser sees is whatever was built last — without this the "after" shot
    would show the "before" code."""
    r = subprocess.run(["npm", "run", "build"], cwd=str(Path(worktree) / "frontend"),
                       capture_output=True, text=True, timeout=300)
    return r.returncode == 0


def _git(worktree, *args):
    return subprocess.run(["git", "-C", str(worktree), *args],
                          capture_output=True, text=True)


def capture_pair(worktree, changed, out_dir, real_data_dir, scratch_root=None):
    """Both shots from the SAME worktree, by stashing the change and popping it.

    Photographing "before" from the live checkout would be wrong: she keeps
    uncommitted work on main, so that image would differ from "after" by HER
    changes as well as the agent's, and the pair would quietly stop being a
    picture of what the agent did. Stashing inside the worktree makes the two
    images differ by exactly one thing.

    Call this AFTER verify and BEFORE commit — it needs the change still
    uncommitted in order to stash it.

    Returns {"route": str|None, "before": Path|None, "after": Path|None}. Every
    failure path yields None rather than raising: a run that fixed the note and
    passed its tests must never be downgraded because a browser wouldn't start.
    """
    result = {"route": None, "before": None, "after": None}
    worktree = Path(worktree)
    route = route_for(changed)
    if not route:
        return result
    result["route"] = route

    scratch = Path(scratch_root or f"/tmp/nightcrew-shots-{os.getpid()}")
    stashed = False
    try:
        data_dir = scratch_data(real_data_dir, scratch / "data")
        secret_hex = os.urandom(32).hex()
        secret_file = scratch / "proxy.secret"
        secret_file.write_text(secret_hex)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        # BEFORE: the agent's change set aside.
        stashed = _git(worktree, "stash", "push", "-u", "-m", "nightcrew-shot").returncode == 0
        if stashed and _build(worktree):
            path = out_dir / "before.png"
            if _one(worktree, route, path, data_dir, secret_file, secret_hex):
                result["before"] = path

        # AFTER: change restored. The pop must happen even if the before shot
        # failed — losing her worker's diff to a screenshot is unacceptable.
        if stashed:
            popped = _git(worktree, "stash", "pop").returncode == 0
            stashed = not popped
            if not popped:
                return result   # diff is still in the stash; don't shoot a lie
        if _build(worktree):
            path = out_dir / "after.png"
            if _one(worktree, route, path, data_dir, secret_file, secret_hex):
                result["after"] = path
    except Exception:
        pass
    finally:
        # Last-resort restore: a stash left applied would silently discard the
        # change this whole run exists to produce.
        if stashed:
            _git(worktree, "stash", "pop")
        shutil.rmtree(scratch, ignore_errors=True)
    return result


if __name__ == "__main__":  # quick manual check: which page would we shoot?
    import sys
    print(json.dumps({"route": route_for(sys.argv[1:])}, indent=2))
