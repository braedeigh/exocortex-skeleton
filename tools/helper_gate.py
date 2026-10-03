#!/usr/bin/env python3
"""helper_gate.py — the helpers look things up; they never build (PreToolUse hook).

**What this is, in plain English.** A swarm's helper and the room helper
(swarm_helper.py, room_helper.py) answer the owner's questions about the
agents' work. They need to read, search, query the database, read git and
message sessions — but never to change anything themselves. When something
needs building, a helper saves a brief and starts a new session to build it
(scripts/spinoff_brief.py, scripts/spinoff_open.py); its instructions say how
(helper_chat.CHAT_PROMPT).

Words alone didn't hold: a helper once edited the frontend, built it and
committed twice on its own. So this hook checks every tool call a helper
makes, and lets through only:

  - the reading tools (Read, Grep, Glob, ToolSearch);
  - the web's reading tools (WebFetch, WebSearch), so a helper can open a
    link she sends and research a question without starting a session;
  - Bash, only for lookups: reading and searching commands, git's reading
    verbs, and the app's own doors for a helper — peers.py, exo_query.py,
    request_input.py, spinoff_brief.py (saves a new session's brief, which
    is a row in the database — briefstore.py), spinoff_open.py,
    room_moves.py, helper_watch.py (a
    watch is a helper's promise to tell her when a session does something —
    watches.py) and helper_rule.py (her standing rules for it, in her words
    — helper_chat.py). The watches and the rules are the only records a
    helper keeps for itself. One command may be fed text: spinoff_brief.py
    takes the brief on standard input, as a quoted here-document (see
    "Bash: the brief" below). No other redirection passes. And linear_feed.py, which reads the Linear news
    the app has written down and one Linear issue live; it never writes to
    Linear.

Everything else — Write, Edit, a sub-agent, a skill, any other outside service
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
import re
import sys

# The reading tools. Nothing else passes without a check below.
_LOOK_TOOLS = ("Read", "Grep", "Glob", "LS", "ToolSearch")

# The web's reading tools: open a page, search the web. They read, never write.
# Prompt: "Allow web fetch in helpers. I want to be able to read and research
# with them."
_WEB_TOOLS = ("WebFetch", "WebSearch")

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
# linear_feed.py reads Linear and the news written down from it (linear_feed.py).
# spinoff_brief.py writes, but only a new session's brief (briefstore.py).
_SCRIPTS = re.compile(
    r"^\S*python3? (?:\S*/)?scripts/"
    r"(peers|exo_query|request_input|spinoff_brief|spinoff_open|room_moves|helper_watch"
    r"|helper_rule|linear_feed)\.py\b")
_BRIEF_SCRIPT = re.compile(r"^\S*python3? (?:\S*/)?scripts/spinoff_brief\.py\b")

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


def _pieces(command):
    """A command line cut into the pieces a shell runs one by one, or None
    when it can't be read safely (hidden quoting, a redirect, a substitution)."""
    command = (command or "").strip()
    masked = _mask_quotes(command) if command else None
    if not masked:
        return None
    # Blank the harmless redirects out of both copies, keeping the lengths.
    for match in _HARMLESS_REDIRECT.finditer(masked):
        start, end = match.span()
        masked = masked[:start] + " " * (end - start) + masked[end:]
        command = command[:start] + " " * (end - start) + command[end:]
    if any(m in masked for m in (">", "<", "`", "$(", "${")):
        return None
    # Split where the MASKED copy splits, so a `|` inside quotes stays put.
    pieces, start = [], 0
    for match in _CHAIN.finditer(masked):
        pieces.append(command[start:match.start()])
        start = match.end()
    pieces.append(command[start:])
    return [p for p in pieces if p.strip()]


# --- Bash: the brief --------------------------------------------------------
# A helper saves a new session's brief by feeding its text to
# scripts/spinoff_brief.py as a here-document:
#
#     ./venv/bin/python3 scripts/spinoff_brief.py <slug> <<'BRIEF'
#     # Spinoff: ...
#     BRIEF
#
# The opening line up to ` <<'WORD'`, then the text, then WORD alone on the
# last line. The quotes around WORD are what make it safe: the shell passes
# the text through untouched, so the backticks and `$` a brief is full of are
# never run.
_HEREDOC = re.compile(
    r"\A(?P<head>[^\n]*?) <<'(?P<mark>[A-Za-z_]\w*)'\n(?P<body>.*)\n(?P=mark)\n?\Z", re.S)


def _is_brief_heredoc(command):
    """True when a command is a lookup whose last piece is spinoff_brief.py
    fed by one quoted here-document, with nothing after it."""
    match = _HEREDOC.match(command or "")
    if not match:
        return False
    # The closing word may appear only as the last line. Anywhere earlier it
    # would end the text there, and the rest would run as commands.
    if any(line.strip() == match.group("mark") for line in match.group("body").split("\n")):
        return False
    # Everything before the text must itself be a lookup, and the command the
    # text is fed to — the last piece — must be the brief script.
    pieces = _pieces(match.group("head"))
    return bool(pieces) and all(_is_lookup_piece(p) for p in pieces) \
        and bool(_BRIEF_SCRIPT.match(_ENV_PREFIX.sub("", pieces[-1].strip())))


def bash_is_lookup(command):
    """True when a Bash command only looks, or only saves a brief. The whole
    policy for Bash."""
    command = (command or "").strip()
    if _is_brief_heredoc(command):
        return True
    pieces = _pieces(command)
    return bool(pieces) and all(_is_lookup_piece(p) for p in pieces)


# --- The reasons handed back on a deny --------------------------------------
_START_A_SESSION = (
    " You're a helper: you look things up and never build. If this needs doing, "
    "start a session to do it — save its brief with "
    "`./venv/bin/python3 scripts/spinoff_brief.py <slug> <<'BRIEF'` … `BRIEF`, "
    "then run `./venv/bin/python3 scripts/spinoff_open.py <slug>` (your "
    "instructions say how). If it's a member's work, message that member with scripts/peers.py.")
_REASON_BASH = ("HELPER GATE — this command isn't a lookup (it could change "
                "files, build, commit or run code)." + _START_A_SESSION)
_REASON_WRITE = ("HELPER GATE — a helper writes no files. A brief isn't a "
                 "file any more: it is saved with scripts/spinoff_brief.py."
                 + _START_A_SESSION)
_REASON_TOOL = "HELPER GATE — a helper can't use this tool." + _START_A_SESSION


def classify_tool(tool_name, tool_input):
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
        return ("deny", _REASON_WRITE)
    return ("deny", _REASON_TOOL)


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
        tool_name = data.get("tool_name") or ""
        tool_input = data.get("tool_input") or {}
        decision, reason = classify_tool(tool_name, tool_input)
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
