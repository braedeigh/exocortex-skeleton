#!/usr/bin/env python3
"""spinoff_runner.py — hosts a spun-off session's first turn so nobody has to open it.

WHY THIS EXISTS. A turn is run by a `daemon=True` thread that
routes/observatory.py starts inside whichever process handled the send, and it
keeps writing whether or not anyone is watching (that's the PWA-close fix: only
/stop kills a turn). Normally that process is gunicorn, and the send arrives
because she opened the conversation in a browser. So a spinoff's kickoff used
to sit in `draft` waiting for a browser to fire it — the session existed but did
nothing until she looked at it.

`spinoff_open.py` can't host the turn itself: it's a short-lived script, and a
daemon thread dies with its process the moment the script returns.

So this runner is the missing long-lived process. It builds a bare Flask app
with ONLY the observatory routes registered — the same shape
tests/test_observatory_routes.py's `bot_client` fixture uses — posts the kickoff
through the real send route, and then drains the SSE response, which blocks
until the turn thread finishes. Same code path as a browser send, no HTTP
server, no auth gate to get past, and not one line of the live send path
changed.

    spinoff_runner.py <conv_id> <text-file>

Launched detached (start_new_session=True) by routes/spinoff.py, which is why
it must never expect a terminal, a parent, or a reader on its stdout.

Two things worth knowing about the seams:

- STOP still works, but by the flag rather than the pointer. `/stop` kills a
  turn directly when the process that owns it is the one handling the stop
  request; here the owner is this process, not gunicorn, so the direct kill
  misses. The index's `stop_requested` flag is the path that does reach us —
  _run_turn checks it per event. That's the same fallback that already covers
  the two-gunicorn-worker case, so this isn't a new mechanism, just a new
  caller relying on it.
- The kickoff ALSO stays staged as `draft`+`autostart` on the conversation.
  That's deliberate belt-and-braces: if this runner never starts (a bad
  interpreter path, a box under memory pressure), opening the session in the
  Observatory still fires the kickoff the old way. It can't double-fire —
  the send that lands first pops both fields, and a second send against a
  running conversation is refused with a 409.

Prompt that produced it: "I want it to work without having to open it."
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    if len(sys.argv) != 3:
        print("usage: spinoff_runner.py <conv_id> <text-file>", file=sys.stderr)
        return 2
    conv_id, text_path = sys.argv[1], sys.argv[2]
    try:
        text = Path(text_path).read_text(encoding="utf-8")
    except OSError as e:
        print(f"could not read kickoff: {e}", file=sys.stderr)
        return 2
    # Consumed. The file existed only to carry one sentence across a process
    # boundary without it ever touching a shell, and it has now done that —
    # keeping it would just leave one more thing behind per spawn. The kickoff
    # also stays staged on the conversation as draft+autostart, so the fallback
    # path does not depend on this file surviving.
    try:
        Path(text_path).unlink()
    except OSError:
        pass
    if not text.strip():
        print("empty kickoff", file=sys.stderr)
        return 2

    from flask import Flask
    from routes import observatory

    app = Flask(__name__)
    observatory.register(app)
    client = app.test_client()

    resp = client.post(f"/api/observatory/conversation/{conv_id}/send",
                       json={"text": text})
    if resp.status_code != 200:
        # 404 (conversation vanished) and 409 (a turn is already running —
        # she opened it first and the autostart fallback beat us) are both
        # legitimate no-ops, not failures to retry.
        print(f"send refused: {resp.status_code} {resp.get_data(as_text=True)[:200]}",
              file=sys.stderr)
        return 1

    # Draining the stream is what keeps this process alive for the turn: the
    # generator yields until the turn thread pushes its terminating None. The
    # bytes go nowhere — we're the host, not a viewer.
    for _ in resp.response:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
