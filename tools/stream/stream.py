#!/usr/bin/env python3
"""
Lives in the skeleton (shareable engine); the vault keeps exec-shims at
tulku/_system/ for existing callers.

stream.py — the deterministic spine of the journal's stream-cards architecture.

See STREAM.md (same directory) for the full writeup; this is the summary needed to
read the code.

THE MODEL. The journal used to be one prose markdown file per day. It is now an
append-only POOL of atomic CARDS — one file per utterance, `_system/data/cards/<id>.md`
— plus everything a human actually reads is a disposable derived VIEW, rendered from
the pool by this module:

    _system/data/cards/<id>.md       POOL   one file per utterance. append-only. truth.
    _system/data/manifests/<name>.md MANIFEST  a selection rule (tag=X) + an output path.
    _system/data/index/YYYY-MM.md    INDEX  one line per card that month. derived.
    Journal/Daily/YYYY-MM-DD.md      VIEW   the day, rendered exactly as it always
                                            looked. derived, disposable.
    <manifest out path>              VIEW   e.g. people/views/sage.md — every card
                                            tagged `sage`, inlined verbatim. derived.

Only cards are truth. Views can be deleted and rebuilt at any time — never hand-edit
one; edit (or mint) a card and re-render. `validate` catches a view that drifted.

FISH LINEAGE. This ports Ian Fish's exo "stream-cards" vault: pool/manifest/view
split, capture-at-source, a deterministic stdlib-only spine, derived-never-stored
membership. Same grounding as event-sourced systems generally — log as source of
truth, materialized views over it (Kleppmann, DDIA ch. 11-12).

THE LEGIBLE-ID DIVERGENCE. Fish's card ids are content hashes (`sha256(body, parent)`,
his `enc:v2` Merkle-DAG) — that scheme solves *his* problem: multiple people appending
to a shared pool from multiple devices over dumb folder sync, no server, no git.
Content-addressing makes distributed writes merge as set union and dedups by
construction, at the price of opaque hex ids and cards that can never be edited (an
edit changes the id, cascading to every descendant).

This vault is one writer, one machine, committed to git hourly — git is already a
Merkle-DAG doing that job, and hex ids carry zero information to a reader scanning an
index. So ids here are time-based and self-describing instead:

    YYYY-MM-DD.HHMM + speaker letter (+ a counter if the same speaker mints twice in
    the same minute): 2026-07-06.0843b, then 2026-07-06.0843b2, ...b3.

A link tells you when it was and who spoke before you read a byte. Cards are editable
when there's a real reason (a screenshot transcription filled into a captured line) —
git records the edit; `validate` cannot detect it (a known, accepted edge — see
STREAM.md section 5).

One addition beyond fish: tags, not reply-subtrees, are the collection primitive here
— a person or a worry threads through months of unrelated conversation rather than
living under one root card.

THE VERBS. `record` (the primitive: body from `--body-file PATH` or stdin, plus flags
-> mint a card, re-render its day + month, echo the id), `render` (rebuild `--day`, `--view NAME`, or `--all` from
the pool), `tag` / `untag` (edit a card's tags, re-render what depends on them),
`edit` (replace a card's body from `--body-file` or stdin, re-render its day + month +
any manifest selecting its tags — echoes the id), `delete` (write the card to the append-only
deletion log, THEN remove it from the pool, re-render what's left — and clean up a
day/month view that just lost its last card, since render never touches a zero-card
day/month on its own), `validate` (structural checks on the whole pool + a drift
check against every derived file).

Stdlib only. No network. No randomness. Same pool in, same bytes out, always.
"""
import argparse
import fcntl
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# A new timestamp marker in a day view is emitted only when this much wall-clock time
# has passed since the previous line card — mirrors keeper_capture.py's GAP_SECONDS.
GAP_SECONDS = 10 * 60

VALID_WHO = ("B", "K")
VALID_KIND = ("line", "context", "ref")


class StreamError(Exception):
    """A caller-facing problem (bad input, missing card, malformed pool file) — the
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
    """Append-only record of every card the `delete` verb has removed. Beside the
    pool, never inside it — same rule the pool lock follows, so `load_all_cards()`'s
    *.md glob can't ever pick it up."""
    return pool_dir().parent / "deleted_cards.jsonl"


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
# Card: frontmatter + verbatim body. Hand-rolled parser/serializer for exactly the
# five fields below — no yaml import, the format is small and fixed.
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
    body: str = ""


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
    return Card(
        id=fields_["id"],
        who=fields_["who"],
        ts=fields_["ts"],
        reply_to=reply_to,
        tags=_parse_tags(fields_["tags"]),
        kind=fields_["kind"],
        refs=refs,
        session=None if session in ("null", "") else session,
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
        "---",
    ])
    # Exactly one trailing newline, regardless of how many the body carries.
    return header + "\n" + card.body.rstrip("\n") + "\n"


