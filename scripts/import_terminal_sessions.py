#!/usr/bin/env python3
"""Roll the live tmux terminal sessions' Claude conversations into the bot
surface (bot_chats/) so the Sessions page starts with her real, current
conversations instead of amnesia.

For every session in sessions.json with a live claude process, this:
- converts its Claude Code transcript into a bot_chats/<conv>.jsonl history
  (text turns only — tool noise, command wrappers, and compaction blobs are
  skipped; capped at the most recent MAX_MESSAGES so the chat page stays
  light);
- creates an index entry linking the session's claude_session_id, so the next
  send in the reading room RESUMES that very conversation.

Idempotent: a tmux session already imported (index entry carrying its
`imported_from`) is skipped on re-run.

NOTE the fork semantics: resuming an interactively-live session from the app
forks it — the tmux side keeps its own thread; the app side continues on a
new branch from the import point. Nothing is lost either way.

Usage: EXOCORTEX_DATA_DIR=... ./venv/bin/python3 scripts/import_terminal_sessions.py
"""
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store                                      # noqa: E402
from routes import bots, terminal                 # noqa: E402

MAX_MESSAGES = 400
# User-transcript lines that aren't her words: harness command wrappers and
# compaction recaps.
_SKIP_USER_PREFIXES = ("<", terminal._COMPACT_PREFIX)


def _user_text(content):
    """Her text from a transcript user message, or None if it's tool noise."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        parts = [b.get("text", "") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"]
        text = "\n".join(p for p in parts if p)
    else:
        return None
    text = text.strip()
    if not text or any(text.startswith(p) for p in _SKIP_USER_PREFIXES):
        return None
    return text


def _assistant_texts(content):
    if not isinstance(content, list):
        return []
    return [b["text"] for b in content
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]


def transcript_to_events(path):
    """Bot-chat events from a Claude Code transcript: text turns only, a
    closing result before each new user turn (so the reducer closes the
    assistant block), capped to the newest MAX_MESSAGES."""
    events = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict) or obj.get("isSidechain"):
            continue
        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue
        if msg.get("role") == "user":
            text = _user_text(msg.get("content"))
            if text:
                if events and events[-1]["type"] == "assistant":
                    events.append({"type": "result", "subtype": "imported"})
                events.append({"type": "user", "text": text,
                               "ts": obj.get("timestamp", "")})
        elif msg.get("role") == "assistant":
            texts = _assistant_texts(msg.get("content"))
            if texts:
                events.append({"type": "assistant", "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": t} for t in texts]}})
    if events and events[-1]["type"] == "assistant":
        events.append({"type": "result", "subtype": "imported"})
    return events[-MAX_MESSAGES:]


def main():
    live = terminal._live_claude_sessions()
    chats_dir = store.DATA_DIR / "bot_chats"
    chats_dir.mkdir(parents=True, exist_ok=True)
    existing_imports = {
        meta.get("imported_from")
        for meta in store.read("bot_chats/index", {}).values()
        if isinstance(meta, dict)
    }

    for sess in terminal._load_sessions():
        if sess in existing_imports:
            print(f"  {sess}: already imported — skipped")
            continue
        panes = terminal._tmux(f"list-panes -t {sess} -F '#{{pane_pid}}'").stdout.strip()
        if not panes:
            print(f"  {sess}: no live tmux pane — skipped")
            continue
        pane_pid = int(panes.splitlines()[0])
        claude = None
        for info in live:
            if pane_pid in terminal._proc_ancestors(info["pid"]):
                if claude is None or info.get("updatedAt", 0) > claude.get("updatedAt", 0):
                    claude = info
        if claude is None:
            print(f"  {sess}: no claude running inside — skipped")
            continue
        path = terminal._transcript_path(claude.get("cwd"), claude.get("sessionId"))
        if not path.exists():
            print(f"  {sess}: transcript not found — skipped")
            continue
        events = transcript_to_events(path)
        if not events:
            print(f"  {sess}: transcript held no text turns — skipped")
            continue

        journal = sess in terminal.KEEPER_CAPTURE_SESSIONS or terminal._is_thread_session(sess)
        last_at = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
        with store.mutate("bot_chats/index", {}) as index:
            conv_id = bots._new_conv_id(index)
            index[conv_id] = {
                "bot": "keeper",
                "title": sess.capitalize(),
                "started": last_at,
                "last_at": last_at,
                "claude_session_id": claude.get("sessionId"),
                "cost_usd": 0.0,
                "journal": journal,
                "imported_from": sess,
            }
        with open(chats_dir / f"{conv_id}.jsonl", "w", encoding="utf-8") as f:
            for e in events:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
        print(f"  {sess}: imported {len(events)} events -> {conv_id} "
              f"(journal={'on' if journal else 'off'}, resume={claude.get('sessionId')[:8]}…)")


if __name__ == "__main__":
    main()
