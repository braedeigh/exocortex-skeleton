#!/usr/bin/env python3
"""act_ask_gate.py — the act-vs-ask autonomy gate (PreToolUse hook).

Phase 4 of the observability arc, and the ONLY piece that grants autonomy. It
generalizes the shipped doc-guard (routes/observatory.py), which is already an
act-vs-ask gate that always says "ask", into one that says "act" for the
reversible/in-lane and "ask" for the irreversible/out-of-lane.

THE LAW (Terra): the gate keys on REVERSIBILITY + LANE, never on the agent's
"confidence" — a confidently-wrong agent is the dangerous case, and its felt
confidence is highest exactly when it's lost the thread. And it FAILS TOWARD
ASK: Bash is allow-listed (only known-safe commands act; everything else asks),
because when you're wrong, an extra ask costs a tap and a slipped-through
irreversible costs real harm. Her setup is the live site — no sandbox — so that
asymmetry is load-bearing.

PURELY ADDITIVE: this hook only ever returns "deny" (→ ask). The reversible/act
path is a silent exit 0 (defer to the session's --allowedTools + the doc-guard's
permissions.deny). So it can never widen what a session may do — only narrow it.
An "ask" is a deny + a reason telling the agent to raise an orange request via
scripts/request_input.py (Phase 2); nothing wakes it — she decides.

Contract (Claude Code PreToolUse): reads a JSON event on stdin
({"tool_name", "tool_input": {...}}); prints a hookSpecificOutput with
permissionDecision "deny" to block (in headless -p there's no interactive
prompt, so "deny"+reason IS the ask), or nothing to allow. Wired via
`claude --settings` in routes/observatory.py `_build_cmd`, matcher
"Bash|Task|mcp__.*" — reads/edits aren't gated here (edits are git-reversible
and the doc-guard covers the protected paths).

Stdlib-only + defensive so it can't brick a turn: an unreadable event defers
(infra hiccup ≠ agent action), but once we know it's a gated tool we can't
classify, we ASK (fail toward the safe side).
"""
import json
import os
import re
import sys


# --- Bash allow-list (fail toward ask) --------------------------------------
# A Bash command ACTS only if EVERY chained segment matches one of these
# known-safe shapes AND the whole line carries no redirect/substitution. Safe =
# reads, git-reads, the test/build commands this repo actually uses, and the two
# doors the agent needs (request_input to ASK; pytest/py_compile to verify).
# NOTE: python/node/sed/awk are NOT blanket-safe (they run arbitrary code), so
# python is allowed only for `-m pytest` / `-m py_compile` / request_input.py.
_ALLOW = [
    re.compile(p) for p in (
        r"^(ls|pwd|cd|pushd|popd|cat|head|tail|wc|echo|printf|grep|rg|egrep|fgrep"
        r"|find|tree|file|stat|sort|uniq|cut|column|jq|diff|cmp|basename|dirname"
        r"|realpath|readlink|date|whoami|env|true|:|test|nl|tac)\b",
        r"^git (status|diff|log|show|branch|remote|ls-files|rev-parse|blame"
        r"|describe|config|add|stash list|show-ref|cat-file)\b",
        r"^(pytest|tox)\b",
        r"^npm (test|ci|ls|list|run (build|lint|typecheck|test))\b",
        r"^npx (vitest|tsc|oxlint|eslint|prettier)\b",
        r"^\S*python3? -m (pytest|py_compile)\b",
        r"^\S*python3? \S*scripts/request_input\.py\b",
        # The journal engine's REVERSIBLE verbs (tools/stream/stream.py, usually
        # reached through a vault shim at another path — hence the loose prefix,
        # anchored at a path boundary so `mystream.py` doesn't sneak in).
        # `record` appends a card, `render` rebuilds a view that is disposable by
        # design (the card pool is the only truth), `validate` and `--help` only
        # read. `edit`/`delete` stay denied — they overwrite or drop the one copy
        # of an utterance — and so do `tag`/`untag`, which belong to the vault's
        # housekeeping pass, not to a journaling session.
        # Without this the nightly rollover's /journalstart and /endsession turns
        # (scripts/keeper_rollover.py, gated because they build their config from
        # the legacy bot lookup instead of the conversation's own) could not mint
        # the day's context card, re-render a day, or validate the pool at close
        # — and being unattended, they can't even raise an approval card.
        # CALLING SHAPE MATTERS: `record` takes its body on STDIN, and
        # _UNSAFE_META below bans `<`, `>` and real newlines — so a heredoc or an
        # inline multi-line body still asks. Pipe it instead
        # (`cat body.md | python3 .../stream.py record --who K`), and read output
        # from a plain `... validate`, never `... validate 2>&1 | tail`.
        # Prompt: "fix the stream — the act-vs-ask gate rejects every invocation
        # of the journal engine from a journaling session, so it can't mint its
        # context card, re-render a day, or validate the pool at close. Allow the
        # reversible verbs; keep the destructive ones asking."
        r"^\S*python3? (?:\S*/)?stream\.py (record|render|validate|--help)\b",
    )
]

