"""The machine's proposals for where a food comes from — kept beside her sources, never in them.

**What this is.** The research pass (`scripts/propose_sources.py`) asks a model
where each food or product comes from; the checker
(`scripts/check_proposals.py`) tests each answer. Both read and write through
this file, and nothing else touches the proposal tables (sqlstore rung 34):

  source_proposals          — one proposed place for a food, product, or one
                              of her existing sources (a suggested fix)
  source_proposal_counties  — the USDA counties it's drawn as
  source_proposal_regions   — or the states/provinces it's drawn as, anywhere
                              in the world (ISO 3166-2 codes, georegions.py)
  source_proposal_parts     — a multi-ingredient product's ingredients
  source_proposal_evidence  — the research-pool entries behind it, each with
                              the checker's verdict

A proposal is always shown, marked as the machine's: 'unchecked', 'passed'
("checked by machine, not by her") or 'failed' with its reasons. A re-run
never deletes — the old proposal points at its replacement (superseded_by),
and only proposals with no replacement are "live". A passed proposal that
answers a "Request linking" request closes it (sourcestore.close_request).

Backed up with the food catalog: every write here goes through foodstore's
write transaction, so the five tables are in food_catalog.json after each one
and come back with the foods when a rebuild finds the catalog empty. They are
machine output, but only a paid model run would produce them again.

Touches: `sqlstore.py` (the tables), `foodstore.py` (the write transaction and
the backup; its merge moves a food's proposals), `sourcestore.py` (her sources and
requests, read; a request closed on a pass), `scripts/propose_sources.py` and
`scripts/check_proposals.py` (the callers), `tests/test_proposalstore.py`.

Prompt that produced this file: "propose where each food and product comes
from, with evidence and origin … display them no matter what, shown as
unapproved by me" — and "I want some checker built into the system."
"""
from contextlib import contextmanager

import foodstore
import sourcestore
import sqlstore

# The proposal columns this file writes from a cleaned proposal, in table order.
_FIELDS = ("name", "note", "lat", "lng", "precision", "radius_km", "area_kind",
           "region_name", "country", "transparency", "geo_source", "origin",
           "origin_detail", "origin_url", "origin_date", "usda_commodity", "summary",
           "worst_trace_seq", "worst_health_seq")
_COLUMNS = ("id", "food_id", "product_id", "request_id", "amends_source_id", *_FIELDS,
            "check_status", "check_reason", "checked_at", "model", "run_id",
            "superseded_by", "created_at")
_PART_COLUMNS = ("seq", "ingredient", "food_id", "place", "transparency", "geo_source",
                 "health_concern", "health_basis", "note")
CHECK_STATUSES = ("unchecked", "passed", "failed")


# --- connections --------------------------------------------------------------
# Writes go through foodstore's write transaction (foodstore._Write), the way
# sourcestore's do: lock up front, commit, roll back on any error, and after
# the commit a fresh food_catalog.json — which is how these tables are backed up.

@contextmanager
def _reading():
    conn = sqlstore.open_db()
    try:
        yield conn
    finally:
        conn.close()


# --- what still needs an answer -----------------------------------------------
# A target is one thing to ask the model about, keyed so its answer can be
# matched back: 'request:N', 'food:N', 'product:N' or 'source:ID'.

def _live_keys(conn):
    """The targets that already have a live proposal, as the keys they'd have."""
    keys = set()
    for food_id, product_id, request_id, amends in conn.execute(
            "SELECT food_id, product_id, request_id, amends_source_id FROM source_proposals"
            " WHERE superseded_by IS NULL"):
        if request_id is not None:
            keys.add(f"request:{request_id}")
        if amends:
            keys.add(f"source:{amends}")
        elif product_id is not None:
            keys.add(f"product:{product_id}")
        elif food_id is not None:
            keys.add(f"food:{food_id}")
    return keys


def _product_context(brand, store, size, food_name):
    bits = [f"a {food_name} product" if food_name else "a grocery product"]
    bits += [f"brand {brand}"] if brand else []
    bits += [f"bought at {store}"] if store else []
    bits += [f"size {size}"] if size else []
    return ", ".join(bits)


