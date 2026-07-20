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
    <manifest out path>              VIEW   e.g. people/views/sally.md — every card
                                            tagged `sally`, inlined verbatim. derived.

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

THE VERBS. `record` (the primitive: stdin body + flags -> mint a card, re-render its
day + month, echo the id), `render` (rebuild `--day`, `--view NAME`, or `--all` from
the pool), `tag` / `untag` (edit a card's tags, re-render what depends on them),
`edit` (replace a card's body from stdin, re-render its day + month + any manifest
selecting its tags — echoes the id), `delete` (remove a card from the pool outright,
re-render what's left — and clean up a day/month view that just lost its last card,
since render never touches a zero-card day/month on its own), `validate` (structural
checks on the whole pool + a drift check against every derived file).

Stdlib only. No network. No randomness. Same pool in, same bytes out, always.
"""
import argparse
import os
import sys
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
    # `refs` is optional on parse (older cards predate it) — defaults to [].
    refs = _parse_refs(fields_["refs"]) if "refs" in fields_ else []
    return Card(
        id=fields_["id"],
        who=fields_["who"],
        ts=fields_["ts"],
        reply_to=reply_to,
        tags=_parse_tags(fields_["tags"]),
        kind=fields_["kind"],
        refs=refs,
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
        "---",
    ])
    # Exactly one trailing newline, regardless of how many the body carries.
    return header + "\n" + card.body.rstrip("\n") + "\n"


def write_card(card: Card) -> Path:
    pool_dir().mkdir(parents=True, exist_ok=True)
    path = card_path(card.id)
    path.write_text(render_card_text(card), encoding="utf-8")
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
    cid = mint_id(ts_dt, who)
    card = Card(
        id=cid,
        who=who,
        ts=ts_dt.strftime("%Y-%m-%d %H:%M:%S"),
        reply_to=reply_to,
        tags=list(tags or []),
        kind=kind,
        refs=list(refs or []),
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
    card = read_card(cid)
    for t in tags_to_add:
        if t not in card.tags:
            card.tags.append(t)
    write_card(card)
    _rerender_after_tag_change(card, tags_to_add)
    return card


def remove_tags(cid: str, tags_to_remove: List[str]) -> Card:
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
    card = read_card(cid)
    if not body.strip():
        raise StreamError("empty (or whitespace-only) body — card not edited")
    card.body = body
    write_card(card)
    _rerender_after_tag_change(card, card.tags)
    return card


# --------------------------------------------------------------------------------
# delete — remove a card from the pool outright. render_day/render_month_index never
# touch a zero-card day/month (they return None instead), so a delete that empties one
# has to clean up the now-stale view itself, or it lingers forever.
# --------------------------------------------------------------------------------

def delete_card(cid: str) -> None:
    _check_cid_safe(cid)
    card = read_card(cid)
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
# Day view
# --------------------------------------------------------------------------------

def render_day_text(day: str, cards: Optional[List[Card]] = None) -> Optional[str]:
    """The rendered `Journal/Daily/<day>.md` body, or None if no card exists for that
    day (a day with zero cards is never touched — see `render_day`)."""
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

    text = f"# {day}\n\n`B = Bradie | K = Keeper`\n\n"
    if context_cards:
        text += context_cards[0].body + "\n\n"
    text += "---\n"

    prev_ts: Optional[datetime] = None
    for c in timeline_cards:
        ts_dt = _parse_ts(c.ts)
        if prev_ts is None or (ts_dt - prev_ts).total_seconds() > GAP_SECONDS:
            text += f"\n*[{_clock(ts_dt)}]*\n"
        text += _render_ref_block(c) if c.kind == "ref" else _render_card_block(c)
        prev_ts = ts_dt
    return text


def render_day(day: str) -> Optional[Path]:
    text = render_day_text(day)
    if text is None:
        return None
    daily_dir().mkdir(parents=True, exist_ok=True)
    path = daily_dir() / f"{day}.md"
    path.write_text(text, encoding="utf-8")
    return path


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
    out_path = stream_root() / manifest.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    return out_path


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
    index_dir().mkdir(parents=True, exist_ok=True)
    path = index_dir() / f"{month}.md"
    path.write_text(render_index_text(month, month_cards), encoding="utf-8")
    return path


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

def _cmd_record(args: argparse.Namespace) -> int:
    raw = sys.stdin.read()
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
    raw = sys.stdin.read()
    try:
        card = edit_card(args.id, raw)
    except StreamError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(card.id)
    return 0


def _cmd_delete(args: argparse.Namespace) -> int:
    try:
        delete_card(args.id)
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

    rec = sub.add_parser("record", help="mint a card from stdin, re-render its day + month")
    rec.add_argument("--who", required=True, help="B or K")
    rec.add_argument("--reply-to", default=None, help="id of the card this one replies to")
    rec.add_argument("--tags", default=None, help="comma-separated tags, e.g. a,b,c")
    rec.add_argument("--ts", default=None, help="'YYYY-MM-DD HH:MM:SS' (default: now)")
    rec.add_argument("--kind", default="line", choices=VALID_KIND)
    rec.add_argument(
        "--refs", default=None,
        help="comma-separated reference targets (only meaningful for --kind ref), "
             "e.g. 2026-05-14,people/vivian.md",
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

    editp = sub.add_parser("edit", help="replace a card's body from stdin, re-render what depends on it")
    editp.add_argument("id")
    editp.set_defaults(func=_cmd_edit)

    delp = sub.add_parser("delete", help="remove a card from the pool, re-render what's left")
    delp.add_argument("id")
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
