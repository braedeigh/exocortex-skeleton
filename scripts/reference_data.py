#!/usr/bin/env python3
"""Pull public residue data, score foods, and see what has been pulled.

Plain English: the one command for the verifiable-organic data (see
docs/exposure.md). It fetches the public files into the commons if they
aren't there yet, reads them into commons.db, writes each pull into the
ledger so nobody pulls the same thing twice, and computes each food's
exposure score.

    venv/bin/python3 scripts/reference_data.py pdp-code potatoes PO
    venv/bin/python3 scripts/reference_data.py pdp-code strawberries ST ST:FZ
    venv/bin/python3 scripts/reference_data.py pull-pdp --year 2023 --food potatoes
    venv/bin/python3 scripts/reference_data.py load-epa
    venv/bin/python3 scripts/reference_data.py load-iris   # IRIS reference doses, for what EPA's table lacks
    venv/bin/python3 scripts/reference_data.py score --food potatoes
    venv/bin/python3 scripts/reference_data.py ledger
    venv/bin/python3 scripts/reference_data.py fetch-pdf --all   # sources' PDFs + passage pages
    venv/bin/python3 scripts/reference_data.py fact Chlorpropham use "plant growth regulator" \\
        --source-id 2026-09-27.1000

Pulling something already in the ledger (same dataset, year, food and loader
version, with its rows still in commons.db) does nothing; --force re-reads.
Only one run at a time: a second one waits for the first, because the big
files are read in full and this machine has run out of memory before.

Prompt that produced this file: "have memory of what has been researched and
make it easy to reference everything" — a CLI with pull-pdp, load-epa,
score and ledger, where pulling the same thing again does nothing.
"""
import argparse
import fcntl
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import commons  # noqa: E402  (sys.path above)
import commonsdb  # noqa: E402
import exposurestore  # noqa: E402
import reference_loaders  # noqa: E402
from scripts import commons_fetch  # noqa: E402

PDP_INDEX = "https://www.ams.usda.gov/datasets/pdp/pdpdata"
PDP_URL = "https://www.ams.usda.gov/sites/default/files/media/{year}PDPDatabase.zip"
EPA_URL = "https://www.epa.gov/sdwa/2021-human-health-benchmarks-pesticides"
IRIS_URL = "https://iris.epa.gov/AdvancedSearch/rfd_toxicity_values"


def _commons_file(url, source, meta):
    """The commons file fetched from `url`, fetching it first if it isn't there.
    Returns its manifest entry."""
    root = commons.commons_dir()
    for entry in commons.read_manifest(root)["files"]:
        if entry.get("url") == url:
            return entry
    print(f"fetching {url} into the commons …")
    temp, served_name = commons_fetch.download(url, root / source)
    meta = dict(meta, url=url, name=meta.get("name") or served_name)
    _, entry = commons_fetch.add_file(temp, source, meta, root, move=True)
    return entry


