#!/usr/bin/env python3
# Origin: personal vault mailclaude/bin/poll-mail.py. Scrubbed modular copy —
# plug-in points marked PLUG-IN(...)
"""Poll the site's mailbox over IMAP; write one json per new message into
data/inbox/. Runs as `mailer` via mail-poll.timer. Stdlib only.

Config: <SRV_DIR>/secrets/imap.json
  {"host": "imap.example.com", "port": 993,
   "user": "box@example.com", "password": "...",
   "folder": "INBOX",
   "match_to": "ask@example.com"}   # optional routing rule; omit = take all
"""
import email
import email.utils
import imaplib
import hashlib
import json
import os
import sys
import tempfile
from email.header import decode_header, make_header

# PLUG-IN(SRV_DIR): base install directory. Default matches install.sh and the
# systemd units below; override with MAILCLAUDE_BASE if you relocate the tree
# (you must also update the systemd units and clerk/.claude/settings.json).
BASE = os.environ.get("MAILCLAUDE_BASE", "/srv/mailclaude")
DATA = os.path.join(BASE, "data")
CONF = os.path.join(BASE, "secrets", "imap.json")
DIRS = ("inbox", "drafts", "sent", "failed")


def hdr(msg, name):
    raw = msg.get(name, "")
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return raw


def body_of(msg):
    """Prefer text/plain; fall back to text/html as-is."""
    plain, html = None, None
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        charset = part.get_content_charset() or "utf-8"
        text = payload.decode(charset, errors="replace")
        if ctype == "text/plain" and plain is None:
            plain = text
        elif ctype == "text/html" and html is None:
            html = text
    return plain if plain is not None else (html or "")


def known_ids():
    ids = set()
    for d in DIRS:
        path = os.path.join(DATA, d)
        if os.path.isdir(path):
            for f in os.listdir(path):
                if f.endswith(".json"):
                    ids.add(f[:-5])
    return ids


def write_record(record):
    dest = os.path.join(DATA, "inbox", record["id"] + ".json")
    fd, tmp = tempfile.mkstemp(dir=os.path.join(DATA, "inbox"), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(record, f, indent=2, ensure_ascii=False)
    os.chmod(tmp, 0o660)
    os.replace(tmp, dest)


def main():
    with open(CONF) as f:
        conf = json.load(f)
    match_to = conf.get("match_to", "").lower()
    seen = known_ids()

    box = imaplib.IMAP4_SSL(conf["host"], conf.get("port", 993))
    box.login(conf["user"], conf["password"])
    box.select(conf.get("folder", "INBOX"))
    status, data = box.search(None, "UNSEEN")
    if status != "OK":
        sys.exit(f"IMAP search failed: {status}")

    new = 0
    for num in data[0].split():
        status, fetched = box.fetch(num, "(RFC822)")
        if status != "OK" or not fetched or fetched[0] is None:
            continue
        msg = email.message_from_bytes(fetched[0][1])

        mid = msg.get("Message-ID", "").strip()
        if not mid:  # rare, but be deterministic anyway
            mid = f"{msg.get('From','')}|{msg.get('Date','')}|{msg.get('Subject','')}"
        rid = hashlib.sha256(mid.encode()).hexdigest()[:16]

        # Routing rule: if match_to is set, skip mail not addressed to it.
        if match_to:
            addressed = " ".join(
                msg.get(h, "") for h in ("To", "Cc", "Delivered-To", "X-Original-To")
            ).lower()
            if match_to not in addressed:
                box.store(num, "+FLAGS", "\\Seen")
                continue

        if rid not in seen:
            write_record({
                "id": rid,
                "from": hdr(msg, "From"),
                "subject": hdr(msg, "Subject"),
                "date": hdr(msg, "Date"),
                "body": body_of(msg),
                "thread": msg.get("In-Reply-To", "").strip() or mid,
            })
            seen.add(rid)
            new += 1
        box.store(num, "+FLAGS", "\\Seen")

    box.logout()
    if new:
        print(f"wrote {new} new message(s) to inbox/")


if __name__ == "__main__":
    main()