@contextmanager
def pool_lock():
    """Serialize pool writers across processes (server mint, hook mint, reconciler,
    cricket tagging). flock on a sidecar beside the pool — never inside it, so
    load_all_cards()'s *.md glob can't pick it up. Held only around read/mint/write
    critical sections; renders are deterministic from the pool and stay outside."""
    d = pool_dir()
    d.mkdir(parents=True, exist_ok=True)
    with open(d.parent / "pool.lock", "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        yield


def write_card(card: Card) -> Path:
    """Write a card ATOMICALLY: temp file in the pool dir, fsync, os.replace().
    A reader (or the hourly git commit) sees either the whole card or no card —
    never a torn one. Same discipline as store.write_file()."""
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


def read_card(cid: str) -> Card:
    path = card_path(cid)
    if not path.exists():
        raise StreamError(f"no such card: {cid}")
    return parse_card_file(path)


def card_exists(cid: str) -> bool:
    return card_path(cid).exists()


def load_all_cards() -> List[Card]:
    d = pool_dir()
    if not d.exists():
        return []
    return [parse_card_file(p) for p in d.glob("*.md")]


# --------------------------------------------------------------------------------
# Manifest: a selection rule + an output path. Same frontmatter mechanics as a card,
# different fields (select / render / out), no body.
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
    cards = load_all_cards() if cards is None else cards
    if manifest.select_key != "tag":
        return []
    return sorted(
        (c for c in cards if manifest.select_value in c.tags),
        key=lambda c: (c.ts, c.id),
    )


# --------------------------------------------------------------------------------
# Id minting
# --------------------------------------------------------------------------------

def mint_id(ts: datetime, who: str) -> str:
    base = f"{ts.strftime('%Y-%m-%d.%H%M')}{who.lower()}"
    if not card_path(base).exists():
        return base
    counter = 2
    while card_path(f"{base}{counter}").exists():
        counter += 1
    return f"{base}{counter}"


# --------------------------------------------------------------------------------
# record — the primitive every card is born through.
# --------------------------------------------------------------------------------

def record(
    who: str,
    body: str,
    reply_to: Optional[str] = None,
    tags: Optional[List[str]] = None,
    ts: Optional[datetime] = None,
    kind: str = "line",
    refs: Optional[List[str]] = None,
    session: Optional[str] = None,
) -> str:
    who = (who or "").upper()
    if who not in VALID_WHO:
        raise StreamError(f"--who must be B or K, got {who!r}")
    if kind not in VALID_KIND:
        raise StreamError(f"--kind must be one of {VALID_KIND}, got {kind!r}")
    if not body.strip():
        raise StreamError("empty (or whitespace-only) body — no card recorded")
    if reply_to is not None and not card_exists(reply_to):
        raise StreamError(f"--reply-to {reply_to!r} does not resolve to an existing card")

    ts_dt = ts or datetime.now()
    # Mint + write under the pool lock: mint_id probes the dir for a free id, so
    # two concurrent recorders (server door + hook + reconciler) could otherwise
    # resolve the SAME id and the later write would silently swallow the earlier
    # card. The lock makes probe->write one step; no turn can overwrite another.
    with pool_lock():
        cid = mint_id(ts_dt, who)
        card = Card(
            id=cid,
            who=who,
            ts=ts_dt.strftime("%Y-%m-%d %H:%M:%S"),
            reply_to=reply_to,
            tags=list(tags or []),
            kind=kind,
            refs=list(refs or []),
            session=session or None,
            body=body,
        )
        write_card(card)
    render_day(ts_dt.strftime("%Y-%m-%d"))
    render_month_index(ts_dt.strftime("%Y-%m"))
    return cid


# --------------------------------------------------------------------------------
# tag / untag
# --------------------------------------------------------------------------------

def add_tags(cid: str, tags_to_add: List[str]) -> Card:
    # Read-modify-write under the pool lock, so a concurrent tagger (cricket)
    # and recorder can't interleave and drop one side's change.
    with pool_lock():
        card = read_card(cid)
        for t in tags_to_add:
            if t not in card.tags:
                card.tags.append(t)
        write_card(card)
    _rerender_after_tag_change(card, tags_to_add)
    return card


def remove_tags(cid: str, tags_to_remove: List[str]) -> Card:
    with pool_lock():
        card = read_card(cid)
        card.tags = [t for t in card.tags if t not in tags_to_remove]
        write_card(card)
    _rerender_after_tag_change(card, tags_to_remove)
    return card


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
# Id safety. edit/delete take a caller-supplied id and turn it straight into a path
# — refuse anything that could walk out of the pool dir before that happens.
# --------------------------------------------------------------------------------

def _check_cid_safe(cid: str) -> None:
    if not cid or "/" in cid or "\\" in cid or ".." in cid:
        raise StreamError(f"invalid card id: {cid!r}")


# --------------------------------------------------------------------------------
# edit — replace a card's body in place. Frontmatter (id/who/ts/reply_to/tags/kind/refs)
# is untouched; only the body changes, so re-render is exactly what a tag change
# re-renders, keyed off the card's own tags rather than a delta.
# --------------------------------------------------------------------------------

def edit_card(cid: str, body: str) -> Card:
    _check_cid_safe(cid)
    if not body.strip():
        raise StreamError("empty (or whitespace-only) body — card not edited")
    with pool_lock():
        card = read_card(cid)
        card.body = body
        write_card(card)
    _rerender_after_tag_change(card, card.tags)
    return card


# --------------------------------------------------------------------------------
# delete — remove a card from the pool outright. render_day/render_month_index never
# touch a zero-card day/month (they return None instead), so a delete that empties one
# has to clean up the now-stale view itself, or it lingers forever.
#
# EVERY CUT LEAVES A CAST. Deleting used to unlink the file and leave nothing behind —
# no record of what went, when, or who asked for it. That made two completely different
# events look identical from the outside: a card the owner deliberately removed, and a
# turn the capture path silently lost. A twelve-minute hole in the pool could not be
# told apart from an ordinary deletion, because there was nothing to tell it apart
# WITH. So delete now writes the whole card — body verbatim — as one JSON line in
# `_system/data/deleted_cards.jsonl` before it unlinks anything.
#
# The cast is written FIRST, and a failure to write it ABORTS the delete. That ordering
# is the point, not an accident: a cut that leaves no cast is exactly the failure this
# exists to prevent, so refusing to cut is the correct outcome. The ordering we chose
# can only ever fail by refusing a deletion, which is cheap and obvious. The reverse
# ordering fails by removing a card with no record, which is the thing we're fixing.
# (A log line stranded by a later unlink error is possible and harmless — the id is
# still sitting in the pool, so the contradiction is self-evident.)
#
# Consequence, not a promise: because the body is kept, a deletion is now recoverable
# by hand from the log. Nothing reads this file back yet — no un-delete verb exists.
#
# Prompt: "build a delete log" — so a missing card can be told apart from a deleted one
# without archaeology.
# --------------------------------------------------------------------------------

def _log_deletion(card: Card, by: str) -> None:
    """Append one JSON line for a card that is about to be unlinked.

    One `open(..., "a")` and one `write()` of a line ending in "\\n": on Linux an
    O_APPEND write this small lands atomically, so two deleters running at once
    interleave whole lines instead of shredding each other's. No lock is taken, and
    that's deliberate — `delete_card` doesn't hold `pool_lock` either, and grabbing one
    here would change the engine's concurrency shape for a sidecar that doesn't need
    it."""
    entry = {
        "deleted_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "by": by,
        "id": card.id,
        "who": card.who,
        "ts": card.ts,
        "kind": card.kind,
        "reply_to": card.reply_to,
        "tags": card.tags,
        "refs": card.refs,
        "session": card.session,
        "body": card.body,
    }
    path = deleted_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def delete_card(cid: str, by: str = "unknown") -> None:
    _check_cid_safe(cid)
    card = read_card(cid)
    # Cast before cut. If this raises, the card is still in the pool — which is the
    # outcome we want over a silent removal.
    _log_deletion(card, by)
    card_path(cid).unlink()

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


def _render_card_block(card: Card) -> str:
    """`\\nB: <body>\\n` or `\\nK: *<body>*\\n` — multi-line bodies get the prefix
    (and, for K, the asterisks) only at the outer edges."""
    lines = card.body.split("\n")
    if card.who == "B":
        lines[0] = "B: " + lines[0]
    else:
        lines[0] = "K: *" + lines[0]
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
# Day view
# --------------------------------------------------------------------------------

def render_day_text(day: str, cards: Optional[List[Card]] = None) -> Optional[str]:
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
    """
    all_cards = load_all_cards() if cards is None else cards
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
    events.sort(key=lambda e: (e[0], e[1], e[2]))

    prev_ts: Optional[datetime] = None
    for ts_dt, _rank, _key, payload in events:
        if prev_ts is None or (ts_dt - prev_ts).total_seconds() > GAP_SECONDS:
            text += f"\n*[{_clock(ts_dt)}]*\n"
        if isinstance(payload, Card):
            text += _render_ref_block(payload) if payload.kind == "ref" else _render_card_block(payload)
        elif isinstance(payload, StreakMarker):
            text += _render_streak_marker_block(payload, ts_dt)
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
        (c for c in load_all_cards() if c.ts.startswith(month)),
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
    messages: List[str] = []
    ok = True
    cards: Dict[str, Card] = {}

    for path in sorted(pool_dir().glob("*.md")) if pool_dir().exists() else []:
        stem = path.stem
        try:
            card = parse_card_file(path)
        except StreamError as e:
            messages.append(f"INVALID {stem}: {e}")
            ok = False
            continue
        if card.id != stem:
            messages.append(f"INVALID {stem}: id field {card.id!r} != filename")
            ok = False
        if not _valid_ts(card.ts):
            messages.append(f"INVALID {stem}: bad ts {card.ts!r}")
            ok = False
        if card.who not in VALID_WHO:
            messages.append(f"INVALID {stem}: bad who {card.who!r}")
            ok = False
        if card.kind not in VALID_KIND:
            messages.append(f"INVALID {stem}: bad kind {card.kind!r}")
            ok = False
        cards[stem] = card

    for cid, card in cards.items():
        if card.reply_to is not None and card.reply_to not in cards:
            messages.append(f"INVALID {cid}: reply_to {card.reply_to!r} does not resolve")
            ok = False

    cycles_ok, cycle_messages = _check_cycles(cards)
    ok = ok and cycles_ok
    messages.extend(cycle_messages)

    for name in manifest_names():
        try:
            load_manifest(name)
        except StreamError as e:
            messages.append(f"INVALID manifest {name}: {e}")
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


def _cmd_tag(args: argparse.Namespace) -> int:
    try:
        add_tags(args.id, args.tags)
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


def _cmd_untag(args: argparse.Namespace) -> int:
    try:
        remove_tags(args.id, args.tags)
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


def _cmd_edit(args: argparse.Namespace) -> int:
    try:
        raw = _read_body(args)
    except OSError as e:
        print(f"error: --body-file: {e}", file=sys.stderr)
        return 1
    try:
        card = edit_card(args.id, raw)
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
    total = len(load_all_cards())
    print(f"{'OK' if ok else 'FAIL'} — {total} card(s), {len(messages)} issue(s)")
    return 0 if ok else 1


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="stream.py",
        description="Deterministic spine of the journal's card pool (see the module docstring).",
    )
    sub = p.add_subparsers(dest="verb", required=True)

    rec = sub.add_parser("record", help="mint a card from --body-file or stdin, re-render its day + month")
    rec.add_argument("--who", required=True, help="B or K")
    rec.add_argument(
        "--body-file", default=None,
        help="read the card body from this file instead of stdin (lets a gated "
             "session mint a card as one bare command, no pipe)")
    rec.add_argument("--reply-to", default=None, help="id of the card this one replies to")
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

    ren = sub.add_parser("render", help="rebuild derived views from the pool")
    ren.add_argument("--day", default=None, help="YYYY-MM-DD — rebuild one day's view")
    ren.add_argument("--view", default=None, help="rebuild one manifest's view")
    ren.add_argument("--all", action="store_true", help="rebuild every day, manifest, and month index")
    ren.set_defaults(func=_cmd_render)

    tagp = sub.add_parser("tag", help="add tags to a card")
    tagp.add_argument("id")
    tagp.add_argument("tags", nargs="+")
    tagp.set_defaults(func=_cmd_tag)

    untagp = sub.add_parser("untag", help="remove tags from a card")
    untagp.add_argument("id")
    untagp.add_argument("tags", nargs="+")
    untagp.set_defaults(func=_cmd_untag)

    editp = sub.add_parser("edit", help="replace a card's body from --body-file or stdin, re-render what depends on it")
    editp.add_argument("id")
    editp.add_argument("--body-file", default=None, help="read the new body from this file instead of stdin")
    editp.set_defaults(func=_cmd_edit)

    delp = sub.add_parser("delete", help="remove a card from the pool, re-render what's left")
    delp.add_argument("id")
    delp.add_argument("--by", help="who is asking (recorded in the deletion log)")
    delp.set_defaults(func=_cmd_delete)

    val = sub.add_parser("validate", help="check pool integrity and drift against derived files")
    val.set_defaults(func=_cmd_validate)

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
