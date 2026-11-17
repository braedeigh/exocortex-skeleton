#!/usr/bin/env python3
"""
Lives in the skeleton (shareable engine); the vault keeps exec-shims at
tulku/_system/ for existing callers.

stream.py — the deterministic spine of the journal's stream-cards architecture.

See STREAM.md (same directory) for the full writeup; this is the summary needed to
read the code.

THE MODEL. The journal is an append-only stream of atomic CARDS — one per
utterance — and everything a human actually reads is a disposable derived VIEW,
rendered from the cards by this module. Since 2026-11 the cards are ROWS in
exo.db (tables in journaldb.py, the design in docs/journal-database.md), not
files:

    exo.db: cards, card_labels, ...  CARDS  one row per utterance. truth.
    _system/data/manifests/<name>.md MANIFEST  a selection rule (tag=X) + an output path.
    _system/data/index/YYYY-MM.md    INDEX  one line per card that month. derived.
    Journal/Daily/YYYY-MM-DD.md      VIEW   the day, rendered exactly as it always
                                            looked. derived, disposable.
    <manifest out path>              VIEW   e.g. people/views/sage.md — every card
                                            tagged `sage`, inlined verbatim. derived.
    _system/data/cards/<id>.md       COMPAT the old one-file-per-card pool, still
                                            written from the rows until every reader
                                            reads the database (STREAM_CARD_FILES=0
                                            stops it). derived, never read back here.
    _system/data/holding_cards.jsonl HOLD   cards the database couldn't take yet;
                                            drained on the next write and by cron.

Only cards are truth. Views can be deleted and rebuilt at any time — never hand-edit
one; edit (or mint) a card and re-render. `validate` catches a view that drifted,
and a card whose fingerprint no longer matches its words.

THE 24-HOUR RULE. A card can be edited or deleted for 24 hours after it was
saved, then never — enforced by triggers in the database, so it holds for every
writer. Later thoughts on a locked card are new cards linked to it as a `note`.

FISH LINEAGE. This ports Ian Fish's exo "stream-cards" vault: pool/manifest/view
split, capture-at-source, a deterministic stdlib-only spine, derived-never-stored
membership. Same grounding as event-sourced systems generally — log as source of
truth, materialized views over it (Kleppmann, DDIA ch. 11-12).

THE LEGIBLE-ID DIVERGENCE. Fish's card ids are content hashes (`sha256(body, parent)`,
his `enc:v2` Merkle-DAG) — that scheme solves *his* problem: multiple people appending
to a shared pool from multiple devices over dumb folder sync, no server, no git.
This journal is one writer on one machine, so ids here are time-based and
self-describing instead:

    YYYY-MM-DD.HHMM + speaker letter (+ a counter if the same speaker mints twice in
    the same minute): 2026-07-06.0843b, then 2026-07-06.0843b2, ...b3.

A link tells you when it was and who spoke before you read a byte. The same
single-writer reasoning is why the cards left their one-file-per-card pool for one database:
the file design came from the multi-writer, serverless system.

One addition beyond fish: labels (tags), not reply-subtrees, are the collection
primitive here — a person or a worry threads through months of unrelated
conversation rather than living under one root card.

THE VERBS. `record` (mint a card: body from `--body-file PATH` or stdin, plus flags;
re-render its day + month; echo the id), `render` (rebuild `--day`, `--view NAME`, or
`--all`), `tag` / `untag` (labels, with `--by/--run/--reason/--weight`), `link`
(`note` / `answers` between two cards), `edit` (replace a card's words inside its 24
hours), `delete` (hide a card inside its 24 hours), `drain` (move held cards into the
database), `validate` (integrity of the rows + drift of every derived file).

Stdlib only. No network. No randomness. Same cards in, same bytes out, always.
"""
import argparse
import fcntl
import json
import os
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# journaldb.py sits beside this file. Put its folder on the path whichever way
# this module was loaded — run directly, imported as tools.stream.stream, or
# exec'd from a file path (scripts/thread_tending.py).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import journaldb  # noqa: E402

# A new timestamp marker in a day view is emitted only when this much wall-clock time
# has passed since the previous line card — mirrors keeper_capture.py's GAP_SECONDS.
GAP_SECONDS = 10 * 60

# Who a card is from: B = the owner, K = the keeper, S = the system — text
# neither of them wrote, such as a Coming up reminder the app sent into the
# Keeper's chat at its set time (routes/observatory.py begin_turn).
VALID_WHO = ("B", "K", "S")
VALID_KIND = ("line", "context", "ref")


class StreamError(Exception):
    """A caller-facing problem (bad input, missing card, a locked card) — the
    CLI catches these and prints a clean message instead of a traceback."""


# --------------------------------------------------------------------------------
# Root resolution. Lazy on purpose (read the env var on every call, never cached at
# import time) so tests can point TULKU_STREAM_ROOT at a tempdir without a reload.
# --------------------------------------------------------------------------------

def stream_root() -> Path:
    env = os.environ.get("TULKU_STREAM_ROOT")
    if env:
        return Path(env)
    env = os.environ.get("EXOCORTEX_CONTENT_DIR")
    if env:
        return Path(env)
    raise StreamError(
        "journal engine cannot locate the vault: set TULKU_STREAM_ROOT or "
        "EXOCORTEX_CONTENT_DIR to the tulku content dir"
    )


def pool_dir() -> Path:
    return stream_root() / "_system" / "data" / "cards"


def manifests_dir() -> Path:
    return stream_root() / "_system" / "data" / "manifests"


def index_dir() -> Path:
    return stream_root() / "_system" / "data" / "index"


def daily_dir() -> Path:
    return stream_root() / "Journal" / "Daily"


def card_path(cid: str) -> Path:
    return pool_dir() / f"{cid}.md"


def deleted_log_path() -> Path:
    """The old deletion log: every card the `delete` verb removed while cards
    were files. Read only by the migration now — a delete is the row's own
    deleted_at since."""
    return pool_dir().parent / "deleted_cards.jsonl"


def edited_log_path() -> Path:
    """The old edit history file: one JSON line per change, text before and
    after. `card_edits` is the truth now; this file is still appended to while
    the compatibility card files are on, because the journal page reads it."""
    return pool_dir().parent / "edited_cards.jsonl"


def day_legend() -> str:
    """The speaker legend under a day view's title. The owner's name is PERSONAL
    data, so it never lives in this shareable file: resolution is env
    (STREAM_DAY_LEGEND — the content-scaffold convention) -> the vault's
    `_system/data/config.json` `day_legend` key -> a generic default. Read
    lazily per render so a config change lands on the next re-render."""
    env = os.environ.get("STREAM_DAY_LEGEND")
    if env:
        return env
    cfg_path = stream_root() / "_system" / "data" / "config.json"
    try:
        legend = json.loads(cfg_path.read_text(encoding="utf-8")).get("day_legend")
        if legend:
            return legend
    except (OSError, ValueError):
        pass
    return "B = you | K = keeper"


# --------------------------------------------------------------------------------
# Card: one row of `cards`, with what the old file header carried (tags, reply_to,
# edited) filled in from the side tables. The file parser/serializer below stays
# for the compatibility files and for the migration that reads the old pool.
# --------------------------------------------------------------------------------

@dataclass
class Card:
    id: str
    who: str                      # "B" | "K"
    ts: str                       # "YYYY-MM-DD HH:MM:SS"
    reply_to: Optional[str]
    tags: List[str] = field(default_factory=list)
    kind: str = "line"            # "line" | "context" | "ref"
    refs: List[str] = field(default_factory=list)  # ref targets: "YYYY-MM-DD" or a
                                                     # vault-relative path, e.g. "people/x.md"
    # Where this card was pulled FROM: an observatory conversation id, when the
    # card was minted by highlighting a span of that conversation rather than by
    # the ordinary capture path. Provenance only — nothing selects on it (that's
    # what tags are for), it just lets the journal offer a way back to the room
    # the words were said in. Optional everywhere: a card without one is a card
    # nobody pulled, which is most of them.
    #
    # Prompt: "I want to be able to annotate it and I want it to track which
    # session it came from."
    session: Optional[str] = None
    # When the card's text was last changed, 'YYYY-MM-DD HH:MM:SS', or None for
    # a card never edited (nearly all of them). The full history, old text
    # included, is in the card_edits table.
    #
    # Prompt: "any changes i want to be marked as edits on the date they were
    # made" — and keep the old text.
    edited: Optional[str] = None
    body: str = ""
    # How it came in (web, hook, reconciler, voice, cli, ...) and which machine
    # heard it — capture facts, from the database row.
    door: Optional[str] = None
    device: Optional[str] = None
    # When the row was written (the 24-hour lock runs from here), and when it
    # was deleted, if it was. None for a card that only exists as parsed text.
    saved_at: Optional[str] = None
    deleted_at: Optional[str] = None
    # Set by add_tags/remove_tags: what happened to each tag asked for.
    outcomes: Dict[str, str] = field(default_factory=dict)


