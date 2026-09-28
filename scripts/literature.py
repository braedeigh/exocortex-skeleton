#!/usr/bin/env python3
"""Comb the studies about a contaminant — the door an agent uses to find
independent research and hand her plain summaries to judge.

**Why this exists.** An agency's safe dose isn't taken on trust
(docs/exposure.md → "Agency figures aren't taken on trust"). For each
contaminant an agent searches the literature, reads each relevant study, and
writes down what it found — harm or no harm — in plain words, with the
study's own passage highlighted. She reads them and marks each useful or not;
the contaminant stops saying "Needs more research" once she has confirmed one.

Verbs (run from the skeleton, with EXOCORTEX_DATA_DIR set):

    literature.py search <contaminant> "<PubMed query>" [--max 40]
        Searches PubMed, prints the papers (id, year, type, title), and logs
        the search — database, query, how many matched, how many were listed —
        so no one searches the same thing twice without knowing.

    literature.py study <pmid> --topic <research topic id>
        Makes the paper a research source (one per address, reused if it
        exists) and keeps its PubMed record as the source's text: citation,
        publication types, funding, authors' affiliations, conflicts of
        interest, abstract. Prints
        the source id. The text is the abstract, not the full paper — the
        finding says so when that's all that was read.

    literature.py finding <contaminant> <source id> "<what it found>" \\
        --study-type in vitro|animal|human|review|other \\
        --leaning "found harm"|"found no harm"|mixed|background \\
        --passage "exact words from the source" [--note "..."]
        Records one study's finding as an `independent_evidence` fact, born
        unreviewed. The passage is looked for in the source's real text and
        highlighted there; if the words aren't in it, nothing is written.

    literature.py progress
        Every contaminant found in a scored food, in the order to comb them
        (the ones EPA sets no chronic limit for, then the largest share of a
        safe dose): searches logged, findings to judge, findings confirmed.

Touches: paperclients.py (PubMed), exposurestore.py (facts, the search log in
the pull ledger), researchstore.py (the passage's highlight), docstore.py (a
source's text), scripts/research_claims.py (making a source; finding a quote
in text).

Prompt that produced this file: "Would want to search for other verification
of not being toxic, like in vitro studies … All will need all sources combed
through" — then: "the idea is you'd find any studies related to them and
produce summaries for me to judge and see if they're useful."
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
if SKELETON not in sys.path:
    sys.path.insert(0, SKELETON)

import docstore  # noqa: E402  (sys.path above)
import exposurestore  # noqa: E402
import paperclients  # noqa: E402
import researchstore  # noqa: E402
import sqlstore  # noqa: E402
from scripts import research_claims  # noqa: E402


def search(hazard, query, limit=40):
    """Search PubMed about a contaminant and log the search. Returns
    (how many matched, [{pmid, title, journal, year, types}])."""
    found = paperclients.pubmed_search(query, limit)
    if not found["ok"]:
        raise ValueError(f"PubMed search failed: {found['error']}")
    listed = paperclients.pubmed_summaries(found["pmids"])
    if not listed["ok"]:
        raise ValueError(f"PubMed summaries failed: {listed['error']}")
    exposurestore.record_search(hazard, "pubmed", query, found["count"], len(listed["items"]))
    return found["count"], listed["items"]


def study_text(article):
    """A PubMed record as a source's readable text: everything a reader
    needs to weigh the study, then its abstract."""
    lines = [article["title"],
             f"{', '.join(article['authors'][:6])}{' et al.' if len(article['authors']) > 6 else ''}"
             f" — {article['journal']} ({article['year']}). PMID {article['pmid']}"
             + (f", doi {article['doi']}" if article["doi"] else ""),
             f"Publication type: {', '.join(article['types']) or 'not stated'}",
             f"Funding: {'; '.join(article['funding']) or 'not stated in the PubMed record'}",
             f"Authors' affiliations: {' | '.join(article.get('affiliations', [])[:5]) or 'not stated'}",
             f"Conflicts of interest: {article['conflicts'] or 'not stated in the PubMed record'}",
             "", "Abstract (PubMed):", "", article["abstract"] or "(no abstract in PubMed)"]
    return "\n".join(lines)


def study(pmid, topic):
    """Make a PubMed paper a research source with its record as the text.
    Returns (source id, created?)."""
    article = paperclients.pubmed_article(pmid)
    if not article["ok"]:
        raise ValueError(f"PubMed has no paper {pmid}: {article['error']}")
    citation = f"{article['title']} — {article['journal']} ({article['year']})"
    entry, created = research_claims.source(
        None, [topic], f"https://pubmed.ncbi.nlm.nih.gov/{article['pmid']}/", citation)
    # Keep the source's text only when it has none: a text already fetched
    # (a full paper, say) is never overwritten.
    if not docstore.has_text(f"entry:{entry['id']}"):
        docstore.save_entry_text(entry["id"], study_text(article))
    return entry["id"], created


def finding(hazard, source_id, summary, study_type, leaning, passage, note=None):
    """Record one study's finding about a contaminant, with its passage
    highlighted in the source. Returns (fact id, annotation id)."""
    if study_type not in exposurestore.STUDY_TYPES:
        raise ValueError(f"study type must be one of: {', '.join(exposurestore.STUDY_TYPES)}")
    if leaning not in exposurestore.LEANINGS:
        raise ValueError(f"leaning must be one of: {', '.join(exposurestore.LEANINGS)}")
    # Find the passage before writing anything, so a refusal leaves nothing behind.
    doc = f"entry:{source_id}"
    resolved = docstore.resolve(doc)
    if not resolved.get("ok"):
        raise ValueError(f"no text to search for source {source_id!r}")
    text = resolved["text"]
    located = research_claims.find_passage(text, passage)
    if located is None:
        raise ValueError(f"passage not found in source {source_id!r}; nothing was written. "
                         "Quote the text exactly as it reads.")
    start, end = located
    annotation_id = researchstore.add_annotation(doc, start, end, text[start:end],
                                                 note=summary, source="llm", needs_review=True)
    fact_id = exposurestore.add_fact(hazard, "independent_evidence", summary,
                                     basis=f"{study_type} · {leaning}", source_id=source_id,
                                     annotation_id=annotation_id, note=note, author="llm")
    return fact_id, annotation_id


def progress():
    """Every contaminant detected in a scored food, in combing order:
    [{id, name, no_limit, max_dri, searches, to_judge, confirmed}]."""
    conn = sqlstore.open_db()
    try:
        rows = conn.execute(
            "SELECT h.id, h.name, MAX(t.dri),"
            " EXISTS (SELECT 1 FROM hazard_facts WHERE hazard_id = h.id AND fact = 'no_chronic_limit')"
            " FROM exposure_terms t JOIN hazards h ON h.id = t.hazard_id"
            " WHERE t.samples_detected > 0 GROUP BY h.id").fetchall()
    finally:
        conn.close()
    searched = {}
    for pull in exposurestore.ledger(exposurestore.LITERATURE):
        hazard_id = pull["detail"].get("hazard_id")
        searched[hazard_id] = searched.get(hazard_id, 0) + 1
    out = []
    for hazard_id, name, max_dri, no_limit in rows:
        state = exposurestore.research_state(exposurestore.facts_for(hazard_id))
        out.append({"id": hazard_id, "name": name, "no_limit": bool(no_limit), "max_dri": max_dri,
                    "searches": searched.get(hazard_id, 0), "to_judge": state["to_judge"],
                    "confirmed": state["independent"]})
    # EPA's no-limit pesticides first, then the biggest share of a safe dose.
    out.sort(key=lambda item: (not item["no_limit"], -(item["max_dri"] or 0), item["name"]))
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    verbs = parser.add_subparsers(dest="verb", required=True)
    p_search = verbs.add_parser("search", help="search PubMed about a contaminant, and log it")
    p_search.add_argument("hazard")
    p_search.add_argument("query")
    p_search.add_argument("--max", type=int, default=40)
    p_study = verbs.add_parser("study", help="make a PubMed paper a research source")
    p_study.add_argument("pmid")
    p_study.add_argument("--topic", required=True)
    p_finding = verbs.add_parser("finding", help="record one study's finding, with its passage")
    p_finding.add_argument("hazard")
    p_finding.add_argument("source_id")
    p_finding.add_argument("summary")
    p_finding.add_argument("--study-type", required=True)
    p_finding.add_argument("--leaning", required=True)
    p_finding.add_argument("--passage", required=True)
    p_finding.add_argument("--note")
    verbs.add_parser("progress", help="what's been combed, in combing order")
    args = parser.parse_args(argv)

    try:
        if args.verb == "search":
            count, items = search(args.hazard, args.query, args.max)
            print(f"{count} papers match; listing {len(items)} (search logged)")
            for item in items:
                print(f"  {item['pmid']:>9}  {item['year']}  [{', '.join(item['types'][:2])}]"
                      f"  {item['title']}  — {item['journal']}")
        elif args.verb == "study":
            source_id, created = study(args.pmid, args.topic)
            print(f"source {source_id} ({'new' if created else 'already in the pool'})")
        elif args.verb == "finding":
            fact_id, annotation_id = finding(args.hazard, args.source_id, args.summary,
                                             args.study_type, args.leaning, args.passage, args.note)
            print(f"finding {fact_id} recorded (unreviewed), passage {annotation_id}")
        elif args.verb == "progress":
            for item in progress():
                share = "no limit" if item["no_limit"] else (
                    f"{item['max_dri']:.4f}" if item["max_dri"] is not None else "no dose")
                print(f"  {item['id']:>4}  {item['name'][:40]:40} {share:>9}  searches={item['searches']}"
                      f"  to judge={item['to_judge']}  confirmed={item['confirmed']}")
    except ValueError as problem:
        print(f"REFUSED  {problem}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
