"""transcript_import.py — read a chatbot's data export into one common shape.

What it's for: someone downloads their history from ChatGPT or Claude.ai and
hands the file over. Each service writes its own format; this file has one
small reader per format, and every reader returns the SAME thing — a list of
conversations like:

    {"source": "chatgpt" | "claude",
     "source_id": "<the service's own id for the conversation>",
     "title": "...",
     "created_at": <unix seconds or None>,
     "updated_at": <unix seconds or None>,
     "messages": [{"role": "user" | "assistant", "text": "...", "at": <unix seconds or None>}]}

Everything downstream (transcriptstore.py, the sorter, the pond) only ever
sees that shape, so a new chatbot is a new reader here and nothing else.

`read_export(path)` takes the zip the service emails you, or the
`conversations.json` inside it, and works out which format it is from the
conversations' own keys — no filename or user choice needed.

Formats, and where they are guessed (checked against public write-ups of the
exports, 2026-09; neither company publishes a spec):
  - ChatGPT: `conversations.json` is a list; each conversation keeps its
    messages as a TREE in `mapping` (every edit or regenerate is a branch),
    and `current_node` is the leaf of the branch the user last saw. Walking
    parent links from there, reversed, is the visible chat. Times are unix
    seconds (`create_time`). GUESSED: which `content_type`s carry readable
    text — `text`, `multimodal_text` and `code` are read, everything else
    (thoughts, browsing displays, tool output) is skipped.
  - Claude.ai: `conversations.json` is a list of `{uuid, name, created_at,
    updated_at, chat_messages}`, each message `{sender: human|assistant,
    text, content, created_at}` with ISO-8601 times. GUESSED: when `text` is
    empty the words are read from `content` blocks of type "text"; attached
    files are noted by name only, never their contents.

Touches: nothing — pure reading. Used by routes/transcripts.py; tested by
tests/test_transcript_import.py against small made-up exports.

Prompt that produced it: "importers — one small reader per export format, each
converting into one common conversation format. Start with ChatGPT's data
export and Claude.ai's own data export."
"""
from datetime import datetime, timezone
import json
import zipfile


class ImportFormatError(ValueError):
    """The file isn't an export this module knows how to read."""


# --- ChatGPT -----------------------------------------------------------------

# The content types whose words a person actually saw in the chat.
_CHATGPT_READABLE = {"text", "multimodal_text", "code"}


def _chatgpt_text(content):
    """The words in one ChatGPT message's `content`, or '' if it holds none."""
    if not isinstance(content, dict) or content.get("content_type") not in _CHATGPT_READABLE:
        return ""
    if content.get("content_type") == "code":
        return str(content.get("text") or "")
    # Parts are strings, or dicts for images and files — a dict is shown as a
    # placeholder so the message still says something was attached.
    pieces = []
    for part in content.get("parts") or []:
        if isinstance(part, str):
            pieces.append(part)
        elif isinstance(part, dict):
            pieces.append("[image]" if "image" in str(part.get("content_type", "")) else "[attachment]")
    return "\n".join(p for p in pieces if p).strip()


def _chatgpt_branch(mapping, current):
    """The node ids on the branch the user last saw, oldest first.

    Walks parent links up from `current_node`. An export missing it (older
    ones, per reports) falls back to every node ordered by time."""
    if current and current in mapping:
        chain, seen = [], set()
        node = current
        while node and node in mapping and node not in seen:
            seen.add(node)
            chain.append(node)
            node = mapping[node].get("parent")
        return list(reversed(chain))

    def when(node_id):
        message = mapping[node_id].get("message") or {}
        return message.get("create_time") or 0
    return sorted(mapping, key=when)


