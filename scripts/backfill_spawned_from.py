#!/usr/bin/env python3
"""backfill_spawned_from.py — work out who spun off each OLD spinoff session.

New spinoffs record their parent at birth (`spawned_from` + `spawned_via` on
the bot_chats index entry — routes/spinoff.py open_spinoff; the why is in
docs/spinoff-lineage.md). Sessions from before that have no link, so this
script reads the chat logs and fills it in, strongest evidence first:

  1. exact    — a session's log holds the spawn script's reply naming the
                child's conversation id with "newly_spawned": true. That
                session ran the spawn; it's the parent.
  2. command  — a session ran `spinoff_open.py <slug>` or
                `spinoff_offer.py <slug>` (or looped one over a list of
                slugs) before the child started. The last
                such session is the parent (offer → she tapped Go).
  3. terminal — the only such command is in a Claude Code transcript that
                isn't an Observatory session: born from a terminal, so it
                gets `spawned_via: "terminal"` and no parent.
  4. fork     — a `fork-*` slug's brief names the session it took over by
                title; the latest session with that title started before it.
  5. helper   — entries a helper button minted (they carry `helper`) have no
                parent session: `spawned_via: "helper"`.

Anything else is left alone and listed as unresolved — a guessed parent would
draw a false line on the tree. Only entries with no `spawned_via` are touched,
so re-running is safe.

Reads: DATA_DIR/bot_chats/index.json + *.jsonl, the spinoff brief folders,
and ~/.claude/projects/*/*.jsonl. Writes: bot_chats/index through store.

    backfill_spawned_from.py            # dry run: print what it would set
    backfill_spawned_from.py --write    # set it

Prompt that produced it: "backfill all the existing spinoffs" (with where
each spinoff came from, so a tree can be built from the ids).
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import store  # noqa: E402

# A spawn command and the slugs after it. Flags (`--room coding`) are skipped
# by the caller; a slug is the same shape routes/spinoff.py's SLUG_RE allows.
SPAWN_COMMAND = re.compile(
    r"spinoff_(open|offer)\.py((?:\s+(?:--[\w-]+(?:[ =][^\s;&|]+)?|[a-z0-9][a-z0-9-]{0,38}))+)")

# The spawn script's JSON reply, as it sits (escaped) inside a logged tool
# result: a conversation id and newly_spawned: true in the same object.
SPAWN_REPLY = re.compile(
    r'conversation_id\\*"\s*:\s*\\*"([0-9.\-]+)\\*"[^{}]{0,400}?newly_spawned\\*"\s*:\s*true'
    r'|newly_spawned\\*"\s*:\s*true[^{}]{0,400}?conversation_id\\*"\s*:\s*\\*"([0-9.\-]+)')

SPAWN_LOOP = re.compile(r"for \w+ in ([a-z0-9 -]+);\s*do\b(.*?spinoff_(?:open|offer)\.py)", re.S)

FORK_TITLE = re.compile(r"^# Fork: take over the work of “(.+)”", re.M)


def local_time(stamp):
    """Log timestamps are UTC ('...Z'); index `started` is local. Bring a log
    stamp into local time so the two compare. '' when there's none."""
    if not stamp:
        return ""
    try:
        return (datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                .astimezone().strftime("%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return stamp[:19]


def slugs_in(argument_text):
    """The slugs in a spawn command's arguments, flag/value pairs dropped."""
    slugs, skip_next = [], False
    for token in argument_text.split():
        if skip_next:
            skip_next = False
        elif token.startswith("--"):
            skip_next = "=" not in token
        else:
            slugs.append(token)
    return slugs


def scan_log(path):
    """Read one chat log. Returns (spawn commands, exact child ids).

    Spawn commands are (local time, kind, [slugs]) from the session's own Bash
    calls; exact child ids come from the spawn script's replies."""
    commands, children = [], set()
    try:
        lines = path.open(errors="replace")
    except OSError:
        return commands, children
    with lines:
        for line in lines:
            if "spinoff_o" not in line and "newly_spawned" not in line:
                continue
            if "newly_spawned" in line and "tool_result" in line:
                for match in SPAWN_REPLY.finditer(line):
                    children.add(match.group(1) or match.group(2))
            if "spinoff_o" not in line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") != "assistant":
                continue
            for block in (event.get("message") or {}).get("content") or []:
                if not (isinstance(block, dict) and block.get("type") == "tool_use"
                        and block.get("name") == "Bash"):
                    continue
                command = (block.get("input") or {}).get("command", "")
                stamp = local_time(event.get("timestamp"))
                for match in SPAWN_COMMAND.finditer(command):
                    commands.append((stamp, match.group(1), slugs_in(match.group(2))))
                # A shell loop spawning several at once:
                # `for slug in a b c; do spinoff_open.py "$slug"; done`.
                # The slugs sit in the loop's list, not after the script.
                loop = SPAWN_LOOP.search(command)
                if loop:
                    kind = "offer" if "spinoff_offer.py" in loop.group(2) else "open"
                    commands.append((stamp, kind, loop.group(1).split()))
    return commands, children


def read_brief(slug):
    # The database first (briefstore.py); the folders are where briefs were
    # kept before, and an install that hasn't imported them still has them.
    import briefstore
    kept = briefstore.latest(slug)
    if kept:
        return kept["body"]
    for folder in (store.SPINOFF_DIR, store.SPINOFF_ARCHIVE_DIR):
        try:
            return (folder / slug / "BRIEF.md").read_text(errors="replace")
        except OSError:
            continue
    return ""


def resolve(index, chats_dir, transcripts_dir):
    """Decide a (spawned_from, spawned_via, evidence) for every spinoff entry
    that has no spawned_via yet. Returns (decisions, unresolved ids)."""
    children = {cid: entry for cid, entry in index.items()
                if isinstance(entry, dict) and entry.get("spinoff_slug")
                and not entry.get("spawned_via")}

    # Every Observatory session's log, read once.
    commands_by_conv, exact_parent = {}, {}
    for path in sorted(chats_dir.glob("*.jsonl")):
        conv = path.stem
        commands, spawned = scan_log(path)
        commands_by_conv[conv] = commands
        for child in spawned:
            if child != conv:
                exact_parent.setdefault(child, conv)

    # Claude Code transcripts: ones belonging to an Observatory session count
    # as that session; the rest are terminal sessions.
    by_claude_session = {entry.get("claude_session_id"): cid for cid, entry in index.items()
                         if isinstance(entry, dict) and entry.get("claude_session_id")}
    terminal_commands = []
    if transcripts_dir.is_dir():
        for path in transcripts_dir.glob("*/*.jsonl"):
            commands, _ = scan_log(path)
            if not commands:
                continue
            owner = by_claude_session.get(path.stem)
            if owner:
                commands_by_conv.setdefault(owner, []).extend(commands)
            else:
                terminal_commands.extend(commands)

    decisions, unresolved = {}, []
    for cid, entry in sorted(children.items()):
        slug, started = entry["spinoff_slug"], (entry.get("started") or "")[:19]

        # 1. exact: the session that got the spawn script's reply.
        if cid in exact_parent:
            decisions[cid] = (exact_parent[cid], "skill", "exact")
            continue

        # 2. command: the last session to name this slug before it started.
        candidates = sorted(
            (stamp, conv, kind) for conv, commands in commands_by_conv.items()
            if conv != cid for stamp, kind, slugs in commands
            if slug in slugs and (not stamp or stamp <= started))
        if candidates:
            _, conv, kind = candidates[-1]
            decisions[cid] = (conv, "go" if kind == "offer" else "skill", "command")
            continue

        # 3. terminal: only a non-Observatory transcript ever named it.
        if any(slug in slugs and (not stamp or stamp <= started)
               for stamp, _, slugs in terminal_commands):
            decisions[cid] = (None, "terminal", "terminal transcript")
            continue

        # 4. fork: the brief names the session it took over, by title.
        if slug.startswith("fork-"):
            match = FORK_TITLE.search(read_brief(slug))
            if match:
                title = match.group(1)
                earlier = sorted(
                    ((other.get("started") or ""), other_id)
                    for other_id, other in index.items()
                    if isinstance(other, dict) and other_id != cid
                    and other.get("title") == title
                    and (other.get("started") or "")[:19] <= started)
                if earlier:
                    decisions[cid] = (earlier[-1][1], "fork", "fork brief title")
                    continue

        # 5. helper: a button minted it; there's no parent session.
        if entry.get("helper"):
            decisions[cid] = (None, "helper", "helper entry")
            continue

        unresolved.append(cid)
    return decisions, unresolved


def main():
    write = "--write" in sys.argv[1:]
    chats_dir = store.DATA_DIR / "bot_chats"
    transcripts_dir = Path.home() / ".claude" / "projects"
    index = store.read("bot_chats/index", {})
    decisions, unresolved = resolve(index, chats_dir, transcripts_dir)

    for cid, (parent, via, evidence) in sorted(decisions.items()):
        slug = index[cid]["spinoff_slug"]
        print(f"{cid:22} {slug[:32]:32} <- {parent or '-':22} {via:9} ({evidence})")
    for cid in unresolved:
        print(f"{cid:22} {index[cid]['spinoff_slug'][:32]:32} <- UNRESOLVED")
    print(f"\n{len(decisions)} resolved, {len(unresolved)} unresolved"
          + ("" if write else " — dry run, nothing written (--write to apply)"))

    if write and decisions:
        # Write under the lock, and only where nothing has been set meanwhile.
        with store.mutate("bot_chats/index", {}) as live:
            for cid, (parent, via, _) in decisions.items():
                entry = live.get(cid)
                if not isinstance(entry, dict) or entry.get("spawned_via"):
                    continue
                entry["spawned_via"] = via
                if parent:
                    entry["spawned_from"] = parent
    return 0


if __name__ == "__main__":
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
