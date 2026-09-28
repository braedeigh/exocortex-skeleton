#!/usr/bin/env python3
"""Bring a public file into the commons, and record where it came from.

Plain English: this is the one door into the commons (see commons.py). Give
it a web address, or a file you already downloaded by hand, and a source name
("usda-pdp", "fda-tds", "epa"). It saves the file untouched under
`<commons>/<source>/`, works out its sha256 checksum, and adds a line to
`manifest.json` saying where it came from and when. Anyone can later re-check
that the file is still exactly what the publisher released.

    venv/bin/python3 scripts/commons_fetch.py URL --source usda-pdp \\
        --title "PDP 2023 sample data" --year 2023
    venv/bin/python3 scripts/commons_fetch.py --file ~/Downloads/x.pdf --source epa \\
        --url-was https://www.epa.gov/...     # a file saved by hand
    venv/bin/python3 scripts/commons_fetch.py URL --source usda-fdc --outside-git   # a file over the limit
    venv/bin/python3 scripts/commons_fetch.py --list
    venv/bin/python3 scripts/commons_fetch.py --verify

Safe to re-run: a file whose checksum is already in the manifest is skipped.
It never overwrites a different file of the same name — it stops and says so.
Downloads stream to disk in 1 MB chunks (memory stays flat however big the
file), and anything over commons.MAX_FILE_BYTES is refused, because a single
file over GitHub's limit would block every backup push of the commons repo.
`--outside-git` is the one way past that limit: the file is still filed and
checksummed in the manifest like any other, but its path goes into the
commons' .gitignore first, so the backups skip it. Anyone can re-fetch it from
the manifest's address and check it against the recorded sha256.

Prompt that produced this file: "i want to save it all and all the files and
pdfs for people to comb through if they want."
"""
import argparse
import os
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import commons  # noqa: E402  (sys.path above)

# Some agency servers turn away Python's default user agent.
USER_AGENT = "exocortex-commons/1 (+public reference data archive)"


class TooBig(Exception):
    pass


def _safe_name(name):
    """A plain filename: no folders, no odd characters."""
    name = os.path.basename(urllib.parse.unquote(name or "")).strip()
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return name or "download"