def _split_frontmatter(text: str) -> Tuple[str, str]:
    """Split `---\\n<fields>\\n---\\n<body>` into (raw field block, raw body).

    Splits on the literal `---` (not `---\\n`) so the body chunk keeps the newline
    that terminated the closing delimiter line; exactly one leading newline is then
    stripped from it, per the card format spec."""
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise StreamError("malformed card/manifest: missing '---' frontmatter delimiters")
    front_raw, rest = parts[1], parts[2]
    if rest.startswith("\n"):
        rest = rest[1:]
    return front_raw, rest


def _parse_front_lines(front_raw: str) -> Dict[str, str]:
    fields_: Dict[str, str] = {}
    for line in front_raw.strip("\n").split("\n"):
        if not line.strip():
            continue
        if ":" not in line:
            raise StreamError(f"malformed frontmatter line: {line!r}")
        key, _, val = line.partition(":")
        fields_[key.strip()] = val.strip()
    return fields_


def _parse_tags(val: str) -> List[str]:
    val = val.strip()
    if val.startswith("[") and val.endswith("]"):
        val = val[1:-1].strip()
    if not val:
        return []
    return [t.strip() for t in val.split(",") if t.strip()]


# Same inline-list shape as tags (`[a, b, c]`, comma-separated) — reused for `refs`.
_parse_refs = _parse_tags


def parse_card_text(text: str) -> Card:
    front_raw, body = _split_frontmatter(text)
    fields_ = _parse_front_lines(front_raw)
    for required in ("id", "who", "ts", "reply_to", "tags", "kind"):
        if required not in fields_:
            raise StreamError(f"card missing required field {required!r}")
    reply_to = None if fields_["reply_to"] == "null" else fields_["reply_to"]
    # `refs` and `session` are optional on parse (older cards predate them) —
    # they default to [] and None. Same forward-compatibility shape both times:
    # absent means "this card was written before the field existed", which reads
    # identically to "this card doesn't have one".
    refs = _parse_refs(fields_["refs"]) if "refs" in fields_ else []
    session = fields_.get("session", "null")
    edited = fields_.get("edited", "null")
    return Card(
        id=fields_["id"],
        who=fields_["who"],
        ts=fields_["ts"],
        reply_to=reply_to,
        tags=_parse_tags(fields_["tags"]),
        kind=fields_["kind"],
        refs=refs,
        session=None if session in ("null", "") else session,
        edited=None if edited in ("null", "") else edited,
        body=body.rstrip("\n"),
    )


def parse_card_file(path: Path) -> Card:
    return parse_card_text(path.read_text(encoding="utf-8"))


def render_card_text(card: Card) -> str:
    reply = card.reply_to if card.reply_to is not None else "null"
    header = "\n".join([
        "---",
        f"id: {card.id}",
        f"who: {card.who}",
        f"ts: {card.ts}",
        f"reply_to: {reply}",
        f"tags: [{', '.join(card.tags)}]",
        f"kind: {card.kind}",
        f"refs: [{', '.join(card.refs)}]",
        f"session: {card.session if card.session is not None else 'null'}",
    ])
    # `edited` is written only once a card has been edited, unlike the fields
    # above — so every card that was never edited keeps exactly the bytes it
    # always had, rather than every file on disk growing an `edited: null`.
    if card.edited:
        header += f"\nedited: {card.edited}"
    header += "\n---"
    # Exactly one trailing newline, regardless of how many the body carries.
    return header + "\n" + card.body.rstrip("\n") + "\n"


