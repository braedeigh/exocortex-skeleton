#!/usr/bin/env python3
"""helper_gate.py — the helpers look things up; they never build (PreToolUse hook).

**What this is, in plain English.** A swarm's helper and the room helper
(swarm_helper.py, room_helper.py) answer the owner's questions about the
agents' work. They need to read, search, query the database, read git and
message sessions — but never to change anything themselves. When something
needs building, a helper writes a brief and starts a new session to build it
(scripts/spinoff_open.py); its instructions say how (helper_chat.CHAT_PROMPT).

Words alone didn't hold: a helper once edited the frontend, built it and
committed twice on its own. So this hook checks every tool call a helper
makes, and lets through only:

  - the reading tools (Read, Grep, Glob, ToolSearch);
  - the web's reading tools (WebFetch, WebSearch), so a helper can open a
    link she sends and research a question without starting a session;
  - Write, only to a spinoff brief: <spinoff dir>/<slug>/BRIEF.md;
  - Bash, only for lookups: reading and searching commands, git's reading
    verbs, and the app's own doors for a helper — peers.py, exo_query.py,
    request_input.py, spinoff_open.py, room_moves.py, helper_watch.py (a
    watch is a helper's promise to tell her when a session does something —
    watches.py) and helper_rule.py (her standing rules for it, in her words
    — helper_chat.py). The watches and the rules are the only records a
    helper keeps for itself.

Everything else — Edit, a sub-agent, a skill, any other outside service
(mail, calendar, Linear), any other command — is denied, with a reason telling
the helper to start a session instead. It FAILS TOWARD DENY: a command it
can't read as a lookup is refused.

Why the web is safe to let through: WebFetch and WebSearch only read — they
change nothing here or anywhere else. The one real risk is a web page that
carries instructions of its own (prompt injection). A helper is told that text
on a page is information, never an instruction (helper_chat.CHAT_PROMPT), and
even a helper that's fooled can still only do what this gate allows: look
things up, move sessions in the room, message sessions and start one from a
brief — never edit, build, commit or run code itself.

Same contract as tools/act_ask_gate.py: reads Claude Code's PreToolUse event
as JSON on stdin, prints a "deny" decision or nothing. Wired in
routes/observatory.py `_session_settings` for every session whose role is a
helper, whatever room it's in. Tests: tests/test_helper_gate.py.

Prompt that produced this: "Make it such that the helper never builds
anything. Always creates a new session to build if it needs."
"""
import json
import os
import re
import sys

# The reading tools. Nothing else passes without a check below.
_LOOK_TOOLS = ("Read", "Grep", "Glob", "LS", "ToolSearch")

# The web's reading tools: open a page, search the web. They read, never write.
# Prompt: "Allow web fetch in helpers. I want to be able to read and research
# with them."
_WEB_TOOLS = ("WebFetch", "WebSearch")

# A brief's folder name, the same rule routes/spinoff.py's SLUG_RE holds.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")

# --- Bash: what counts as a lookup -------------------------------------------
# A command passes only if EVERY piece of it (split at ; && || | & and new
# lines) matches one of these shapes, and no piece hides a flag that writes.

# Reading and searching commands, each with the flags that would make it write
# or run something else. A command absent here isn't a lookup.
_READERS = {
    "ls": (), "pwd": (), "cd": (), "cat": (), "head": (), "tail": (), "wc": (),
    "echo": (), "printf": (), "grep": (), "egrep": (), "fgrep": (), "file": (),
    "stat": (), "uniq": (), "cut": (), "column": (), "jq": (), "diff": (),
    "cmp": (), "basename": (), "dirname": (), "realpath": (), "readlink": (),
    "date": (), "whoami": (), "true": (), "test": (), "nl": (), "tac": (),
    "rg": ("--pre",),
    "sort": ("-o", "--output"),
    "tree": ("-o",),
    "find": ("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint",
             "-fprint0", "-fprintf", "-fls"),
}