def download(url, into_dir, limit=commons.MAX_FILE_BYTES):
    """Stream `url` to a temp file in `into_dir`; return (temp path, filename).

    The temp file sits beside where the file will land, so the final move is a
    rename, never a copy. Stops the moment the size passes `limit` (None: no limit).
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    into_dir.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=into_dir, prefix=".fetch-", suffix=".part")
    try:
        with urllib.request.urlopen(request, timeout=60) as response, os.fdopen(handle, "wb") as out:
            # Take the name the server gives, else the last part of the address.
            disposition = response.headers.get("Content-Disposition") or ""
            match = re.search(r'filename="?([^";]+)"?', disposition)
            name = match.group(1) if match else urllib.parse.urlparse(response.geturl()).path
            written = 0
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                written += len(chunk)
                if limit is not None and written > limit:
                    raise TooBig(f"{url} is over {limit // (1024 * 1024)} MB")
                out.write(chunk)
        return Path(temp), _safe_name(name)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def add_file(path, source, meta, root=None, move=False, outside_git=False):
    """File `path` under `<root>/<source>/` and record it in the manifest.

    Returns (status, entry): status is "added", or "already" when the same
    bytes are already in the commons. Raises FileExistsError if a DIFFERENT
    file already has that name — nothing is ever overwritten. `outside_git`
    lets a file past the size limit in, kept out of git (see the top of file).
    """
    root = Path(root or commons.commons_dir())
    path = Path(path)
    source = _safe_name(source)
    name = _safe_name(meta.pop("name", None) or path.name)

    # Refuse files too big for a git push before anything else happens.
    size = path.stat().st_size
    if size > commons.MAX_FILE_BYTES and not outside_git:
        raise TooBig(f"{path} is {size // (1024 * 1024)} MB, over the limit")

    # Skip bytes the commons already holds, wherever they were filed.
    checksum = commons.sha256_of(path)
    manifest = commons.read_manifest(root)
    for entry in manifest["files"]:
        if entry["sha256"] == checksum:
            if move:
                path.unlink()
            return "already", entry

    # Never overwrite: a different file of the same name stops the run.
    relative = f"{source}/{name}"
    target = root / relative
    if target.exists():
        raise FileExistsError(f"{relative} already exists with different contents — pick another --name")

    target.parent.mkdir(parents=True, exist_ok=True)

    # Keep an outside-git file out of the backups: ignored BEFORE it lands, so
    # an hourly auto-commit can never catch it half-way.
    if outside_git:
        _ignore(root, relative)
    if move:
        os.replace(path, target)
    else:
        shutil.copy2(path, target)

    entry = {
        "path": relative,
        "source": source,
        "sha256": checksum,
        "bytes": size,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if outside_git:
        entry["in_git"] = False
    entry.update({key: value for key, value in meta.items() if value not in (None, "")})
    manifest["files"].append(entry)
    commons.write_manifest(manifest, root)
    return "added", entry


def _ignore(root, relative):
    """Add one path to the commons' .gitignore, once."""
    ignore = root / ".gitignore"
    lines = ignore.read_text().splitlines() if ignore.exists() else []
    if relative not in lines:
        heading = "# Over the git size limit: kept here, checksummed in the manifest, never committed."
        added = ([] if heading in lines else ["", heading]) + [relative]
        ignore.write_text("\n".join(lines + added).lstrip("\n") + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("url", nargs="?", help="web address to download")
    parser.add_argument("--file", help="add a file already on disk instead of downloading")
    parser.add_argument("--url-was", help="with --file: the address it was downloaded from")
    parser.add_argument("--source", help="short source name, e.g. usda-pdp, fda-tds, epa")
    parser.add_argument("--title", help="what the file is, in words")
    parser.add_argument("--year", help="the data year it covers")
    parser.add_argument("--publisher", help="who published it, e.g. USDA AMS")
    parser.add_argument("--note", help="anything else worth knowing")
    parser.add_argument("--name", help="filename to save it as")
    parser.add_argument("--outside-git", action="store_true",
                        help="a file over the size limit: keep it, but out of the commons' git")
    parser.add_argument("--list", action="store_true", help="print what the commons holds")
    parser.add_argument("--verify", action="store_true", help="re-check every file's checksum")
    args = parser.parse_args(argv)
    root = commons.commons_dir()

    # List mode: one line per file, then the total.
    if args.list:
        files = commons.read_manifest(root)["files"]
        for entry in files:
            print(f"{entry['bytes'] / 1e6:8.1f} MB  {entry['path']}  {entry.get('title', '')}")
        print(f"{len(files)} files in {root}")
        return 0

    # Verify mode: every file still present and still the same bytes.
    if args.verify:
        problems = commons.verify(root)
        for path, what in problems:
            print(f"PROBLEM  {path}: {what}")
        print("all files verified" if not problems else f"{len(problems)} problem(s)")
        return 1 if problems else 0

    if not args.source or not (args.url or args.file):
        parser.error("give a URL or --file, and --source")

    meta = {"title": args.title, "year": args.year, "publisher": args.publisher,
            "note": args.note, "name": args.name}
    try:
        if args.file:
            meta["url"] = args.url_was
            status, entry = add_file(args.file, args.source, meta, root, outside_git=args.outside_git)
        else:
            meta["url"] = args.url
            limit = None if args.outside_git else commons.MAX_FILE_BYTES
            temp, served_name = download(args.url, root / _safe_name(args.source), limit)
            meta["name"] = meta["name"] or served_name
            status, entry = add_file(temp, args.source, meta, root, move=True, outside_git=args.outside_git)
    except (TooBig, FileExistsError) as problem:
        print(f"REFUSED  {problem}", file=sys.stderr)
        return 2
    print(f"{status}  {entry['path']}  {entry['bytes'] / 1e6:.1f} MB  sha256 {entry['sha256'][:12]}")
    return 0


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), from __main__ only.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