def read_chatgpt(conversation):
    """One ChatGPT conversation into the common shape."""
    mapping = conversation.get("mapping") or {}
    messages = []
    for node_id in _chatgpt_branch(mapping, conversation.get("current_node")):
        message = mapping[node_id].get("message")
        if not isinstance(message, dict):
            continue
        role = (message.get("author") or {}).get("role")
        # System and tool messages are internal: ChatGPT never shows them.
        if role not in ("user", "assistant"):
            continue
        if (message.get("metadata") or {}).get("is_visually_hidden_from_conversation"):
            continue
        text = _chatgpt_text(message.get("content"))
        if text:
            messages.append({"role": role, "text": text, "at": _seconds(message.get("create_time"))})
    return {
        "source": "chatgpt",
        "source_id": str(conversation.get("conversation_id") or conversation.get("id") or ""),
        "title": (conversation.get("title") or "").strip() or "Untitled",
        "created_at": _seconds(conversation.get("create_time")),
        "updated_at": _seconds(conversation.get("update_time")),
        "messages": messages,
    }


# --- Claude.ai ---------------------------------------------------------------

def _claude_text(message):
    """The words in one Claude.ai message: `text`, else its text blocks."""
    text = (message.get("text") or "").strip()
    if not text:
        blocks = message.get("content") or []
        text = "\n".join(
            str(block.get("text") or "") for block in blocks
            if isinstance(block, dict) and block.get("type") == "text"
        ).strip()
    # Attachments are named, not inlined — their extracted text can be a whole
    # book, and it's the user's file, not something they said.
    names = [a.get("file_name") for a in (message.get("attachments") or []) + (message.get("files") or [])
             if isinstance(a, dict) and a.get("file_name")]
    if names:
        text = (text + "\n" if text else "") + " ".join(f"[attached: {n}]" for n in names)
    return text


def read_claude(conversation):
    """One Claude.ai conversation into the common shape."""
    messages = []
    for message in conversation.get("chat_messages") or []:
        if not isinstance(message, dict):
            continue
        role = {"human": "user", "assistant": "assistant"}.get(message.get("sender"))
        text = _claude_text(message)
        if role and text:
            messages.append({"role": role, "text": text, "at": _seconds(message.get("created_at"))})
    return {
        "source": "claude",
        "source_id": str(conversation.get("uuid") or ""),
        "title": (conversation.get("name") or "").strip() or "Untitled",
        "created_at": _seconds(conversation.get("created_at")),
        "updated_at": _seconds(conversation.get("updated_at")),
        "messages": messages,
    }


# --- shared ------------------------------------------------------------------

def _seconds(value):
    """A time as unix seconds: accepts unix numbers or ISO-8601 text; None if neither."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        # A time with no zone is taken as UTC — both services write UTC.
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    return None


def read_conversations(data):
    """A parsed conversations.json list into common-shape conversations.

    The format is decided per conversation by its keys: `mapping` is ChatGPT,
    `chat_messages` is Claude.ai. Conversations with no readable messages or
    no id are dropped rather than stored as empty shells."""
    if not isinstance(data, list):
        raise ImportFormatError("expected a list of conversations")
    out = []
    for conversation in data:
        if not isinstance(conversation, dict):
            continue
        if "mapping" in conversation:
            read = read_chatgpt(conversation)
        elif "chat_messages" in conversation:
            read = read_claude(conversation)
        else:
            continue
        if read["source_id"] and read["messages"]:
            out.append(read)
    if data and not out:
        raise ImportFormatError("no ChatGPT or Claude.ai conversations found in this file")
    return out


def read_export(path):
    """Read an export zip, or a bare conversations.json, into common-shape conversations.

    In a zip, every member named conversations*.json is read (some exports
    split large histories across several — GUESSED from reports, harmless if
    there's only one)."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            members = [name for name in archive.namelist()
                       if name.rsplit("/", 1)[-1].startswith("conversations")
                       and name.endswith(".json")]
            if not members:
                raise ImportFormatError("no conversations.json in this zip")
            out = []
            for name in sorted(members):
                with archive.open(name) as handle:
                    out.extend(read_conversations(_load(handle)))
            return out
    with open(path, "rb") as handle:
        return read_conversations(_load(handle))


def _load(handle):
    try:
        return json.load(handle)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ImportFormatError(f"not valid JSON: {exc}") from exc
