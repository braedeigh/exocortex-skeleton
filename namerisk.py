"""Name risk — which of a person's names can't be trusted as a bare word match.

**What this does, in plain English.** Finding "cards about a person" by looking
for their name in the text goes wrong in two ways. A name can be an ordinary
word (someone called Will, in a journal full of "I will"). And two people can
share a first name, so the word alone can't say which one is meant. This file
works out, for every person in the vault's `people/` folder, which of their
names have one of those problems:

- **weak** — the word shows up in many cards, and the nightly tagger (which
  reads each card in context) tagged almost none of them with this person. The
  tagger's verdicts are the evidence: no word list is involved.
- **shared** — the same name or alias is listed by more than one person file.

Two callers use the answer. `tools/mention_context.py` stops loading cards on a
bare text match for these names. `scripts/thread_tending.py` gives each of them
its own nightly check.

It reads the people files through the app's own person parser
(`routes/entities.py`) and the cards out of `exo.db` (`cards`, `card_tags`,
`cards_fts`). It writes nothing.

Prompt: "I want it to judge if people being threaded actually match that
thread or if the organizer is making false conclusions. Like it tags this guy
with [a common word] and I hung out with him once. Or sometimes it won't
separate people with the same name."
"""
import re
from datetime import date, timedelta
from pathlib import Path

import store

# A name is weak when at least this many settled cards contain the word…
WEAK_MIN_HITS = 15
# …and the tagger gave this person's tag to less than this share of them.
# Measured on the live vault when this was written: real names sat at 0.8 to
# 1.0, the common-word and shared names at 0.01 to 0.11, with nothing between
# 0.11 and 0.4 above the hit floor.
WEAK_MAX_TAGGED_SHARE = 0.15
# Cards this recent are left out of the count: the tagger runs overnight, so a
# card from today or yesterday may simply not have been judged yet.
SETTLE_DAYS = 2


def all_people():
    """Every person file as {slug, name, file, terms}, one per file.

    The slug is the file's own name, so two files that share a first name stay
    two people. (`entities.people_index()` keys by first name and keeps only
    the first file, which is the wrong shape for telling them apart.)
    `terms` are the words that count as naming them: first name, full name and
    aliases."""
    from routes import entities

    people = []
    folder = store.CONTENT_DIR / entities.PEOPLE_DIR
    for path in sorted(folder.glob("*.md")):
        try:
            person = entities._parse_person(path)
        except (OSError, ValueError):
            continue
        name = person.get("name") or path.stem
        first = name.split()[0] if name.split() else ""
        people.append({
            "slug": path.stem, "name": name,
            "file": f"{entities.PEOPLE_DIR}/{path.name}",
            "terms": clean_terms([first, name] + list(person.get("aliases") or [])),
        })
    return people


def clean_terms(terms):
    """Drop blanks and repeats (case-insensitively), keeping the first spelling."""
    seen, out = set(), []
    for term in terms:
        term = (term or "").strip()
        if term and term.lower() not in seen:
            seen.add(term.lower())
            out.append(term)
    return out


def whole_word(terms, ignore_case=True):
    """Whole-word match for a list of names."""
    return re.compile(r"\b(?:" + "|".join(re.escape(t) for t in terms) + r")\b",
                      re.IGNORECASE if ignore_case else 0)


def shared_terms(people):
    """Names listed by more than one person file, lowercased."""
    owners = {}
    for person in people:
        for term in person["terms"]:
            owners.setdefault(term.lower(), set()).add(person["slug"])
    return {term for term, slugs in owners.items() if len(slugs) > 1}


def _tagged_share(conn, slug, term, before):
    """How many settled cards contain `term` as a whole word, and how many of
    those carry this person's tag. The word index narrows the search; each
    candidate is checked again with the whole-word pattern because the index
    folds word endings.

    Only cards from the day of this person's first tag onward are counted.
    Before that day the tagger didn't know the person, so an untagged card
    from then is not a verdict. A person never tagged gives (0, 0)."""
    tagged = {row[0] for row in conn.execute(
        "SELECT card_id FROM card_tags WHERE tag = ?", (slug,))}
    if not tagged:
        return 0, 0
    since = min(tagged)[:10]
    pattern = whole_word([term])
    query = '"' + term.replace('"', '""') + '"'
    rows = conn.execute(
        "SELECT c.id, c.body FROM cards c"
        " WHERE c.who = 'B' AND c.deleted_at IS NULL AND c.day >= ? AND c.day < ?"
        " AND c.id IN (SELECT card_id FROM cards_fts WHERE cards_fts MATCH ?)",
        (since, before, query)).fetchall()
    hits = [row[0] for row in rows if pattern.search(row[1] or "")]
    return len(hits), sum(1 for card_id in hits if card_id in tagged)


def classify(conn, people=None, today=None):
    """Each person's risky names: {slug: {"weak": [...], "shared": [...]}}.
    People with neither are left out. `conn` is a connection to exo.db."""
    people = all_people() if people is None else people
    today = today or date.today()
    before = (today - timedelta(days=SETTLE_DAYS)).isoformat()
    shared = shared_terms(people)
    risky = {}
    for person in people:
        weak = []
        for term in person["terms"]:
            hits, tagged = _tagged_share(conn, person["slug"], term, before)
            if hits >= WEAK_MIN_HITS and tagged / hits < WEAK_MAX_TAGGED_SHARE:
                weak.append(term)
        own_shared = [term for term in person["terms"] if term.lower() in shared]
        if weak or own_shared:
            risky[person["slug"]] = {"weak": weak, "shared": own_shared}
    return risky


# The marks that end a sentence. A capital letter right after one of these (or
# at the very start of the text) says nothing about whether the word is a name.
_SENTENCE_END = ".!?:;\n"


def named_midsentence(text, term):
    """True when `term` appears capitalised in the middle of a sentence — the
    one spelling of a common word that reads as a name. "Will upgrade it" and
    "i will go" are both False; "saw Will today" is True."""
    capitalised = term[:1].upper() + term[1:]
    for match in whole_word([capitalised], ignore_case=False).finditer(text or ""):
        before = text[:match.start()].rstrip(" \t\"'(")
        if before and before[-1] not in _SENTENCE_END:
            return True
    return False
