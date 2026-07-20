#!/usr/bin/env python3
"""
Lives in the skeleton (shareable engine); the vault keeps exec-shims at
tulku/_system/ for existing callers.

keeper_capture.py — Claude Code UserPromptSubmit hook for the Keeper's journal.

Ports exo's "fish" capture-at-source pattern (see dev/exo/_system/capture_prompt.py)
into the tulku journal: every operator prompt mints a `B` card into the stream-cards
pool the instant it's sent, deterministically, with the agent's discretion out of the
loop (the fix for "you forgot to publish some of my inputs"). The pool
(`_system/data/cards/`) is truth; today's daily log is a disposable VIEW re-rendered
from it by `stream.py` on every mint — see STREAM.md for the full pool/manifest/view
architecture.

Reads the hook JSON on stdin (`prompt`, `session_id`, `transcript_path`) and prints
NOTHING — UserPromptSubmit stdout is injected into the model's context, so a capture
hook must stay silent.

Three things differ from fish:

  1. Keeper-mode gate. Bradie launches Claude Code at the repo root and runs
     `/journalstart`; she also opens *dev* sessions at the same root. Fish captures
     unconditionally — we must not. So we only capture once this session is armed: the
     `/journalstart` expansion plants the sentinel KEEPER_SESSION_ACTIVE in the
     transcript; each prompt scans the transcript and, once it finds the sentinel,
     latches an `.on` marker per session id and trusts it forever. A session that hasn't
     armed yet is NOT cached — we re-scan every prompt until the sentinel appears — so a
     dev session at the same root is simply never captured, and a keeper session can't be
     lost to a one-shot scan that ran before the sentinel flushed (the old `.off` race).

  2. Second door, deduped. Bradie's web-app Chat-tab sends are minted at the SERVER
     (skeleton repo, /api/terminal/send) before the text is typed into tmux — this hook
     only needs to catch what she types directly into a terminal. The server records a
     hash of every string it minted in .keeper/ui_captured.jsonl; we consume a matching
     entry instead of minting a duplicate (see _ui_already_captured). This exists because
     hooks snapshot at claude-process launch: a stale process has a dead hook and was
     silently dropping her app sends (root-caused 2026-07-13).

  3. Manual K cards. This hook mints ONLY `B` cards. When Bradie answers a question the
     Keeper asked, the Keeper mints the `K` card by hand — `stream.py record --who K`
     (or `stream.record(who="K", ...)`) — carrying just that question, then sets her
     `B` card's `reply_to` to its id. Capture is automatic; the question context is not.

Synthetic messages the harness injects through the same channel (task-notifications,
system reminders, slash-command echoes) are NOT the operator talking, so they're skipped.
"""
import hashlib
import json
import pathlib
import sys
import time
from datetime import datetime

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import stream  # noqa: E402

# Root resolution is lazy (via stream.stream_root(), never cached at import) so the
# hook works whether it's exec'd from the vault shim (TULKU_STREAM_ROOT pinned by the
# shim) or run in place in the skeleton (EXOCORTEX_CONTENT_DIR) — see stream.py.

def _state_dir() -> pathlib.Path:
    return stream.stream_root() / ".keeper"


def _sessions_dir() -> pathlib.Path:
    return _state_dir() / "sessions"


def _failure_log() -> pathlib.Path:
    return _state_dir() / "capture-failures.jsonl"


# Written by the web app's /api/terminal/send (routes/terminal.py in the skeleton
# repo), which mints Bradie's Chat-tab sends as B cards at the server — before the
# text is ever typed into tmux — so capture doesn't depend on this hook being alive
# (hooks snapshot at claude-process launch and die in stale processes). Each line is
# {ts, sha256-of-the-typed-string}; we consume a matching entry instead of minting
# a duplicate. Direct terminal typing never lands in this file, so it still mints here.
def _ui_captured_path() -> pathlib.Path:
    return _state_dir() / "ui_captured.jsonl"


UI_CAPTURE_WINDOW_SEC = 15 * 60

# The sentinel the /journalstart command plants in the transcript. Its presence is what
# arms capture for a session — see journalstart.md.
SENTINEL = "KEEPER_SESSION_ACTIVE"

# Harness-injected, non-operator text that arrives on the prompt channel. Not a human
# turn -> never journaled. (Matched at the very start of the prompt.)
SYNTHETIC_PREFIXES = (
    "<task-notification>", "<system-reminder>", "<local-command-stdout>",
    "<command-message>", "<command-name>", "<command-args>",
)


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return 0
    if prompt.startswith(SYNTHETIC_PREFIXES):   # harness noise, not the operator
        return 0

    sid = (data.get("session_id") or "").strip()
    transcript_path = (data.get("transcript_path") or "").strip()
    if not _keeper_mode(sid, transcript_path):  # a dev session at the same root -> stay out
        return 0
    if _ui_already_captured(prompt):            # the web app minted this send at the server
        return 0

    try:
        stream.record(who="B", body=prompt)      # mints the card, re-renders day + month index
    except Exception as e:                       # never BLOCK prompt submission, but never
        _log_failure(prompt, repr(e))            # silently drop it either — leave a durable trace
    return 0            # silent: no stdout -> no context injection