# Redirects and substitutions defeat a first-token allow-list (`echo x > file`
# writes a file though it starts with `echo`), so any of these → ask outright.
_UNSAFE_META = (">", "<", "`", "$(", "${", "\n")

# Split a command line into the pieces a shell would run in sequence.
_CHAIN = re.compile(r"\s*(?:&&|\|\||;|\|)\s*")


def _bash_is_safe(command):
    c = (command or "").strip()
    if not c:
        return False
    if any(m in c for m in _UNSAFE_META):
        return False
    if re.search(r"\bsudo\b", c):
        return False
    segments = [s.strip() for s in _CHAIN.split(c) if s.strip()]
    if not segments:
        return False
    return all(any(p.match(seg) for p in _ALLOW) for seg in segments)


# --- the reasons handed back on an ASK --------------------------------------
_ASK_TAIL = (
    " Do NOT retry it. To ask her, run "
    "`./venv/bin/python3 scripts/request_input.py \"<what you want to do and why>\"` "
    "then stop — she holds this call (she is the transport; nothing else will "
    "resume you)."
)
_REASON_BASH = (
    "ACT-VS-ASK GATE — this command isn't on the reversible/in-lane allow-list "
    "(it may be irreversible or external: push/deploy/delete/network/commit/"
    "arbitrary code)." + _ASK_TAIL
)
_REASON_SPAWN = (
    "ACT-VS-ASK GATE — spawning another session multiplies, so it's hers to "
    "approve (a confident loop would otherwise fork-bomb)." + _ASK_TAIL
)
_REASON_EXTERNAL = (
    "ACT-VS-ASK GATE — this reaches an external service (irreversible / "
    "outward-facing), so it's hers to approve." + _ASK_TAIL
)
# When we DO have a conversation to hang an approval card off (a real spawned
# turn: EXOCORTEX_CONV_ID set + --approvals-dir passed), a gated Bash command
# isn't a dead end — we record it as `pending` and tell the agent an inline
# Approve/Deny card is now on its Orchestra card. On approve it lands in this
# session's `once`/`always` allow-list and the SAME command sails through next
# time (this is the one and only path by which the gate ever says "act" for
# something it would otherwise deny — she opened that door per command).
_REASON_APPROVAL = (
    "ACT-VS-ASK GATE — this needs her OK. I've raised an Approve / Deny card for "
    "this exact command on the session's Orchestra card. Do NOT retry it now: stop "
    "and wait. When she approves it there the session resumes and you retry the "
    "same command verbatim (it's whitelisted then); if she denies, find another "
    "way or stop. Nothing else wakes it — she decides."
)