@contextmanager
def pool_lock():
    """Serialize the engine's writers across processes (server mint, hook mint,
    reconciler, taggers). flock on a sidecar beside the old card folder. The
    database already serializes its own writes; this lock also covers the
    compatibility card file written right after each commit, so two writers
    can't leave that file showing the older of their two changes."""
    d = pool_dir()
    d.mkdir(parents=True, exist_ok=True)
    with open(d.parent / "pool.lock", "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        yield


# --------------------------------------------------------------------------------
# The database: where it is and how the engine opens it. Everything about the
# tables themselves lives in journaldb.py, shared with the app's ladder.
# --------------------------------------------------------------------------------

def db_path() -> Path:
    """exo.db, found the way the app finds it (see journaldb.db_path)."""
    try:
        root = stream_root()
    except StreamError:
        root = None
    try:
        return journaldb.db_path(root)
    except journaldb.NotReady as e:
        raise StreamError(str(e))


@contextmanager
def _db():
    conn = journaldb.connect(db_path())
    try:
        yield conn
    finally:
        conn.close()


def _label_context() -> "journaldb.LabelContext":
    """What it takes to classify a brand-new tag: the vault (people and
    thread files) and the data dir (fronts.json)."""
    try:
        root = stream_root()
    except StreamError:
        root = None
    return journaldb.LabelContext(root, db_path().parent)


# The failures that send a card to the holding file instead of the database:
# anything wrong with the database itself, or the old file layout's lock.
_DB_FAILURES = (sqlite3.Error, journaldb.NotReady, OSError)


def _is_lock_refusal(exc: Exception) -> bool:
    return "locked: saved more than 24 hours ago" in str(exc)


# --------------------------------------------------------------------------------
# Compatibility card files. Until every reader reads the database (the
# readers session of docs/journal-database.md), each card is ALSO written out
# as the markdown file it used to be — derived from the row, after the commit,
# never read back by the engine. STREAM_CARD_FILES=0 turns it off; the
# readers session flips the default and a later session removes the folder.
# --------------------------------------------------------------------------------

def card_files_enabled() -> bool:
    return os.environ.get("STREAM_CARD_FILES", "1") != "0"


def write_card(card: Card) -> Path:
    """Write a card's compatibility file ATOMICALLY: temp file, fsync,
    os.replace(), so a reader sees the whole file or none of it."""
    pool_dir().mkdir(parents=True, exist_ok=True)
    path = card_path(card.id)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(render_card_text(card))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path


def _sync_card_file(cid: str) -> None:
    """Bring one compatibility file in line with the database: rewrite it
    from the row, or remove it if the card is deleted. Best-effort — the
    row is the truth, and a file that lags is fixed by the next write."""
    if not card_files_enabled():
        return
    try:
        card = _read_card_any(cid)
        if card is None or card.deleted_at:
            card_path(cid).unlink(missing_ok=True)
        else:
            write_card(card)
    except Exception:
        pass


def _append_compat_edit_log(entry: dict) -> None:
    """The edit history the journal page still reads from a file
    (routes/cards.py). `card_edits` is the truth; this line is its echo."""
    if not card_files_enabled():
        return
    try:
        path = edited_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------------
# Reading cards back out of the database.
# --------------------------------------------------------------------------------

def _card_from_row(row: dict) -> Card:
    return Card(
        id=row["id"], who=row["who"], ts=row["said_at"], reply_to=row["reply_to"],
        tags=row["tags"], kind=row["kind"], refs=row["refs"], session=row["session"],
        edited=row["edited"], body=row["body"], door=row["door"], device=row["device"],
        saved_at=row["saved_at"], deleted_at=row["deleted_at"],
    )


def _fetch(where: str = "deleted_at IS NULL", params=()) -> List[Card]:
    with _db() as conn:
        return [_card_from_row(r) for r in journaldb.fetch_cards(conn, where, params)]


def _read_card_any(cid: str) -> Optional[Card]:
    """One card by id, deleted or not; None if there's no such row."""
    found = _fetch("id = ?", (cid,))
    return found[0] if found else None


def read_card(cid: str) -> Card:
    """One live (not deleted) card by id. A database failure surfaces as a
    StreamError, so the CLI reports it cleanly."""
    try:
        card = _read_card_any(cid)
    except _DB_FAILURES as e:
        raise StreamError(f"journal database unavailable: {e}")
    if card is None or card.deleted_at:
        raise StreamError(f"no such card: {cid}")
    return card


def card_exists(cid: str) -> bool:
    try:
        card = _read_card_any(cid)
    except _DB_FAILURES:
        return False
    return card is not None and not card.deleted_at


def load_all_cards() -> List[Card]:
    """Every live card, oldest first."""
    return _fetch()


def load_day_cards(day: str) -> List[Card]:
    return _fetch("deleted_at IS NULL AND day = ?", (day,))


def load_month_cards(month: str) -> List[Card]:
    return _fetch("deleted_at IS NULL AND day LIKE ?", (f"{month}-%",))


# --------------------------------------------------------------------------------
# Manifest: a selection rule + an output path. Same frontmatter mechanics as a card
# file had, different fields (select / render / out), no body.
# --------------------------------------------------------------------------------

@dataclass
class Manifest:
    name: str
    select_key: str
    select_value: str
    render: str
    out: str


def parse_manifest_text(name: str, text: str) -> Manifest:
    front_raw, _body = _split_frontmatter(text)
    fields_ = _parse_front_lines(front_raw)
    for required in ("select", "render", "out"):
        if required not in fields_:
            raise StreamError(f"manifest {name!r} missing required field {required!r}")
    key, _, value = fields_["select"].partition("=")
    return Manifest(
        name=name,
        select_key=key.strip(),
        select_value=value.strip(),
        render=fields_["render"].strip(),
        out=fields_["out"].strip(),
    )


def load_manifest(name: str) -> Manifest:
    path = manifests_dir() / f"{name}.md"
    if not path.exists():
        raise StreamError(f"no such manifest: {name}")
    return parse_manifest_text(name, path.read_text(encoding="utf-8"))


def manifest_names() -> List[str]:
    d = manifests_dir()
    if not d.exists():
        return []
    return sorted(p.stem for p in d.glob("*.md"))


def cards_for_manifest(manifest: Manifest, cards: Optional[List[Card]] = None) -> List[Card]:
    if manifest.select_key != "tag":
        return []
    if cards is None:
        cards = _fetch(
            "deleted_at IS NULL AND id IN (SELECT card_id FROM card_tags WHERE tag = ?)",
            (manifest.select_value,))
    return sorted(
        (c for c in cards if manifest.select_value in c.tags),
        key=lambda c: (c.ts, c.id),
    )


# --------------------------------------------------------------------------------
# Id minting
# --------------------------------------------------------------------------------

def mint_id(ts: datetime, who: str, conn: Optional[sqlite3.Connection] = None) -> str:
    """`YYYY-MM-DD.HHMM` + speaker letter, + a counter if that minute is
    taken. Taken means a row exists (deleted rows too — an id is never
    reused) or, while the compatibility files exist, a file does."""
    base = f"{ts.strftime('%Y-%m-%d.%H%M')}{who.lower()}"

    def taken(cid: str) -> bool:
        if conn is not None and conn.execute("SELECT 1 FROM cards WHERE id = ?", (cid,)).fetchone():
            return True
        return card_path(cid).exists()

    if not taken(base):
        return base
    counter = 2
    while taken(f"{base}{counter}"):
        counter += 1
    return f"{base}{counter}"


# --------------------------------------------------------------------------------
# record — the primitive every card is born through.
#
# SAVING A CARD NEVER FAILS BECAUSE OF THE DATABASE. If the write can't happen
# (locked past the wait, the tables not built yet, the file broken), the card
# is appended to the holding file instead and its provisional id is echoed. The
# next successful record — or the reconciler's minute cron — drains the holding
# file into the database. A held card keeps its own time; its final id is
# minted when it lands, so it can differ from the provisional one if that
# minute filled up meanwhile.
# --------------------------------------------------------------------------------

def holding_path() -> Path:
    """Cards waiting for the database. Beside the old card folder, inside the
    vault — so a held card is in the hourly git commit too."""
    return pool_dir().parent / "holding_cards.jsonl"


def _split_source_tags(tags: List[str], door: Optional[str], device: Optional[str]):
    """The capture facts that used to be tags — `voice`, `via:<device>` —
    become the door and device columns; every other tag stays a label."""
    labels = []
    for tag in tags:
        if tag == "voice":
            door = door or "voice"
        elif tag.startswith("via:"):
            device = device or tag[len("via:"):] or None
        else:
            labels.append(tag)
    return labels, door, device


def _insert_entry(conn, entry: dict, strict: bool = True) -> Tuple[str, bool]:
    """Write one card (an entry dict, as record builds it) inside an open
    transaction. Returns (id, inserted). With strict=False (draining the
    holding file) a link to a card that doesn't exist is dropped instead of
    refusing the card, and a card already in the database — same speaker,
    time and words — is recognized instead of written twice."""
    said_at = entry["ts"]
    body = entry["body"]
    if not strict:
        same = conn.execute(
            "SELECT id FROM cards WHERE fingerprint = ?",
            (journaldb.fingerprint(entry["who"], said_at, body),)).fetchone()
        if same:
            return same[0], False
    links = []
    for kind, target in (("answers", entry.get("reply_to")), ("note", entry.get("note_on"))):
        if not target:
            continue
        alive = conn.execute("SELECT 1 FROM cards WHERE id = ? AND deleted_at IS NULL",
                             (target,)).fetchone()
        if alive:
            links.append((kind, target))
        elif strict:
            flag = "--reply-to" if kind == "answers" else "--note-on"
            raise StreamError(f"{flag} {target!r} does not resolve to an existing card")
    labels, door, device = _split_source_tags(list(entry.get("tags") or []),
                                              entry.get("door"), entry.get("device"))
    cid = mint_id(datetime.strptime(said_at, "%Y-%m-%d %H:%M:%S"), entry["who"], conn)
    now = journaldb.now_text()
    journaldb.insert_card(
        conn, id=cid, who=entry["who"], said_at=said_at, body=body, kind=entry["kind"],
        refs=entry.get("refs") or [], door=door, device=device,
        session=entry.get("session"), saved_at=now)
    context = _label_context()
    for slug in dict.fromkeys(labels):
        journaldb.add_label(conn, cid, slug, entry.get("by") or "capture", context, added_at=now)
    for kind, target in links:
        journaldb.link(conn, cid, target, kind, by=entry.get("by"), linked_at=now)
    return cid, True


def _write_entry(entry: dict, strict: bool = True) -> Tuple[str, bool]:
    with pool_lock():
        with _db() as conn:
            journaldb.begin_immediate(conn)
            try:
                cid, inserted = _insert_entry(conn, entry, strict)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        if inserted:
            _sync_card_file(cid)
    return cid, inserted


def _hold(entry: dict, error: Exception) -> str:
    """Append a card the database couldn't take to the holding file, and
    return its provisional id. One O_APPEND write per line, so concurrent
    holders interleave whole lines. If even this fails the error propagates:
    the callers above it (the hook, the send route) log the words to their
    own failure files, so they are never lost silently."""
    ts_dt = datetime.strptime(entry["ts"], "%Y-%m-%d %H:%M:%S")
    provisional = mint_id(ts_dt, entry["who"])
    line = dict(entry, held_at=journaldb.now_text(), error=repr(error), provisional_id=provisional)
    path = holding_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(line, ensure_ascii=False) + "\n")
    return provisional


def held_cards() -> List[dict]:
    """What's waiting in the holding file. Never raises."""
    try:
        # "\n" only — splitlines() would also break at Unicode line
        # separators inside a held card's words, which the JSON leaves raw.
        lines = holding_path().read_text(encoding="utf-8").split("\n")
    except OSError:
        return []
    held = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("body") and entry.get("ts"):
            held.append(entry)
    return held