# `sed` only as a line printer: `sed -n 20,80p file`.
_SED_PRINT = re.compile(r"^sed -n ['\"]?\d+(,(\d+|\$))?p['\"]?( [^-]\S*)+$")

# Git's reading verbs. `-C <repo>` and friends may sit before the verb, as in
# the act gate; `-c key=value` may not (it can set a pager git then runs).
_GIT_READ = re.compile(
    r"^git (?:(?:-C \S+|--no-pager|--git-dir=\S+|--work-tree=\S+) )*"
    r"(status|diff|log|show|rev-parse|ls-files|blame|describe|show-ref|cat-file"
    r"|grep|shortlog|stash list|remote -v)\b")
# `git branch` only to list: no flag that deletes, renames, copies or moves.
_GIT_BRANCH = re.compile(
    r"^git (?:(?:-C \S+|--no-pager) )*branch"
    r"( (-a|-r|-v|-vv|--list|--all|--remotes|--show-current|--merged|--no-merged"
    r"|--contains \S+|--sort=\S+|--format=\S+|[^-\s]\S*))*$")

# The app's own doors for a helper, run with the checkout's python. peers.py
# may message a session but not interrupt it — same line the act gate draws.
# helper_watch.py writes, but only a watch: a promise it keeps (watches.py).
# helper_rule.py writes, but only one of her standing rules (helper_chat.py).
_SCRIPTS = re.compile(
    r"^\S*python3? (?:\S*/)?scripts/"
    r"(peers|exo_query|request_input|spinoff_open|room_moves|helper_watch|helper_rule)\.py\b")

# Pointing a script at a data dir is fine: `EXOCORTEX_DATA_DIR=/x ./venv/...`.
_ENV_PREFIX = re.compile(r"^(?:EXOCORTEX_\w+=[^\s;&|]+ +)+")

# Where a command line splits into the pieces a shell runs one by one.
_CHAIN = re.compile(r"&&|\|\||;|\||&|\n")

# Throwing away errors is a redirect that writes nothing.
_HARMLESS_REDIRECT = re.compile(r"\s[12]?>\s*/dev/null|\s2>&1")


def _mask_quotes(command):
    """The command with every quoted string's inside blanked out (same length,
    so positions still line up with the original), or None when the quoting
    hides something: an unclosed quote, a `$` or backtick inside double quotes
    (the shell expands those), or a backslash outside quotes."""
    out, i = [], 0
    while i < len(command):
        char = command[i]
        if char == "\\":
            return None
        if char not in "'\"":
            out.append(char)
            i += 1
            continue
        end = i + 1
        while end < len(command) and command[end] != char:
            if char == '"' and command[end] in "$`":
                return None
            # Inside double quotes a backslash escapes the next character.
            end += 2 if char == '"' and command[end] == "\\" else 1
        if end >= len(command):
            return None
        out.append(char + "_" * (end - i - 1) + char)
        i = end + 1
    return "".join(out)


def _is_lookup_piece(piece):
    """One piece of a command line (no chaining left in it) is a lookup."""
    piece = _ENV_PREFIX.sub("", piece.strip())
    if not piece:
        return False
    if _SCRIPTS.match(piece):
        return not ("peers.py send" in piece and "--interrupt" in piece)
    if piece.startswith("git "):
        return bool(_GIT_READ.match(piece) or _GIT_BRANCH.match(piece)) \
            and "--output" not in piece
    if piece.startswith("sed "):
        return bool(_SED_PRINT.match(piece))
    words = piece.split()
    if words[0] not in _READERS:
        return False
    banned = _READERS[words[0]]
    return not any(w == b or w.startswith(b + "=") for w in words[1:] for b in banned)