def pdp_url(year):
    """Where USDA publishes one year's PDP zip.

    The already-fetched copy's address if the commons has one; otherwise the
    link on USDA's index page (some years end in .ZIP, some in .zip); the
    usual pattern if the page can't be read.
    """
    for entry in commons.read_manifest()["files"]:
        if entry.get("source") == "usda-pdp" and str(entry.get("year")) == str(year) \
                and "PDPDatabase" in entry.get("url", ""):
            return entry["url"]
    try:
        request = urllib.request.Request(PDP_INDEX, headers={"User-Agent": commons_fetch.USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:
            page = response.read().decode("utf-8", "replace")
        match = re.search(rf'href="([^"]*/{year}PDPDatabase\.zip)"', page, re.IGNORECASE)
        if match:
            return urllib.parse.urljoin(PDP_INDEX, match.group(1))
    except OSError:
        pass
    return PDP_URL.format(year=year)


def _one_at_a_time():
    """Hold a lock on the commons for the whole run; a second run waits here."""
    root = commons.commons_dir()
    root.mkdir(parents=True, exist_ok=True)
    handle = open(root / ".reference_data.lock", "w")
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def _codes_for(args):
    """The PDP commodity codes a command is about: --commodity, or the food's codes."""
    if args.commodity:
        return [args.commodity.upper()]
    codes = exposurestore.pdp_codes(args.food)
    found = sorted({code for pairs in codes.values() for code, _ in pairs})
    if not found:
        raise SystemExit(f"{args.food!r} has no PDP code yet — set one with pdp-code")
    return found


def pull_pdp(year, codes, force=False):
    """Pull one PDP year for the given commodity codes. Returns what happened, per code."""
    version = reference_loaders.LOADER_VERSIONS["usda-pdp"]
    root = commons.commons_dir()
    report = {}
    # Skip what the ledger has AND commons.db still holds — unless forced.
    with commonsdb.session() as conn:
        todo = [code for code in codes if force
                or not exposurestore.find_pull("usda-pdp", year, code, version)
                or not commonsdb.sample_count(conn, year, code)]
    for code in set(codes) - set(todo):
        report[code] = "already pulled"
    if not todo:
        return report
    entry = _commons_file(pdp_url(year), "usda-pdp", {
        "title": f"PDP {year} sample-level database", "year": str(year), "publisher": "USDA AMS"})
    with commonsdb.session() as conn:
        counts = reference_loaders.load_pdp(conn, root / entry["path"], year, todo)
    for code in todo:
        detail = dict(counts[code], **counts["_reference"])
        exposurestore.record_pull("usda-pdp", year, code, entry["path"], entry["sha256"],
                                  counts[code]["samples"] + counts[code]["results"], detail, version)
        report[code] = counts[code]
    return report


def load_epa(force=False):
    """Load EPA's benchmark table into commons.db. Returns the pesticide count or 'already'."""
    version = reference_loaders.LOADER_VERSIONS["epa-hhbp"]
    with commonsdb.session() as conn:
        loaded = conn.execute("SELECT COUNT(*) FROM epa_benchmarks").fetchone()[0]
    if not force and loaded and exposurestore.find_pull("epa-hhbp", 0, "", version):
        return "already pulled"
    entry = _commons_file(EPA_URL, "epa", {
        "title": "EPA Human Health Benchmarks for Pesticides (2021), web table",
        "publisher": "US EPA", "name": "hhbp-2021.html"})
    with commonsdb.session() as conn:
        count = reference_loaders.load_benchmarks(conn, commons.commons_dir() / entry["path"])
    exposurestore.record_pull("epa-hhbp", 0, "", entry["path"], entry["sha256"], count,
                              {"pesticides": count}, version)
    return count


def load_iris(force=False):
    """Load IRIS's reference-dose table into commons.db. Returns the chemical count or 'already'."""
    version = reference_loaders.LOADER_VERSIONS["epa-iris-rfd"]
    with commonsdb.session() as conn:
        loaded = conn.execute("SELECT COUNT(*) FROM iris_rfd").fetchone()[0]
    if not force and loaded and exposurestore.find_pull("epa-iris-rfd", 0, "", version):
        return "already pulled"
    entry = _commons_file(IRIS_URL, "epa", {
        "title": "EPA IRIS oral reference doses (Advanced Search, RfD table)",
        "publisher": "US EPA", "name": "iris-rfd.html"})
    with commonsdb.session() as conn:
        count = reference_loaders.load_iris(conn, commons.commons_dir() / entry["path"])
    exposurestore.record_pull("epa-iris-rfd", 0, "", entry["path"], entry["sha256"], count,
                              {"chemicals": count}, version)
    return count


def _pdf_folder(url):
    """Which commons folder a source's PDF goes in, by who published it."""
    host = urllib.parse.urlparse(url).netloc.lower()
    if "ams.usda.gov" in host:
        return "usda-pdp"
    if "fda.gov" in host:
        return "fda-tds"
    return "papers"


def fetch_pdf(source_id):
    """Keep a research source's PDF in the commons and note each passage's page.

    Returns a line saying what happened. A source whose address doesn't give
    a PDF (a web article) is left alone — its highlights stay in the text view.
    """
    import pdfpages
    import sqlstore
    conn = sqlstore.open_db()
    try:
        row = conn.execute("SELECT url, text FROM research_entries WHERE id = ? AND kind = 'source'",
                           (source_id,)).fetchone()
        passages = conn.execute(
            "SELECT id, exact FROM research_annotations WHERE doc = ? AND exact IS NOT NULL",
            (f"entry:{source_id}",)).fetchall()
    finally:
        conn.close()
    if not row or not row[0]:
        return f"{source_id}: no such source, or it has no address"
    url, title = row
    root = commons.commons_dir()
    entry = next((each for each in commons.read_manifest(root)["files"] if each.get("url") == url), None)
    if entry is None:
        folder = root / _pdf_folder(url)
        temp, served_name = commons_fetch.download(url, folder)
        with open(temp, "rb") as handle:
            if handle.read(5) != b"%PDF-":
                temp.unlink()
                return f"{source_id}: {url} is not a PDF — left to the text view"
        name = served_name if served_name.lower().endswith(".pdf") else f"{source_id}.pdf"
        _, entry = commons_fetch.add_file(temp, _pdf_folder(url), {
            "url": url, "title": title[:200], "name": name}, root, move=True)
    pages = pdfpages.page_texts(root / entry["path"])
    exposurestore.set_source_file(source_id, entry["path"], entry["sha256"], len(pages))
    found = {annotation_id: pdfpages.find_page(pages, exact) for annotation_id, exact in passages}
    exposurestore.set_passage_pages({key: page for key, page in found.items() if page})
    missing = [key for key, page in found.items() if not page]
    return (f"{source_id}: {entry['path']} ({len(pages)} pages); "
            f"{len(found) - len(missing)} of {len(found)} passages placed"
            + (f"; not found: {', '.join(missing)}" if missing else ""))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    code_cmd = commands.add_parser("pdp-code", help="say which PDP commodity a food is")
    code_cmd.add_argument("food")
    code_cmd.add_argument("codes", nargs="+", help="PO, or ST:FZ for one form only")

    pull = commands.add_parser("pull-pdp", help="pull one PDP year for a food")
    pull.add_argument("--year", type=int, required=True)
    which = pull.add_mutually_exclusive_group(required=True)
    which.add_argument("--food")
    which.add_argument("--commodity")
    pull.add_argument("--force", action="store_true")

    epa = commands.add_parser("load-epa", help="load EPA's pesticide benchmark table")
    epa.add_argument("--force", action="store_true")

    iris = commands.add_parser("load-iris", help="load EPA IRIS's reference-dose table")
    iris.add_argument("--force", action="store_true")

    score = commands.add_parser("score", help="compute a food's exposure scores")
    score.add_argument("--food", required=True)
    score.add_argument("--years", help="comma-separated; default: every year pulled, "
                                       "plus the latest on its own")

    ledger = commands.add_parser("ledger", help="what has been pulled")
    ledger.add_argument("--dataset")

    pdf = commands.add_parser("fetch-pdf", help="keep a source's PDF and place its passages on pages")
    pdf.add_argument("source_ids", nargs="*")
    pdf.add_argument("--all", action="store_true", help="every source with a highlighted passage")

    fact = commands.add_parser("fact", help="record a sourced fact about a contaminant")
    fact.add_argument("hazard")
    fact.add_argument("fact", choices=sorted(exposurestore.FACTS))
    fact.add_argument("value")
    fact.add_argument("--amount", type=float)
    fact.add_argument("--unit")
    fact.add_argument("--basis")
    fact.add_argument("--source-id")
    fact.add_argument("--annotation-id")
    fact.add_argument("--url")
    fact.add_argument("--note")
    args = parser.parse_args(argv)

    try:
        if args.command == "pdp-code":
            pairs = [tuple((code.split(":") + [""])[:2]) for code in args.codes]
            food_id = exposurestore.set_pdp_codes(args.food, pairs)
            print(f"food {food_id}: {exposurestore.pdp_codes(food_id)[food_id]}")
        elif args.command == "pull-pdp":
            lock = _one_at_a_time()
            report = pull_pdp(args.year, _codes_for(args), args.force)
            lock.close()
            for code, what in sorted(report.items()):
                print(f"{args.year} {code}: {json.dumps(what)}")
        elif args.command == "load-epa":
            lock = _one_at_a_time()
            print(f"EPA benchmarks: {load_epa(args.force)}")
            lock.close()
        elif args.command == "load-iris":
            lock = _one_at_a_time()
            print(f"IRIS reference doses: {load_iris(args.force)}")
            lock.close()
        elif args.command == "score":
            import exposure  # the calculation; imported here so the other commands don't need it
            lock = _one_at_a_time()
            for line in exposure.score_food(args.food, args.years):
                print(line)
            lock.close()
        elif args.command == "ledger":
            for pull in exposurestore.ledger(args.dataset):
                print(f"{pull['pulled_at'][:16]}  {pull['dataset']:9} {pull['year'] or '':5}"
                      f" {pull['scope'] or 'all':4} rows={pull['rows']:<8} v{pull['loader_version']}"
                      f"  {pull['file_path']}  {json.dumps(pull['detail'])}")
        elif args.command == "fetch-pdf":
            ids = list(args.source_ids)
            if args.all:
                import sqlstore
                conn = sqlstore.open_db()
                try:
                    ids += [row[0] for row in conn.execute(
                        "SELECT DISTINCT substr(doc, 7) FROM research_annotations"
                        " WHERE doc LIKE 'entry:%' ORDER BY 1")]
                finally:
                    conn.close()
            lock = _one_at_a_time()
            for source_id in ids:
                try:
                    print(fetch_pdf(source_id))
                except (OSError, commons_fetch.TooBig) as problem:
                    print(f"{source_id}: couldn't fetch — {problem}")
            lock.close()
        elif args.command == "fact":
            fact_id = exposurestore.add_fact(
                args.hazard, args.fact, args.value, amount=args.amount, unit=args.unit,
                basis=args.basis, source_id=args.source_id, annotation_id=args.annotation_id,
                url=args.url, note=args.note, author="llm")
            print(f"fact {fact_id} recorded (unreviewed)")
    except ValueError as problem:
        print(f"REFUSED  {problem}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), from __main__ only.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