def _source_context(source):
    """What one of her sources says now, in a line, for the model to improve on."""
    counties = f", {len(source['counties'])} USDA counties" if source["counties"] else ""
    return (f"now says: {source['name']} at ({source['lat']:.3f}, {source['lng']:.3f}),"
            f" {source['precision']}, radius {source['radius_km']:g} km{counties},"
            f" transparency {source['transparency']}, geo_source {source['geo_source']},"
            f" origin {source['origin']} {source['origin_detail'] or ''}".strip()
            + (f"; note: {source['note']}" if source.get("note") else ""))


def targets(only=None, force=False):
    """Everything to ask about, in order: her open requests, foods with no
    source, products with no source, then her existing sources.

    `only` keeps one kind ('requests', 'foods', 'products', 'sources'); `force`
    keeps targets that already have a live proposal. A food with an open
    request is asked about once, as the request."""
    out = []
    with _reading() as conn:
        live = set() if force else _live_keys(conn)
        names = dict(conn.execute("SELECT id, name FROM foods"))
        linked_foods = {r[0] for r in conn.execute(
            "SELECT food_id FROM food_links WHERE target = 'ecosystem' AND food_id IS NOT NULL")}
        linked_products = {r[0] for r in conn.execute(
            "SELECT product_id FROM food_links WHERE target = 'ecosystem' AND product_id IS NOT NULL")}
        foods = conn.execute("SELECT id, name, category FROM foods WHERE kind = 'food'"
                             " ORDER BY id").fetchall()
        products = conn.execute("SELECT id, food_id, name, brand, store, size FROM products"
                                " ORDER BY id").fetchall()
        # A food counts as traced when any of its products is.
        linked_foods |= {food_id for pid, food_id, *_ in products if pid in linked_products}

    requests = sourcestore.requests("open")
    requested_foods = {r["food_id"] for r in requests if r["food_id"] is not None}
    if only in (None, "requests"):
        for r in requests:
            label = names.get(r["food_id"]) or r["food_name"]
            # A request for a name that isn't a food yet can't hold a proposal (the table needs one).
            if r["food_id"] is None and r["product_id"] is None:
                continue
            out.append({"key": f"request:{r['id']}", "label": label,
                        "context": "she asked where this comes from", "food_id": r["food_id"],
                        "product_id": r["product_id"], "request_id": r["id"],
                        "amends_source_id": None})
    if only in (None, "foods"):
        for food_id, name, category in foods:
            if food_id in linked_foods or food_id in requested_foods:
                continue
            out.append({"key": f"food:{food_id}", "label": name,
                        "context": f"a food ({category})" if category else "a food",
                        "food_id": food_id, "product_id": None, "request_id": None,
                        "amends_source_id": None})
    if only in (None, "products"):
        for pid, food_id, name, brand, store, size in products:
            if pid in linked_products:
                continue
            out.append({"key": f"product:{pid}", "label": name,
                        "context": _product_context(brand, store, size, names.get(food_id)),
                        "food_id": food_id, "product_id": pid, "request_id": None,
                        "amends_source_id": None})
    if only in (None, "sources"):
        for source in sourcestore.all_sources():
            link = next(iter(source["links"]), None)
            # A source linked to nothing has no food to hang a proposal on.
            if link is None:
                continue
            out.append({"key": f"source:{source['id']}", "label": source["name"],
                        "context": _source_context(source), "food_id": link.get("food_id"),
                        "product_id": link.get("product_id"), "request_id": None,
                        "amends_source_id": source["id"]})
    return [t for t in out if t["key"] not in live]


# --- writing a proposal -------------------------------------------------------