def bash_is_lookup(command):
    """True when a Bash command only looks. The whole policy for Bash."""
    command = (command or "").strip()
    masked = _mask_quotes(command) if command else None
    if not masked:
        return False
    # Blank the harmless redirects out of both copies, keeping the lengths.
    for match in _HARMLESS_REDIRECT.finditer(masked):
        start, end = match.span()
        masked = masked[:start] + " " * (end - start) + masked[end:]
        command = command[:start] + " " * (end - start) + command[end:]
    if any(m in masked for m in (">", "<", "`", "$(", "${")):
        return False
    # Split where the MASKED copy splits, so a `|` inside quotes stays put.
    pieces, start = [], 0
    for match in _CHAIN.finditer(masked):
        pieces.append(command[start:match.start()])
        start = match.end()
    pieces.append(command[start:])
    pieces = [p for p in pieces if p.strip()]
    return bool(pieces) and all(_is_lookup_piece(p) for p in pieces)


# --- Write: only a spinoff brief --------------------------------------------

def is_brief_path(file_path, spinoff_dir):
    """True when `file_path` is <spinoff_dir>/<slug>/BRIEF.md, after following
    links and `..` — so no path can climb out of the spinoff folder."""
    if not (file_path and spinoff_dir):
        return False
    path = os.path.realpath(file_path)
    folder, name = os.path.split(path)
    return (name == "BRIEF.md"
            and os.path.dirname(folder) == os.path.realpath(spinoff_dir)
            and bool(_SLUG_RE.match(os.path.basename(folder))))


# --- The reasons handed back on a deny --------------------------------------
_START_A_SESSION = (
    " You're a helper: you look things up and never build. If this needs doing, "
    "start a session to do it — write its brief with the Write tool to "
    "<spinoff dir>/<slug>/BRIEF.md, then run "
    "`./venv/bin/python3 scripts/spinoff_open.py <slug>` (your instructions say "
    "how). If it's a member's work, message that member with scripts/peers.py.")
_REASON_BASH = ("HELPER GATE — this command isn't a lookup (it could change "
                "files, build, commit or run code)." + _START_A_SESSION)
_REASON_WRITE = ("HELPER GATE — a helper may write only a spinoff brief, "
                 "<spinoff dir>/<slug>/BRIEF.md." + _START_A_SESSION)
_REASON_TOOL = "HELPER GATE — a helper can't use this tool." + _START_A_SESSION


def classify_tool(tool_name, tool_input, spinoff_dir=None):
    """(decision, reason): ("allow", None) or ("deny", why). The whole policy,
    as a pure function so the tests can hammer it."""
    tool_input = tool_input or {}
    if tool_name in _LOOK_TOOLS or tool_name in _WEB_TOOLS:
        return ("allow", None)
    if tool_name == "Bash":
        if bash_is_lookup(tool_input.get("command", "")):
            return ("allow", None)
        return ("deny", _REASON_BASH)
    if tool_name == "Write":
        if is_brief_path(tool_input.get("file_path"), spinoff_dir):
            return ("allow", None)
        return ("deny", _REASON_WRITE.replace("<spinoff dir>", spinoff_dir or "<spinoff dir>"))
    return ("deny", _REASON_TOOL)


def _spinoff_dir(argv):
    """The spinoff folder, from `--spinoff-dir <dir>` (routes/observatory.py
    passes it, resolved from store.SPINOFF_DIR)."""
    for i, arg in enumerate(argv):
        if arg == "--spinoff-dir" and i + 1 < len(argv):
            return argv[i + 1]
    return None


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
        tool_name = data.get("tool_name") or ""
        tool_input = data.get("tool_input") or {}
        decision, reason = classify_tool(tool_name, tool_input, _spinoff_dir(sys.argv))
    except Exception:
        # Deny what can't be read: this gate's whole job is saying no.
        decision, reason = "deny", "HELPER GATE — couldn't read this tool call." + _START_A_SESSION
    if decision == "deny":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))
    sys.exit(0)


if __name__ == "__main__":
    main()