def _keeper_mode(sid: str, transcript_path: str) -> bool:
    """True iff this session is an armed Keeper session.

    The armed state is a one-way latch: once the KEEPER_SESSION_ACTIVE sentinel shows
    up in the transcript we cache an `.on` marker and trust it forever. But an *un*-armed
    session is deliberately NOT cached — we re-scan the transcript on every prompt until
    the sentinel appears.

    This defeats the /journalstart race: the sentinel is planted by the slash-command
    expansion, which may not have flushed to the transcript file yet when the FIRST
    prompt's hook fires. A one-shot scan can miss it and (the old bug) latch the session
    `.off` permanently, silently dropping the whole session. Re-scanning until armed costs
    one transcript read per prompt on a not-yet-armed or dev session (cheap, local) and
    can never lose a keeper turn. Stale `.off` markers from older sessions are now inert."""
    if not sid:
        # No session id to cache against — fall back to a live transcript scan so we
        # neither lose a keeper turn nor capture a dev one.
        return _transcript_has_sentinel(transcript_path)
    on = _sessions_dir() / f"{sid}.on"
    if on.exists():
        return True
    if not _transcript_has_sentinel(transcript_path):
        return False            # not armed yet (or a dev session) — try again next prompt
    try:
        _sessions_dir().mkdir(parents=True, exist_ok=True)
        on.write_text("", encoding="utf-8")
    except Exception:
        pass            # caching is best-effort; correctness doesn't depend on it
    return True


def _transcript_has_sentinel(transcript_path: str) -> bool:
    """True iff the /journalstart expansion is present as a real operator prompt in
    this session's transcript.

    The old check was a raw substring scan of the whole transcript file — and the
    transcript embeds tool results, so a DEV session that merely *read* a file
    containing the sentinel token (this hook's own source, journalstart.md, STREAM.md)
    armed itself and journaled dev chatter (caught 2026-07-06). Three fences now, all
    required before a line arms the session:

      - the entry is `user`-type (assistant text / tool_use never arm), and
      - the sentinel sits in a plain text block, never a tool_result (file contents
        flow through those), and the block isn't harness-synthetic (task-notifications
        can quote the token back), and
      - it appears in its full comment form ("<!-- KEEPER_SESSION_ACTIVE"), which only
        the /journalstart expansion carries — a backticked mention in prose doesn't
        count.
    """
    if not transcript_path:
        return False
    needle = "<!-- " + SENTINEL
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if needle not in line:      # cheap pre-filter before JSON parse
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                if entry.get("type") != "user":
                    continue
                content = (entry.get("message") or {}).get("content")
                blocks = ([{"type": "text", "text": content}] if isinstance(content, str)
                          else (content or []))
                for b in blocks:
                    if not isinstance(b, dict) or b.get("type") != "text":
                        continue
                    text = b.get("text") or ""
                    if text.lstrip().startswith(SYNTHETIC_PREFIXES):
                        continue
                    if needle in text:
                        return True
    except Exception:
        return False
    return False


def _ui_already_captured(prompt: str) -> bool:
    """True iff this exact prompt was already minted as a B card by the web app's
    send endpoint — matched by sha256 of the stripped prompt against a recent
    entry in the UI-capture sidecar (`_ui_captured_path()`).

    The matching entry is CONSUMED (removed from the file), one per hit: if she
    deliberately says the same words twice — once via the app, once typed straight
    into the terminal — the second occurrence finds no entry left and mints
    normally. Entries older than UI_CAPTURE_WINDOW_SEC are ignored (and pruned by
    the writer), so a stale hash can't swallow a future turn. Any read/write
    trouble fails open to minting — a duplicate card beats a lost one."""
    try:
        lines = _ui_captured_path().read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    now = time.time()
    keep, found = [], False
    for line in lines:
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if (not found and entry.get("sha256") == digest
                and now - float(entry.get("ts", 0)) < UI_CAPTURE_WINDOW_SEC):
            found = True        # consume: this line is not kept
            continue
        keep.append(line)
    if found:
        try:
            _ui_captured_path().write_text("\n".join(keep) + ("\n" if keep else ""), encoding="utf-8")
        except OSError:
            pass                # consumption is best-effort; worst case is a skip next time
    return found


def _log_failure(prompt: str, error: str) -> None:
    """A capture failure must not vanish — append the raw prompt to a local-only sidecar so
    nothing Bradie typed is lost unsignalled (the hook's whole reason to exist)."""
    try:
        _state_dir().mkdir(parents=True, exist_ok=True)
        with _failure_log().open("a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"),
                                "error": error, "prompt": prompt}, ensure_ascii=False) + "\n")
    except Exception:
        pass            # last resort — still never block the prompt


if __name__ == "__main__":
    sys.exit(main())