def add(target, proposal, counties=(), evidence=(), model="", run_id="", regions=()):
    """Save one cleaned proposal for `target`, unchecked. Returns its id.

    `counties` are USDA's county dicts (fips, county, state, value, unit);
    `regions` are [{code, name}] states/provinces (proposal area_kind 'state');
    `evidence` is [(research entry id, role)]. Any live proposal for the same
    target is pointed at this one."""
    values = {field: proposal.get(field) for field in _FIELDS}
    values["usda_commodity"] = values["usda_commodity"] or ""
    for field in ("note", "region_name", "country", "origin_detail", "origin_url",
                  "origin_date", "summary"):
        values[field] = values[field] or ""
    with foodstore._Write() as conn:
        columns = ["food_id", "product_id", "request_id", "amends_source_id", *values,
                   "model", "run_id"]
        cur = conn.execute(
            f"INSERT INTO source_proposals ({', '.join(columns)})"
            f" VALUES ({', '.join('?' * len(columns))})",
            (target.get("food_id"), target.get("product_id"), target.get("request_id"),
             target.get("amends_source_id"), *values.values(), model, run_id))
        proposal_id = cur.lastrowid
        for seq, county in enumerate(counties):
            conn.execute(
                "INSERT OR IGNORE INTO source_proposal_counties"
                " (proposal_id, fips, seq, county, state, value, unit) VALUES (?,?,?,?,?,?,?)",
                (proposal_id, county["fips"], seq, county.get("county", ""),
                 county.get("state", ""), county.get("value"), county.get("unit", "")))
        _write_regions(conn, proposal_id, regions)
        for part in proposal.get("parts") or ():
            conn.execute(
                f"INSERT INTO source_proposal_parts (proposal_id, {', '.join(_PART_COLUMNS)})"
                f" VALUES (?{', ?' * len(_PART_COLUMNS)})",
                (proposal_id, *(part.get(c, None if c == "food_id" else "")
                                for c in _PART_COLUMNS)))
        for entry_id, role in evidence:
            conn.execute(
                "INSERT OR IGNORE INTO source_proposal_evidence (proposal_id, entry_id, role)"
                " VALUES (?,?,?)", (proposal_id, entry_id, role))
        # Supersede, never delete: the old answer points at the new one.
        match, args = _same_target(target)
        conn.execute(f"UPDATE source_proposals SET superseded_by = ?"
                     f" WHERE superseded_by IS NULL AND id != ? AND {match}",
                     (proposal_id, proposal_id, *args))
    return proposal_id


def _write_regions(conn, proposal_id, regions):
    for seq, region in enumerate(regions):
        conn.execute(
            "INSERT OR IGNORE INTO source_proposal_regions (proposal_id, code, seq, name)"
            " VALUES (?,?,?,?)", (proposal_id, region["code"], seq, region.get("name", "")))


def set_regions(proposal_id, regions):
    """Draw an existing proposal as `regions` ([{code, name}]) in place of its
    circle. Only the drawing changes — the place, its words and its check stay
    as they were — so this is an update, not a superseding answer. False when
    there's no such proposal, or it's already drawn as counties or regions."""
    if not regions:
        return False
    with foodstore._Write() as conn:
        row = conn.execute("SELECT area_kind FROM source_proposals WHERE id = ?",
                           (proposal_id,)).fetchone()
        if row is None or row[0] != "circle":
            return False
        conn.execute("UPDATE source_proposals SET area_kind = 'state', precision = 'area'"
                     " WHERE id = ?", (proposal_id,))
        _write_regions(conn, proposal_id, regions)
    return True


def _same_target(target):
    """A WHERE clause matching proposals for the same target as `target`."""
    if target.get("amends_source_id"):
        return "amends_source_id = ?", (target["amends_source_id"],)
    if target.get("request_id") is not None:
        return "request_id = ?", (target["request_id"],)
    if target.get("product_id") is not None:
        return "product_id = ? AND amends_source_id IS NULL", (target["product_id"],)
    return ("food_id = ? AND product_id IS NULL AND amends_source_id IS NULL",
            (target.get("food_id"),))


# --- reading proposals --------------------------------------------------------

def _counties(conn, ids):
    out = {}
    for pid, fips, county, state, value, unit in conn.execute(
            f"SELECT proposal_id, fips, county, state, value, unit FROM source_proposal_counties"
            f" WHERE proposal_id IN ({', '.join('?' * len(ids))}) ORDER BY proposal_id, seq", ids):
        out.setdefault(pid, []).append(
            {"fips": fips, "county": county, "state": state, "value": value, "unit": unit})
    return out


def _regions(conn, ids):
    out = {}
    for pid, code, name in conn.execute(
            f"SELECT proposal_id, code, name FROM source_proposal_regions"
            f" WHERE proposal_id IN ({', '.join('?' * len(ids))}) ORDER BY proposal_id, seq", ids):
        out.setdefault(pid, []).append({"code": code, "name": name})
    return out


def _parts(conn, ids):
    out = {}
    for pid, *row in conn.execute(
            f"SELECT proposal_id, {', '.join(_PART_COLUMNS)} FROM source_proposal_parts"
            f" WHERE proposal_id IN ({', '.join('?' * len(ids))}) ORDER BY proposal_id, seq", ids):
        out.setdefault(pid, []).append(dict(zip(_PART_COLUMNS, row)))
    return out