# --- Approvals sidecar (the ONE place the hook writes) ----------------------
# A per-conversation file, bot_chats/approvals/<conv_id>.json, shared with the
# app (routes/observatory.py reads/writes the same shape). All IO here is
# defensive: any failure degrades to the ordinary deny — the gate must never
# brick a turn, and failing-closed on the approval path just means an extra tap.
#   {"pending": {"tool": "Bash", "command": "<cmd>"} | null,
#    "once":  ["<cmd>", ...],   # one-shot: consumed by the hook on first match
#    "always":["<cmd>", ...]}   # sticky for the session: never consumed
_SAFE_CONV_ID = re.compile(r"^[A-Za-z0-9._-]+$")


def _approvals_path(argv, conv_id):
    """The sidecar path from `--approvals-dir <dir>` + EXOCORTEX_CONV_ID, or
    None when either is missing/unsafe (→ no approval flow, plain deny)."""
    if not conv_id or ".." in conv_id or not _SAFE_CONV_ID.match(conv_id):
        return None
    directory = None
    for i, arg in enumerate(argv):
        if arg == "--approvals-dir" and i + 1 < len(argv):
            directory = argv[i + 1]
            break
    return os.path.join(directory, conv_id + ".json") if directory else None


def _load_approvals(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_approvals(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def _resolve_via_approvals(command, path):
    """For a would-be-denied Bash command with a real sidecar path, decide what
    the hook should do. Returns "allow" (whitelisted — act), "ask" (recorded as
    pending — deny with the approval reason), or None (no context / write failed
    — caller falls back to the ordinary deny)."""
    rec = _load_approvals(path)
    if command in (rec.get("always") or []):
        return "allow"
    once = rec.get("once")
    if isinstance(once, list) and command in once:
        once.remove(command)            # one-shot: consume on use
        rec["once"] = once
        _save_approvals(path, rec)       # best-effort; an un-consumed token just re-asks
        return "allow"
    rec["pending"] = {"tool": "Bash", "command": command}
    return "ask" if _save_approvals(path, rec) else None


def classify_tool(tool_name, tool_input):
    """Return (decision, reason): ("allow", None) to act, ("deny", reason) to
    ask. The whole policy, as a pure function so the tests can hammer it."""
    if tool_name == "Bash":
        if _bash_is_safe((tool_input or {}).get("command", "")):
            return ("allow", None)
        return ("deny", _REASON_BASH)
    if tool_name == "Task":
        return ("deny", _REASON_SPAWN)
    if tool_name.startswith("mcp__"):
        return ("deny", _REASON_EXTERNAL)
    # Anything else reaching here (the matcher shouldn't send it) isn't gated.
    return ("allow", None)


def _emit_deny(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        tool_name = data.get("tool_name") or ""
        tool_input = data.get("tool_input") or {}
    except Exception:
        # Couldn't even read the event — an infra hiccup, not an agent action.
        # Defer rather than brick the turn (the tool's own --allowedTools still
        # gate it, and the doc-guard still denies the protected paths).
        sys.exit(0)
    try:
        decision, reason = classify_tool(tool_name, tool_input)
    except Exception:
        # We KNOW it's a gated tool but couldn't classify → fail toward ask.
        _emit_deny(
            "ACT-VS-ASK GATE — couldn't evaluate this action, so asking to be "
            "safe." + _ASK_TAIL)
        sys.exit(0)
    if decision == "deny":
        # A gated BASH command isn't a dead end when we have a conversation to
        # hang an approval card off: record it as pending (or clear it if she's
        # already whitelisted it) instead of a bare deny. Task/mcp and the
        # no-context case (tests, non-spawned runs) keep the plain deny.
        if tool_name == "Bash":
            path = _approvals_path(sys.argv, os.environ.get("EXOCORTEX_CONV_ID") or "")
            if path:
                verdict = _resolve_via_approvals((tool_input or {}).get("command", ""), path)
                if verdict == "allow":
                    sys.exit(0)              # she opened this door — act (silent)
                if verdict == "ask":
                    _emit_deny(_REASON_APPROVAL)
                    sys.exit(0)
        _emit_deny(reason)
    sys.exit(0)


if __name__ == "__main__":
    main()