def drain_holding() -> int:
    """Move every held card into the database, oldest first. Returns how many
    landed. Cards that still can't be written stay held, in order. Safe to
    run from several processes at once: a lock beside the file serializes
    drains, and a card already in the database is recognized, not doubled."""
    path = holding_path()
    if not path.exists() or path.stat().st_size == 0:
        return 0
    landed = []
    with open(path.with_suffix(".lock"), "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        remaining = []
        for raw in path.read_text(encoding="utf-8").split("\n"):   # see held_cards
            if not raw.strip():
                continue
            try:
                entry = json.loads(raw)
            except ValueError:
                remaining.append(raw)   # unreadable: keep it for a person to look at
                continue
            if remaining:
                remaining.append(raw)   # keep order: nothing jumps a card still waiting
                continue
            try:
                cid, inserted = _write_entry(entry, strict=False)
            except _DB_FAILURES:
                remaining.append(raw)
                continue
            if inserted:
                landed.append((cid, entry))
        tmp = path.with_suffix(".tmp")
        tmp.write_text("".join(line + "\n" for line in remaining), encoding="utf-8")
        os.replace(tmp, path)
    for cid, entry in landed:
        _rerender_for(entry["ts"], list(entry.get("tags") or []))
    return len(landed)


def _drain_if_waiting() -> None:
    try:
        if holding_path().exists() and holding_path().stat().st_size:
            drain_holding()
    except Exception:
        pass   # the minute cron tries again


def record(
    who: str,
    body: str,
    reply_to: Optional[str] = None,
    tags: Optional[List[str]] = None,
    ts: Optional[datetime] = None,
    kind: str = "line",
    refs: Optional[List[str]] = None,
    session: Optional[str] = None,
    door: Optional[str] = None,
    device: Optional[str] = None,
    by: Optional[str] = None,
    note_on: Optional[str] = None,
) -> str:
    """Mint a card and return its id. `reply_to` links it as the answer to
    that card; `note_on` links it as a later note on that card. `door` says
    how it came in, `device` which machine heard it; `by` is who its labels
    are credited to (default: capture)."""
    who = (who or "").upper()
    if who not in VALID_WHO:
        raise StreamError(f"--who must be B, K or S, got {who!r}")
    if kind not in VALID_KIND:
        raise StreamError(f"--kind must be one of {VALID_KIND}, got {kind!r}")
    if not body.strip():
        raise StreamError("empty (or whitespace-only) body — no card recorded")
    ts_dt = ts or datetime.now()
    entry = {
        "who": who, "body": body.rstrip("\n"), "ts": ts_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "kind": kind, "reply_to": reply_to, "note_on": note_on, "tags": list(tags or []),
        "refs": list(refs or []), "session": session or None, "door": door or None,
        "device": device or None, "by": by or None,
    }
    try:
        cid, _inserted = _write_entry(entry)
    except StreamError:
        raise
    except _DB_FAILURES as e:
        return _hold(entry, e)
    _rerender_for(entry["ts"], entry["tags"])
    _drain_if_waiting()
    return cid


def _rerender_for(ts: str, tags: List[str]) -> None:
    render_day(ts[:10])
    render_month_index(ts[:7])
    _render_manifests_for_tags(tags)


# --------------------------------------------------------------------------------
# tag / untag — labels on a card, with who did it and why.
#
# Labels are rows (journaldb.card_labels), not words in a file. Taking one off
# marks its row instead of deleting it. Two rules hold whoever calls: an agent
# never removes a label the owner added, and never re-adds one she took off —
# those come back as `refused` instead of happening.
# --------------------------------------------------------------------------------

def add_tags(cid: str, tags_to_add: List[str], by: str = "cli", run: Optional[str] = None,
             reason: Optional[str] = None, weight: Optional[str] = None) -> Card:
    """Put labels on a card. The returned card carries `outcomes`: for each
    tag, 'added', 'already' or 'refused'."""
    if weight not in (None, "about", "touches"):
        raise StreamError("--weight must be 'about' or 'touches'")
    outcomes = _change_labels(cid, lambda conn, slug, context: journaldb.add_label(
        conn, cid, slug, by, context, run=run, reason=reason, weight=weight), tags_to_add)
    card = read_card(cid)
    card.outcomes = outcomes
    _rerender_after_tag_change(card, tags_to_add)
    return card


def remove_tags(cid: str, tags_to_remove: List[str], by: str = "cli",
                reason: Optional[str] = None) -> Card:
    """Take labels off a card. `outcomes` per tag: 'removed', 'absent' or
    'refused'."""
    outcomes = _change_labels(cid, lambda conn, slug, context: journaldb.remove_label(
        conn, cid, slug, by, why=reason), tags_to_remove)
    card = read_card(cid)
    card.outcomes = outcomes
    _rerender_after_tag_change(card, tags_to_remove)
    return card


def _change_labels(cid: str, change, slugs: List[str]) -> Dict[str, str]:
    _check_cid_safe(cid)
    try:
        with pool_lock():
            with _db() as conn:
                journaldb.begin_immediate(conn)
                try:
                    if not conn.execute("SELECT 1 FROM cards WHERE id = ? AND deleted_at IS NULL",
                                        (cid,)).fetchone():
                        raise StreamError(f"no such card: {cid}")
                    context = _label_context()
                    outcomes = {slug: change(conn, slug, context) for slug in dict.fromkeys(slugs)}
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
            _sync_card_file(cid)
    except _DB_FAILURES as e:
        raise StreamError(f"journal database unavailable: {e}")
    return outcomes


def _render_manifests_for_tags(tags: List[str]) -> None:
    """Re-render every `select: tag=X` manifest whose X is in `tags` — the shared tail
    of tag change / edit / delete, all of which can invalidate a manifest view."""
    for name in manifest_names():
        spec = load_manifest(name)
        if spec.select_key == "tag" and spec.select_value in tags:
            render_manifest(name)


def _rerender_after_tag_change(card: Card, involved_tags: List[str]) -> None:
    render_day(card.ts[:10])
    render_month_index(card.ts[:7])
    _render_manifests_for_tags(involved_tags)


# --------------------------------------------------------------------------------
# link — a newer card pointing at an older one: `note` (a later thought on a
# card, usually one that is locked) or `answers` (a reply to a Keeper
# question). Links are never changed or removed, and linking never touches
# either card's own row, so it works on cards of any age.
# --------------------------------------------------------------------------------

LINK_KINDS = ("note", "answers")


def link_cards(from_card: str, to_card: str, kind: str, by: Optional[str] = None) -> bool:
    """Link two existing cards. True if the link is new."""
    _check_cid_safe(from_card)
    _check_cid_safe(to_card)
    if kind not in LINK_KINDS:
        raise StreamError(f"--kind must be one of {LINK_KINDS}, got {kind!r}")
    if from_card == to_card:
        raise StreamError("a card can't link to itself")
    try:
        with pool_lock():
            with _db() as conn:
                journaldb.begin_immediate(conn)
                try:
                    for cid in (from_card, to_card):
                        if not conn.execute("SELECT 1 FROM cards WHERE id = ? AND deleted_at IS NULL",
                                            (cid,)).fetchone():
                            raise StreamError(f"no such card: {cid}")
                    made = journaldb.link(conn, from_card, to_card, kind, by=by)
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
            _sync_card_file(from_card)
    except _DB_FAILURES as e:
        raise StreamError(f"journal database unavailable: {e}")
    card = read_card(from_card)
    render_day(card.ts[:10])
    return made


# --------------------------------------------------------------------------------
# Id safety. Ids come from callers and still name compatibility files — refuse
# anything that could walk out of the card folder.
# --------------------------------------------------------------------------------

def _check_cid_safe(cid: str) -> None:
    if not cid or "/" in cid or "\\" in cid or ".." in cid:
        raise StreamError(f"invalid card id: {cid!r}")


def _refuse_if_locked(card: Card, verb: str) -> None:
    """The 24-hour rule, said kindly before the database's trigger says it
    bluntly. The trigger is what actually enforces it."""
    if journaldb.is_locked(card.saved_at or card.ts):
        raise StreamError(
            f"card {card.id} is locked — it was saved more than 24 hours ago"
            f" (locked at {journaldb.locks_at(card.saved_at or card.ts)}), so it can't be {verb}."
            " Add a note to it instead: record --note-on " + card.id)


# --------------------------------------------------------------------------------
# edit — replace a card's words, inside its 24 hours.
#
# The card keeps its own time — an edit never moves an entry. The change and
# its record land together in one transaction: the new text on the row, and a
# before/after row in card_edits. Saving identical text is not an edit and
# leaves no trace.
#
# The day the edit was MADE gets a marker too ("✎ edited an entry from …"), woven
# into that day's timeline like a finished to-do (see `edit_markers`), so a change
# shows up on the date it happened, not only on the entry it changed. Under the
# 24-hour rule that is only ever today or yesterday.
#
# Prompt: "any changes i want to be marked as edits on the date they were made" —
# both marked on the entry and recorded on the edit's own day, keeping the old text.
# --------------------------------------------------------------------------------

def edit_card(cid: str, body: str, by: str = "unknown", now: Optional[datetime] = None) -> Card:
    """Change a card's text. `now` pins the time recorded for the edit
    (tests); the lock itself always uses the real clock."""
    _check_cid_safe(cid)
    if not body.strip():
        raise StreamError("empty (or whitespace-only) body — card not edited")
    new_body = body.rstrip("\n")
    card = read_card(cid)
    if new_body == card.body:
        return card  # nothing changed — not an edit, nothing to record
    _refuse_if_locked(card, "edited")
    edited_at = (now or datetime.now()).strftime("%Y-%m-%d %H:%M:%S")
    try:
        with pool_lock():
            with _db() as conn:
                journaldb.begin_immediate(conn)
                try:
                    conn.execute(
                        "UPDATE cards SET body = ?, fingerprint = ? WHERE id = ? AND deleted_at IS NULL",
                        (new_body, journaldb.fingerprint(card.who, card.ts, new_body), cid))
                    journaldb.record_edit(conn, cid, edited_at, by, card.body, new_body)
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
            _sync_card_file(cid)
    except _DB_FAILURES as e:
        if _is_lock_refusal(e):
            raise StreamError(f"card {cid} is locked — it was saved more than 24 hours ago")
        raise StreamError(f"journal database unavailable: {e}")
    _append_compat_edit_log({"edited_at": edited_at, "by": by, "id": cid, "day": card.ts[:10],
                             "who": card.who, "before": card.body, "after": new_body})
    card = read_card(cid)
    _rerender_after_tag_change(card, card.tags)
    # The day the edit was made shows it too, when that's a different day.
    if edited_at[:10] != card.ts[:10]:
        render_day(edited_at[:10])
    return card


def load_edit_log() -> List[dict]:
    """Every edit, oldest first, in the shape the old edit log file had.
    MUST NEVER RAISE: no database means no edits to weave."""
    try:
        with _db() as conn:
            rows = conn.execute(
                "SELECT e.edited_at, e.by, e.card_id, c.day, c.who, e.before, e.after"
                " FROM card_edits e JOIN cards c ON c.id = e.card_id"
                " ORDER BY e.edited_at, e.id").fetchall()
    except Exception:
        return []
    return [{"edited_at": r[0], "by": r[1], "id": r[2], "day": r[3], "who": r[4],
             "before": r[5], "after": r[6]} for r in rows]


# --------------------------------------------------------------------------------
# delete — hide a card, inside its 24 hours.
#
# A delete sets `deleted_at` / `deleted_by` on the row and keeps everything
# else: the row is its own record of what went, when, and who asked. (Before
# the database, a delete wrote the whole card to a deletion log and then
# removed the file; that log was migrated into these columns.) After 24 hours
# the trigger refuses — the card stays, and a note can be added to it instead.
#
# render_day/render_month_index never touch a zero-card day/month (they return
# None instead), so a delete that empties one cleans up the now-stale view itself.
# --------------------------------------------------------------------------------

def delete_card(cid: str, by: str = "unknown") -> None:
    _check_cid_safe(cid)
    card = read_card(cid)
    _refuse_if_locked(card, "deleted")
    try:
        with pool_lock():
            with _db() as conn:
                journaldb.begin_immediate(conn)
                try:
                    conn.execute(
                        "UPDATE cards SET deleted_at = ?, deleted_by = ? WHERE id = ?"
                        " AND deleted_at IS NULL", (journaldb.now_text(), by, cid))
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
            _sync_card_file(cid)
    except _DB_FAILURES as e:
        if _is_lock_refusal(e):
            raise StreamError(f"card {cid} is locked — it was saved more than 24 hours ago")
        raise StreamError(f"journal database unavailable: {e}")

    day = card.ts[:10]
    if render_day(day) is None:
        stale_day = daily_dir() / f"{day}.md"
        if stale_day.exists():
            stale_day.unlink()

    month = card.ts[:7]
    if render_month_index(month) is None:
        stale_month = index_dir() / f"{month}.md"
        if stale_month.exists():
            stale_month.unlink()

    _render_manifests_for_tags(card.tags)


# --------------------------------------------------------------------------------
# import — bring a card that exists only as a file into the database, as it
# was: same id, time, words, tags (credited to `added_by`) and reply link.
# Used by the one-time migration (scripts/journal_db_migrate.py) and by
# cardstore.sync() while some callers still create files. Insert-only: a card
# already in the database is never changed by this.
# --------------------------------------------------------------------------------

def import_card(conn, card: Card, added_by: str = "migration",
                context: Optional["journaldb.LabelContext"] = None,
                deleted_at: Optional[str] = None, deleted_by: Optional[str] = None,
                links: bool = True) -> bool:
    """Insert one parsed card inside the caller's transaction. True if it
    was new. Pass links=False and call import_links afterwards when loading
    many cards, so a reply can point at a card loaded later."""
    if conn.execute("SELECT 1 FROM cards WHERE id = ?", (card.id,)).fetchone():
        return False
    context = context or _label_context()
    labels, door, device = _split_source_tags(list(card.tags), None, None)
    journaldb.insert_card(
        conn, id=card.id, who=card.who, said_at=card.ts, body=card.body.rstrip("\n"),
        kind=card.kind, refs=card.refs, door=door, device=device, session=card.session,
        # The lock runs from saved_at. When a file was written isn't known, so
        # an imported card is treated as saved when it was said: the old pool
        # locks on schedule instead of every card reopening for a day.
        saved_at=card.ts, deleted_at=deleted_at, deleted_by=deleted_by)
    for slug in dict.fromkeys(labels):
        journaldb.add_label(conn, card.id, slug, added_by, context, added_at=card.ts)
    if links:
        import_links(conn, card)
    return True


def import_links(conn, card: Card) -> None:
    """A file card's reply_to, as an `answers` link — when both ends exist."""
    if card.reply_to and conn.execute("SELECT 1 FROM cards WHERE id = ?", (card.reply_to,)).fetchone():
        journaldb.link(conn, card.id, card.reply_to, "answers", by="migration", linked_at=card.ts)


# --------------------------------------------------------------------------------
# Rendering helpers shared by day views and manifest views.
# --------------------------------------------------------------------------------

def _parse_ts(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")


def _valid_ts(ts: str) -> bool:
    try:
        _parse_ts(ts)
        return True
    except ValueError:
        return False


def _clock(dt: datetime) -> str:
    """'8:28 AM' — no zero-pad on the hour, matching keeper_capture.py's _clock."""
    try:
        return dt.strftime("%-I:%M %p")
    except ValueError:                           # platforms without the %-I extension
        return dt.strftime("%I:%M %p").lstrip("0")


def _italicize(body: str) -> str:
    """Wrap a (possibly multi-line) body in `*...*` — asterisk only on the outer
    edges, not repeated per line."""
    lines = body.split("\n")
    lines[0] = "*" + lines[0]
    lines[-1] = lines[-1] + "*"
    return "\n".join(lines)


def _short_id(card: Card) -> str:
    """The part of a card id after the day: `1010b` for `2026-10-04.1010b`.
    Under a day's heading the day is already known, so this is enough to name
    the card."""
    return card.id.split(".", 1)[-1]


def _render_card_block(card: Card, with_id: bool = False) -> str:
    """`\\nB: <body>\\n`, `\\nS: <body>\\n`, or `\\nK: *<body>*\\n` — multi-line
    bodies get the prefix (and, for K, the asterisks) only at the outer edges.
    S (the system) is plain like B, set apart by its own letter. With
    `with_id` the speaker letter is followed by the card's short id in
    brackets: `B [1010b]: <body>`."""
    lines = card.body.split("\n")
    label = f"{card.who} [{_short_id(card)}]" if with_id else card.who
    if card.who in ("B", "S"):
        lines[0] = f"{label}: " + lines[0]
    else:
        lines[0] = f"{label}: *" + lines[0]
        lines[-1] = lines[-1] + "*"
    return "\n" + "\n".join(lines) + "\n"


def _render_ref_block(card: Card) -> str:
    """`\\n> ⤷ ref — <first line of body> · [[target]] [[target]]\\n` — a keeper
    annotation pointing at past events, rendered as a blockquote so it reads as
    a distinct aside rather than another line of dialogue."""
    first_line = card.body.split("\n", 1)[0]
    text = f"\n> ⤷ ref — {first_line}"
    if card.refs:
        text += " · " + " ".join(f"[[{r}]]" for r in card.refs)
    return text + "\n"


# --------------------------------------------------------------------------------
# To-do completion markers. Day views weave in "marked to-do complete" lines
# computed live from the to-dos data, so the Keeper (which only reads rendered
# markdown) can see cleared to-dos without a card ever being minted for them.
# The marker rule below mirrors routes/todos.py's `cleared_todos` (the web view's
# equivalent) exactly — do not improvise it independently of that route.
# --------------------------------------------------------------------------------

@dataclass
class TodoMarker:
    text: str
    day: str                       # 'YYYY-MM-DD' the marker belongs to
    time: Optional[str] = None     # 'HH:MM', or None for an untimed (tail) marker
    note: Optional[str] = None     # finished_note, if any


def _load_todos_data() -> dict:
    """Read the to-dos collection: `EXOCORTEX_DATA_DIR/todos.json`, falling back to
    `stream_root().parent / "data" / "todos.json"` (stream_root() is the tulku
    content dir inside the vault; `data/` is its sibling — same layout store.py
    resolves DATA_DIR/CONTENT_DIR from).

    MUST NEVER RAISE. A missing file, unreadable/corrupt JSON, or a top-level
    shape that isn't an object all just mean "no completions to weave" — return
    {} rather than propagate. render_day_text's determinism (same pool in, same
    bytes out) is for the CARD pool; todos.json is read live and is explicitly
    allowed to be absent (a stripped skeleton checkout, a test env with no data
    dir configured, or the vault simply predating this feature)."""
    env = os.environ.get("EXOCORTEX_DATA_DIR")
    if env:
        path = Path(env) / "todos.json"
    else:
        try:
            path = stream_root().parent / "data" / "todos.json"
        except StreamError:
            return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _marker_for_item(item: dict) -> Optional[TodoMarker]:
    """The completion marker for one done to-do item, or None if it doesn't carry
    enough to place one. Identical precedence to the web view's marker rule:

        finished_on + finished_time  -> that day, that time (an edited claim)
        finished_on alone            -> that day, no time (claim overrides the tap)
        done_at, minute-precision    -> done_at's day + time
        done_at, date-only (legacy)  -> that day, no time
        none of the above            -> no marker
    """
    text = item.get("text")
    if not isinstance(text, str) or not text:
        return None
    note = item.get("finished_note")
    note = note if isinstance(note, str) and note else None

    finished_on = item.get("finished_on")
    if isinstance(finished_on, str) and finished_on:
        finished_time = item.get("finished_time")
        time = finished_time if isinstance(finished_time, str) and finished_time else None
        return TodoMarker(text=text, day=finished_on, time=time, note=note)

    done_at = item.get("done_at")
    if isinstance(done_at, str) and done_at:
        if len(done_at) > 10:
            return TodoMarker(text=text, day=done_at[:10], time=done_at[11:16], note=note)
        return TodoMarker(text=text, day=done_at[:10], time=None, note=note)

    return None


def todo_completion_markers(day: str) -> List[TodoMarker]:
    """Every marker (timed or untimed) landing on `day`, in the to-dos file's own
    bucket/item order — deterministic given the current todos.json, never raises
    (see `_load_todos_data`). Because this is computed live rather than sourced
    from the card pool, a day already rendered can drift from a to-do completed
    (or re-dated) afterward; `validate`'s drift check will flag it until the next
    render — accepted, same as any derived view, and routes/todos.py fires a
    re-render on every write that changes completion facts, which heals it."""
    markers: List[TodoMarker] = []
    data = _load_todos_data()
    for bucket in data.values():
        if not isinstance(bucket, dict):
            continue
        items = bucket.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or not item.get("done"):
                continue
            marker = _marker_for_item(item)
            if marker is not None and marker.day == day:
                markers.append(marker)
    return markers


def _marker_datetime(marker: TodoMarker) -> Optional[datetime]:
    """`marker`'s moment as a timeline timestamp (seconds forced to :00), or None
    if `time` is malformed — never raises, just drops the marker from the weave."""
    if not marker.time:
        return None
    try:
        return datetime.strptime(f"{marker.day} {marker.time}", "%Y-%m-%d %H:%M")
    except ValueError:
        return None


def _marker_line(marker: TodoMarker, clock: Optional[str]) -> str:
    """`✓ marked to-do complete: <text>[ — <clock>][ — "<note>"]` — clock is
    included for a timed (weaved) marker, omitted for an untimed tail line."""
    line = f"✓ marked to-do complete: {marker.text}"
    if clock:
        line += f" — {clock}"
    if marker.note:
        line += f" — “{marker.note}”"
    return line


def _render_marker_block(marker: TodoMarker, ts_dt: datetime) -> str:
    """`\\n✓ marked to-do complete: ...\\n` — same outer-blank-line shape as
    `_render_card_block`/`_render_ref_block` so it weaves into the timeline
    without disturbing the gap-header spacing."""
    return "\n" + _marker_line(marker, _clock(ts_dt)) + "\n"


# --------------------------------------------------------------------------------
# Day-counter retirement markers. Same live-weave model as the to-do markers
# above: routes/streaks.py stamps retired_on/retired_time/retired_note on a
# counter and fires a re-render of that day; nothing is ever copied into the
# pool. The marker rule mirrors that route's fields exactly.
# --------------------------------------------------------------------------------

@dataclass
class StreakMarker:
    label: str
    days: int                      # the frozen final count (retired_on - since)
    day: str                       # retired_on, 'YYYY-MM-DD'
    time: Optional[str] = None     # retired_time 'HH:MM', or None (tail marker)
    note: Optional[str] = None     # retired_note, if any


def _load_streaks_data() -> dict:
    """Read the day-counters collection (`EXOCORTEX_DATA_DIR/streaks.json`,
    same fallback layout as `_load_todos_data`). MUST NEVER RAISE — a missing
    or unreadable file just means no retirements to weave."""
    env = os.environ.get("EXOCORTEX_DATA_DIR")
    if env:
        path = Path(env) / "streaks.json"
    else:
        try:
            path = stream_root().parent / "data" / "streaks.json"
        except StreamError:
            return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def streak_retirement_markers(day: str) -> List[StreakMarker]:
    """Every retired-counter marker landing on `day`, in file order. The final
    count is frozen at retired_on - since; an entry with unparseable dates
    still gets a marker (days -1 suppressed to 0) rather than vanishing."""
    markers: List[StreakMarker] = []
    for s in _load_streaks_data().get("streaks", []):
        if not isinstance(s, dict) or s.get("status") != "retired":
            continue
        label = s.get("label")
        retired_on = s.get("retired_on")
        if not (isinstance(label, str) and label and isinstance(retired_on, str)
                and retired_on == day):
            continue
        try:
            days = (datetime.strptime(retired_on, "%Y-%m-%d")
                    - datetime.strptime(str(s.get("since", "")), "%Y-%m-%d")).days
        except ValueError:
            days = 0
        time = s.get("retired_time")
        time = time if isinstance(time, str) and time else None
        note = s.get("retired_note")
        note = note if isinstance(note, str) and note else None
        markers.append(StreakMarker(label=label, days=max(days, 0), day=day,
                                    time=time, note=note))
    return markers


def _streak_marker_datetime(marker: StreakMarker) -> Optional[datetime]:
    if not marker.time:
        return None
    try:
        return datetime.strptime(f"{marker.day} {marker.time}", "%Y-%m-%d %H:%M")
    except ValueError:
        return None


def _streak_marker_line(marker: StreakMarker, clock: Optional[str]) -> str:
    """`⏹ retired day count: <label> — Day <N>[ — <clock>][ — "<note>"]` —
    the day-counter sibling of `_marker_line`."""
    line = f"⏹ retired day count: {marker.label} — Day {marker.days}"
    if clock:
        line += f" — {clock}"
    if marker.note:
        line += f" — “{marker.note}”"
    return line


def _render_streak_marker_block(marker: StreakMarker, ts_dt: datetime) -> str:
    return "\n" + _streak_marker_line(marker, _clock(ts_dt)) + "\n"


# --------------------------------------------------------------------------------
# Edit markers — "✎ edited an entry from <day>" on the day an edit was MADE. Same
# live-weave model as the to-do and counter markers above: read from the edit log
# at render time, never copied into the pool. An edit to a card from the same day
# gets no marker (the card itself already says "edited", right there), and several
# edits to one card on one day show once, at the last of them.
# --------------------------------------------------------------------------------

@dataclass
class EditMarker:
    card_id: str
    card_day: str                  # the edited card's own day
    edited_at: str                 # 'YYYY-MM-DD HH:MM:SS', the last edit that day
    snippet: str                   # the start of the card's new text


def _snippet(text: str, words: int = 12) -> str:
    parts = text.split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def edit_markers(day: str) -> List[EditMarker]:
    """Every edit made on `day` to a card from another day, one per card, in
    the order they were made."""
    latest: Dict[str, dict] = {}
    for entry in load_edit_log():
        if entry["edited_at"][:10] != day or entry.get("day") == day:
            continue
        latest.pop(entry["id"], None)  # re-insert, so order follows the last edit
        latest[entry["id"]] = entry
    return [
        EditMarker(card_id=e["id"], card_day=str(e.get("day") or e["id"][:10]),
                   edited_at=e["edited_at"], snippet=_snippet(str(e.get("after") or "")))
        for e in latest.values()
    ]


def _edit_marker_line(marker: EditMarker, clock: Optional[str]) -> str:
    """`✎ edited an entry from <day>: “<snippet>” — <clock>` — the edit sibling
    of `_marker_line`."""
    line = f"✎ edited an entry from {marker.card_day}: “{marker.snippet}”"
    if clock:
        line += f" — {clock}"
    return line


def _render_edit_marker_block(marker: EditMarker, ts_dt: datetime) -> str:
    return "\n" + _edit_marker_line(marker, _clock(ts_dt)) + "\n"


# --------------------------------------------------------------------------------
# Day view
# --------------------------------------------------------------------------------

def render_day_text(day: str, cards: Optional[List[Card]] = None,
                    with_ids: bool = False) -> Optional[str]:
    """The rendered `Journal/Daily/<day>.md` body, or None if no card exists for
    that day (a day with zero cards is never touched — see `render_day`). This
    holds even when to-do completion markers land on that day: markers alone
    never create a day file, they only ever weave into a day a card already
    lives on.

    To-do completion markers (see `todo_completion_markers`) are merged in
    two ways: a TIMED marker (finished_on+finished_time, or a minute-precision
    done_at) becomes another event in the chronological walk alongside the
    cards, sharing the same gap-header logic — on a tie (marker and card at
    the exact same minute) the marker renders first. An UNTIMED marker (a
    day-only finished_on claim, or a legacy date-only done_at) can't be placed
    on the timeline at all, so it renders in a tail block after the timeline,
    one line per marker, under a single blank line.

    `with_ids` puts each card's short id beside its speaker letter
    (`B [1010b]: …`). The day files never use it; the Keeper's boot package
    does (scripts/boot_context.py), so every line it loads can be named.
    """
    all_cards = load_day_cards(day) if cards is None else cards
    day_cards = [c for c in all_cards if c.ts.startswith(day)]
    if not day_cards:
        return None

    context_cards = sorted((c for c in day_cards if c.kind == "context"), key=lambda c: (c.ts, c.id))
    # line + ref cards share one chronological timeline — a ref annotation renders
    # in place, at the moment it was authored, just with its own distinct block.
    timeline_cards = sorted(
        (c for c in day_cards if c.kind in ("line", "ref")), key=lambda c: (c.ts, c.id)
    )

    markers = todo_completion_markers(day)
    timed_markers = [m for m in markers if m.time]
    untimed_markers = [m for m in markers if not m.time]
    streak_markers = streak_retirement_markers(day)
    timed_streaks = [m for m in streak_markers if m.time]
    untimed_streaks = [m for m in streak_markers if not m.time]
    edits = edit_markers(day)

    text = f"# {day}\n\n`{day_legend()}`\n\n"
    if context_cards:
        text += context_cards[0].body + "\n\n"
    text += "---\n"

    # One chronological walk over cards + timed markers. rank 0 (marker) sorts
    # before rank 1 (card) on a tie so a marker at the same minute as a card
    # renders first, matching the web weave; a per-kind secondary key
    # (card id / marker index) keeps the ordering deterministic beyond that.
    events: List[Tuple[datetime, int, str, object]] = []
    for c in timeline_cards:
        events.append((_parse_ts(c.ts), 1, c.id, c))
    for i, m in enumerate(timed_markers):
        ts_dt = _marker_datetime(m)
        if ts_dt is not None:
            events.append((ts_dt, 0, f"{i:04d}", m))
    # Streak markers share the todo markers' rank (before cards on a same-
    # minute tie); the "s" key prefix sorts them after todo markers there.
    for i, m in enumerate(timed_streaks):
        ts_dt = _streak_marker_datetime(m)
        if ts_dt is not None:
            events.append((ts_dt, 0, f"s{i:04d}", m))
    # Edit markers always carry a full timestamp; "e" sorts them after the
    # other markers on a same-minute tie.
    for i, m in enumerate(edits):
        if _valid_ts(m.edited_at):
            events.append((_parse_ts(m.edited_at), 0, f"e{i:04d}", m))
    events.sort(key=lambda e: (e[0], e[1], e[2]))

    prev_ts: Optional[datetime] = None
    for ts_dt, _rank, _key, payload in events:
        if prev_ts is None or (ts_dt - prev_ts).total_seconds() > GAP_SECONDS:
            text += f"\n*[{_clock(ts_dt)}]*\n"
        if isinstance(payload, Card):
            text += (_render_ref_block(payload) if payload.kind == "ref"
                     else _render_card_block(payload, with_ids))
        elif isinstance(payload, StreakMarker):
            text += _render_streak_marker_block(payload, ts_dt)
        elif isinstance(payload, EditMarker):
            text += _render_edit_marker_block(payload, ts_dt)
        else:
            text += _render_marker_block(payload, ts_dt)
        prev_ts = ts_dt

    if untimed_markers or untimed_streaks:
        text += "\n"
        for m in untimed_markers:
            text += _marker_line(m, clock=None) + "\n"
        for m in untimed_streaks:
            text += _streak_marker_line(m, clock=None) + "\n"

    return text


def _write_view(path: Path, text: str) -> Path:
    """Atomic write for derived views (temp + os.replace). A view is disposable,
    but the keeper and the app read these files live — a reader should see the
    old render or the new one, never a torn one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path


def render_day(day: str) -> Optional[Path]:
    text = render_day_text(day)
    if text is None:
        return None
    return _write_view(daily_dir() / f"{day}.md", text)


# --------------------------------------------------------------------------------
# Manifest view
# --------------------------------------------------------------------------------

def render_manifest_text(manifest: Manifest, cards: Optional[List[Card]] = None) -> str:
    selected = cards_for_manifest(manifest) if cards is None else cards
    text = f"# {manifest.name}\n\n*(derived — do not hand-edit; rendered from the card pool)*\n"
    if not selected:
        return text
    blocks = []
    for c in selected:
        ts_dt = _parse_ts(c.ts)
        stamp = f"{ts_dt.strftime('%Y-%m-%d')} {_clock(ts_dt)}"
        body = _italicize(c.body) if c.who == "K" else c.body
        blocks.append(f"#### [[{c.id}]] — {stamp}\n\n{body}")
    return text + "\n" + "\n\n".join(blocks) + "\n"


def render_manifest(name: str) -> Path:
    manifest = load_manifest(name)
    text = render_manifest_text(manifest)
    return _write_view(stream_root() / manifest.out, text)


# --------------------------------------------------------------------------------
# Month index
# --------------------------------------------------------------------------------

def render_index_text(month: str, cards: List[Card]) -> str:
    lines = [f"# {month}", ""]
    for c in cards:
        snippet = " ".join(c.body.split())[:80]
        lines.append(f"- [[{c.id}]] {c.who} [{', '.join(c.tags)}] — {snippet}…")
    return "\n".join(lines) + "\n"


def render_month_index(month: str) -> Optional[Path]:
    month_cards = sorted(
        (c for c in load_month_cards(month) if c.ts.startswith(month)),
        key=lambda c: (c.ts, c.id),
    )
    if not month_cards:
        return None
    return _write_view(index_dir() / f"{month}.md", render_index_text(month, month_cards))


# --------------------------------------------------------------------------------
# render --all
# --------------------------------------------------------------------------------

def render_all() -> None:
    cards = load_all_cards()
    for day in sorted({c.ts[:10] for c in cards if _valid_ts(c.ts)}):
        render_day(day)
    for month in sorted({c.ts[:7] for c in cards if _valid_ts(c.ts)}):
        render_month_index(month)
    for name in manifest_names():
        render_manifest(name)


# --------------------------------------------------------------------------------
# validate — structural integrity + drift, over the whole pool.
# --------------------------------------------------------------------------------

def _check_cycles(cards: Dict[str, Card]) -> Tuple[bool, List[str]]:
    messages: List[str] = []
    ok = True
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {cid: WHITE for cid in cards}

    def visit(cid: str, path_stack: List[str]) -> None:
        nonlocal ok
        if color[cid] == BLACK:
            return
        if color[cid] == GRAY:
            messages.append(f"CYCLE {' -> '.join(path_stack + [cid])}")
            ok = False
            return
        color[cid] = GRAY
        nxt = cards[cid].reply_to
        if nxt in cards:
            visit(nxt, path_stack + [cid])
        color[cid] = BLACK

    for cid in sorted(cards):
        if color[cid] == WHITE:
            visit(cid, [])
    return ok, messages


def _check_drift(cards: Dict[str, Card]) -> List[str]:
    messages: List[str] = []
    values = list(cards.values())

    for day in sorted({c.ts[:10] for c in values if _valid_ts(c.ts)}):
        expected = render_day_text(day, cards=values)
        path = daily_dir() / f"{day}.md"
        actual = path.read_text(encoding="utf-8") if path.exists() else None
        if expected != actual:
            messages.append(f"DRIFT {path}")

    for month in sorted({c.ts[:7] for c in values if _valid_ts(c.ts)}):
        month_cards = sorted((c for c in values if c.ts.startswith(month)), key=lambda c: (c.ts, c.id))
        expected = render_index_text(month, month_cards)
        path = index_dir() / f"{month}.md"
        actual = path.read_text(encoding="utf-8") if path.exists() else None
        if expected != actual:
            messages.append(f"DRIFT {path}")

    for name in manifest_names():
        try:
            manifest = load_manifest(name)
        except StreamError:
            continue          # already reported as an invalid manifest above
        selected = cards_for_manifest(manifest, cards=values)
        expected = render_manifest_text(manifest, cards=selected)
        out_path = stream_root() / manifest.out
        actual = out_path.read_text(encoding="utf-8") if out_path.exists() else None
        if expected != actual:
            messages.append(f"DRIFT {out_path}")

    return messages


def validate() -> Tuple[bool, List[str]]:
    """Integrity of the card rows, then drift of every derived file.

    For every live and deleted row: the fingerprint still matches its
    speaker, time and words (a mismatch means the row was rewritten around the
    triggers), and its id, time, speaker and kind are well-formed. Then: every
    `answers` link resolves, the answer chains have no cycles, every manifest
    parses, nothing is waiting in the holding file, and every derived view
    matches a fresh render."""
    messages: List[str] = []
    ok = True
    try:
        with _db() as conn:
            rows = conn.execute(
                "SELECT id, who, said_at, day, kind, body, fingerprint FROM cards ORDER BY id").fetchall()
            dangling = conn.execute(
                "SELECT l.from_card, l.to_card FROM card_links l"
                " LEFT JOIN cards c ON c.id = l.to_card WHERE c.id IS NULL").fetchall()
    except _DB_FAILURES as e:
        return False, [f"INVALID database: {e}"]

    for cid, who, said_at, day, kind, body, stored in rows:
        if stored != journaldb.fingerprint(who, said_at, body):
            messages.append(f"INVALID {cid}: fingerprint does not match its words — rewritten outside the engine?")
            ok = False
        if not _valid_ts(said_at or ""):
            messages.append(f"INVALID {cid}: bad said_at {said_at!r}")
            ok = False
        elif day != said_at[:10]:
            messages.append(f"INVALID {cid}: day {day!r} is not said_at's day")
            ok = False
        if who not in VALID_WHO:
            messages.append(f"INVALID {cid}: bad who {who!r}")
            ok = False
        if kind not in VALID_KIND:
            messages.append(f"INVALID {cid}: bad kind {kind!r}")
            ok = False
    for from_card, to_card in dangling:
        messages.append(f"INVALID {from_card}: links to {to_card!r}, which does not exist")
        ok = False

    cards = {c.id: c for c in load_all_cards()}
    cycles_ok, cycle_messages = _check_cycles(cards)
    ok = ok and cycles_ok
    messages.extend(cycle_messages)

    for name in manifest_names():
        try:
            load_manifest(name)
        except StreamError as e:
            messages.append(f"INVALID manifest {name}: {e}")
            ok = False

    held = held_cards()
    if held:
        messages.append(f"HELD {len(held)} card(s) waiting in {holding_path()} — run `stream.py drain`")
        ok = False

    drift_messages = _check_drift(cards)
    if drift_messages:
        ok = False
    messages.extend(drift_messages)

    return ok, messages


# --------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------

# Where a card's body comes from. `--body-file` exists for gated sessions: the
# act-vs-ask gate (tools/act_ask_gate.py) refuses any Bash line carrying a pipe,
# a redirect, a backtick, `$(` or a literal newline, and a keeper's context
# paragraph nearly always contains one of those — so `echo "<body>" | stream.py
# record` could never mint it. With the body in a file (written by the ungated
# Write tool) the whole call is one bare command and passes. Absent the flag,
# stdin still works exactly as before.
# Prompt: "give record a --body-file flag so a card can be minted as one bare
# command with no shell metacharacters."
def _read_body(args: argparse.Namespace) -> str:
    path = getattr(args, "body_file", None)
    if path:
        return Path(path).read_text(encoding="utf-8")
    return sys.stdin.read()


def _cmd_record(args: argparse.Namespace) -> int:
    try:
        raw = _read_body(args)
    except OSError as e:
        print(f"error: --body-file: {e}", file=sys.stderr)
        return 1
    tags = [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else []
    refs = [t.strip() for t in args.refs.split(",") if t.strip()] if args.refs else []
    ts_dt = None
    if args.ts:
        try:
            ts_dt = datetime.strptime(args.ts, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            print(f"error: --ts must be 'YYYY-MM-DD HH:MM:SS', got {args.ts!r}", file=sys.stderr)
            return 1
    try:
        cid = record(
            who=args.who,
            body=raw,
            reply_to=args.reply_to,
            tags=tags,
            ts=ts_dt,
            kind=args.kind,
            refs=refs,
            session=args.session,
            door=args.door or os.environ.get("STREAM_DOOR") or "cli",
            device=args.device,
            by=args.by,
            note_on=args.note_on,
        )
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(cid)
    return 0


def _cmd_render(args: argparse.Namespace) -> int:
    if args.all:
        render_all()
        return 0
    if args.day:
        render_day(args.day)
        return 0
    if args.view:
        try:
            render_manifest(args.view)
        except StreamError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        return 0
    print("error: render needs one of --day, --view, or --all", file=sys.stderr)
    return 1


def _label_by(args: argparse.Namespace) -> str:
    """Who is changing labels. Explicit --by wins; STREAM_TAG_BY lets a calling
    process name itself once; "cli" means a person at a prompt. The journal
    page passes --by owner — the owner's hand outranks every agent's."""
    return args.by or os.environ.get("STREAM_TAG_BY") or "cli"


def _report_outcomes(card: Card) -> None:
    """Tell the caller about any tag that didn't change as asked."""
    for tag, outcome in card.outcomes.items():
        if outcome == "refused":
            print(f"refused: {tag} on {card.id} — the owner's own label choice stands",
                  file=sys.stderr)


def _cmd_tag(args: argparse.Namespace) -> int:
    try:
        card = add_tags(args.id, args.tags, by=_label_by(args), run=args.run,
                        reason=args.reason, weight=args.weight)
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    _report_outcomes(card)
    return 0


def _cmd_untag(args: argparse.Namespace) -> int:
    try:
        card = remove_tags(args.id, args.tags, by=_label_by(args), reason=args.reason)
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    _report_outcomes(card)
    return 0


def _cmd_link(args: argparse.Namespace) -> int:
    try:
        made = link_cards(args.from_card, args.to_card, args.kind, by=args.by)
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"{'linked' if made else 'already linked'} {args.from_card} -{args.kind}-> {args.to_card}")
    return 0


def _cmd_drain(args: argparse.Namespace) -> int:
    landed = drain_holding()
    waiting = len(held_cards())
    print(f"drained {landed} card(s); {waiting} still waiting")
    return 0 if waiting == 0 else 1


def _cmd_edit(args: argparse.Namespace) -> int:
    try:
        raw = _read_body(args)
    except OSError as e:
        print(f"error: --body-file: {e}", file=sys.stderr)
        return 1
    # Who asked, recorded in card_edits. Same resolution as delete's --by.
    by = args.by or os.environ.get("STREAM_EDIT_BY") or "cli"
    try:
        card = edit_card(args.id, raw, by=by)
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(card.id)
    return 0


def _cmd_delete(args: argparse.Namespace) -> int:
    # Who asked. Explicit --by wins; STREAM_DELETE_BY lets a calling process (the
    # cards route, a cricket) name itself once in its environment instead of
    # threading a flag through every shell-out. "cli" means a person at a prompt.
    by = args.by or os.environ.get("STREAM_DELETE_BY") or "cli"
    try:
        delete_card(args.id, by=by)
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"deleted {args.id}")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    ok, messages = validate()
    for m in messages:
        print(m)
    try:
        total = len(load_all_cards())
    except _DB_FAILURES:
        total = 0
    print(f"{'OK' if ok else 'FAIL'} — {total} card(s), {len(messages)} issue(s)")
    return 0 if ok else 1


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="stream.py",
        description="Deterministic spine of the journal's cards (see the module docstring).",
    )
    sub = p.add_subparsers(dest="verb", required=True)

    rec = sub.add_parser("record", help="mint a card from --body-file or stdin, re-render its day + month")
    rec.add_argument("--who", required=True, help="B (owner), K (keeper) or S (system)")
    rec.add_argument(
        "--body-file", default=None,
        help="read the card body from this file instead of stdin (lets a gated "
             "session mint a card as one bare command, no pipe)")
    rec.add_argument("--reply-to", default=None, help="id of the card this one answers (an `answers` link)")
    rec.add_argument("--note-on", default=None,
                     help="id of an older card this one is a later note on (a `note` link)")
    rec.add_argument("--door", default=None,
                     help="how it came in: web, hook, reconciler, voice, keeper, ... (default: "
                          "$STREAM_DOOR, else cli)")
    rec.add_argument("--device", default=None, help="which machine heard it (voice)")
    rec.add_argument("--by", default=None,
                     help="who the card's --tags are credited to (default: capture)")
    rec.add_argument("--tags", default=None, help="comma-separated tags, e.g. a,b,c")
    rec.add_argument("--ts", default=None, help="'YYYY-MM-DD HH:MM:SS' (default: now)")
    rec.add_argument("--kind", default="line", choices=VALID_KIND)
    rec.add_argument(
        "--session", default=None,
        help="observatory conversation id this card was pulled out of (provenance)")
    rec.add_argument(
        "--refs", default=None,
        help="comma-separated reference targets (only meaningful for --kind ref), "
             "e.g. 2026-05-14,people/fern.md",
    )
    rec.set_defaults(func=_cmd_record)

    ren = sub.add_parser("render", help="rebuild derived views from the cards")
    ren.add_argument("--day", default=None, help="YYYY-MM-DD — rebuild one day's view")
    ren.add_argument("--view", default=None, help="rebuild one manifest's view")
    ren.add_argument("--all", action="store_true", help="rebuild every day, manifest, and month index")
    ren.set_defaults(func=_cmd_render)

    tagp = sub.add_parser("tag", help="put labels on a card")
    tagp.add_argument("id")
    tagp.add_argument("tags", nargs="+")
    tagp.add_argument("--by", help="who is adding them: owner, keeper, thread-tending, ... "
                                   "(default: $STREAM_TAG_BY, else cli)")
    tagp.add_argument("--run", help="which nightly run, so one night can be undone at once")
    tagp.add_argument("--reason", help="one sentence: why this label belongs")
    tagp.add_argument("--weight", choices=("about", "touches"),
                      help="about = mainly this; touches = it comes up")
    tagp.set_defaults(func=_cmd_tag)

    untagp = sub.add_parser("untag", help="take labels off a card (the row is marked, not deleted)")
    untagp.add_argument("id")
    untagp.add_argument("tags", nargs="+")
    untagp.add_argument("--by", help="who is removing them (default: $STREAM_TAG_BY, else cli)")
    untagp.add_argument("--reason", help="one sentence: why it doesn't belong")
    untagp.set_defaults(func=_cmd_untag)

    linkp = sub.add_parser("link", help="link a newer card to an older one")
    linkp.add_argument("from_card", help="the newer card")
    linkp.add_argument("to_card", help="the card it points at")
    linkp.add_argument("--kind", required=True, choices=LINK_KINDS,
                       help="note = a later note on it; answers = a reply to it")
    linkp.add_argument("--by", help="who linked them")
    linkp.set_defaults(func=_cmd_link)

    drainp = sub.add_parser("drain", help="move cards waiting in the holding file into the database")
    drainp.set_defaults(func=_cmd_drain)

    editp = sub.add_parser("edit", help="replace a card's words (within 24 hours of saving) from --body-file or stdin")
    editp.add_argument("id")
    editp.add_argument("--body-file", default=None, help="read the new body from this file instead of stdin")
    editp.add_argument("--by", help="who is asking (recorded in the edit log)")
    editp.set_defaults(func=_cmd_edit)

    delp = sub.add_parser("delete", help="hide a card (within 24 hours of saving); the row is kept")
    delp.add_argument("id")
    delp.add_argument("--by", help="who is asking (recorded on the row)")
    delp.set_defaults(func=_cmd_delete)

    val = sub.add_parser("validate", help="check the rows' integrity and drift against derived files")
    val.set_defaults(func=_cmd_validate)

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