def _evidence(conn, ids):
    """Each proposal's evidence entries, with the entry's words and the checker's verdict."""
    out = {}
    for pid, entry_id, role, status, reason, kind, text, url in conn.execute(
            f"SELECT e.proposal_id, e.entry_id, e.role, e.check_status, e.check_reason,"
            f" r.kind, r.text, r.url FROM source_proposal_evidence e"
            f" LEFT JOIN research_entries r ON r.id = e.entry_id"
            f" WHERE e.proposal_id IN ({', '.join('?' * len(ids))})"
            f" ORDER BY e.proposal_id, e.rowid", ids):
        out.setdefault(pid, []).append(
            {"entry_id": entry_id, "role": role, "check_status": status, "check_reason": reason,
             "kind": kind, "text": text or "", "url": url or ""})
    return out


def _citations(conn, evidence):
    """The cited pages behind a proposal's web claims: claim, page, quote.
    The quote is the note on the claim→source link."""
    claims = [e["entry_id"] for e in evidence if e["role"] == "web" and e["kind"] == "claim"]
    if not claims:
        return []
    return [{"claim_id": claim_id, "source_id": source_id, "url": url or "",
             "quote": note or "", "claim": claim_text or ""}
            for claim_id, source_id, url, note, claim_text in conn.execute(
                f"SELECT l.claim_id, l.source_id, s.url, l.note, c.text FROM claim_sources l"
                f" JOIN research_entries s ON s.id = l.source_id"
                f" JOIN research_entries c ON c.id = l.claim_id"
                f" WHERE l.claim_id IN ({', '.join('?' * len(claims))})", claims)]


def _read(where="", args=(), with_citations=False):
    with _reading() as conn:
        rows = conn.execute(
            f"SELECT {', '.join(_COLUMNS)} FROM source_proposals"
            f" WHERE superseded_by IS NULL {where} ORDER BY id", args).fetchall()
        proposals = [dict(zip(_COLUMNS, row)) for row in rows]
        ids = [p["id"] for p in proposals]
        if not ids:
            return []
        counties, parts, evidence = _counties(conn, ids), _parts(conn, ids), _evidence(conn, ids)
        regions = _regions(conn, ids)
        for proposal in proposals:
            proposal["counties"] = counties.get(proposal["id"], [])
            proposal["regions"] = regions.get(proposal["id"], [])
            proposal["parts"] = parts.get(proposal["id"], [])
            proposal["evidence"] = evidence.get(proposal["id"], [])
            if with_citations:
                proposal["citations"] = _citations(conn, proposal["evidence"])
    return proposals


def live(food_id=None):
    """Every live proposal (or one food's, counting its products'), each with
    its counties, regions, parts and evidence — what the pages show."""
    if food_id is None:
        return _read()
    return _read("AND (food_id = ? OR product_id IN (SELECT id FROM products WHERE food_id = ?))",
                 (food_id, food_id))


def unchecked(include_checked=False):
    """Live proposals for the checker, with their citations; only unchecked ones
    unless `include_checked`."""
    if include_checked:
        return _read(with_citations=True)
    return _read("AND check_status = 'unchecked'", with_citations=True)


# --- the checker's verdict ------------------------------------------------------

def set_check(proposal_id, status, reason, results=None):
    """Record the checker's verdict on a proposal and each evidence entry.

    `results` is {entry_id: (status, reason)}. A pass closes the request the
    proposal answers. False when there's no such proposal."""
    if status not in ("passed", "failed"):
        raise ValueError(f"a check passes or fails, not {status!r}")
    with foodstore._Write() as conn:
        row = conn.execute("SELECT request_id FROM source_proposals WHERE id = ?",
                           (proposal_id,)).fetchone()
        if row is None:
            return False
        conn.execute(
            "UPDATE source_proposals SET check_status = ?, check_reason = ?,"
            " checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            (status, str(reason or "")[:2000], proposal_id))
        for entry_id, (entry_status, entry_reason) in (results or {}).items():
            conn.execute(
                "UPDATE source_proposal_evidence SET check_status = ?, check_reason = ?"
                " WHERE proposal_id = ? AND entry_id = ?",
                (entry_status, str(entry_reason or "")[:600], proposal_id, entry_id))
    # A pass answers her request; closing it is sourcestore's write, after ours commits.
    if status == "passed" and row[0] is not None:
        sourcestore.close_request(row[0], "answered")
    return True
