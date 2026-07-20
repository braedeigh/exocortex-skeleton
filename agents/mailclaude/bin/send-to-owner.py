#!/usr/bin/env python3
# Origin: personal vault mailclaude/bin/ (owner-named original file,
# renamed send-to-owner.py during migration). Scrubbed modular copy —
# plug-in points marked PLUG-IN(...)
"""Send every draft in data/drafts/ to the owner, then move it to data/sent/.
Runs as `mailer` via mail-send.timer. Stdlib only.

INVARIANT: the recipient is a literal constant set at deploy time (see
PLUG-IN below). It is never read from config, the draft record, or a
per-request value. A fully hijacked clerk can still only email the owner.
Do not make this configurable at runtime (e.g. from the draft record).
"""
import os

# PLUG-IN(OWNER_EMAIL): the only address this bot will ever send to. Set via
# env var at deploy time, or hardcode a literal constant here — either way,
# keep it out of config files and draft records so a compromised clerk can't
# redirect mail.
TO = os.environ.get("MAILCLAUDE_OWNER_EMAIL", "<OWNER_EMAIL>")

import json
import re
import smtplib
import sys
from datetime import datetime, timezone
from email.message import EmailMessage

# PLUG-IN(SRV_DIR): base install directory. Default matches install.sh and the
# systemd units below; override with MAILCLAUDE_BASE if you relocate the tree
# (you must also update the systemd units and clerk/.claude/settings.json).
BASE = os.environ.get("MAILCLAUDE_BASE", "/srv/mailclaude")
DRAFTS = os.path.join(BASE, "data", "drafts")
SENT = os.path.join(BASE, "data", "sent")
CONF = os.path.join(BASE, "secrets", "smtp.json")


def connect(conf):
    port = conf.get("port", 587)
    if port == 465:
        s = smtplib.SMTP_SSL(conf["host"], port, timeout=30)
    else:
        s = smtplib.SMTP(conf["host"], port, timeout=30)
        s.starttls()
    s.login(conf["user"], conf["password"])
    return s


def compose(conf, rec):
    subject = re.sub(r"^(re:\s*)+", "", rec.get("subject", ""), flags=re.I).strip()
    msg = EmailMessage()
    msg["From"] = conf.get("from", conf["user"])
    msg["To"] = TO
    msg["Subject"] = f"[mail-claude] Re: {subject or '(no subject)'}"
    quoted = "\n".join("> " + line for line in rec.get("body", "").splitlines())
    msg.set_content(
        f"{rec['draft']}\n\n"
        f"---- original message ----\n"
        f"From: {rec.get('from', '?')}\n"
        f"Date: {rec.get('date', '?')}\n"
        f"Subject: {rec.get('subject', '')}\n\n"
        f"{quoted}\n"
    )
    return msg


def main():
    with open(CONF) as f:
        conf = json.load(f)
    pending = sorted(f for f in os.listdir(DRAFTS) if f.endswith(".json"))
    if not pending:
        return

    smtp = connect(conf)
    for name in pending:
        path = os.path.join(DRAFTS, name)
        with open(path) as f:
            rec = json.load(f)
        if not rec.get("draft"):
            print(f"skipping {name}: no draft field", file=sys.stderr)
            continue
        try:
            smtp.send_message(compose(conf, rec))
        except Exception as e:  # leave in drafts/; the timer retries
            print(f"send failed for {name}: {e}", file=sys.stderr)
            continue
        rec["sent_at"] = datetime.now(timezone.utc).isoformat()
        with open(path, "w") as f:
            json.dump(rec, f, indent=2, ensure_ascii=False)
        os.replace(path, os.path.join(SENT, name))
        print(f"sent {name} to {TO}")
    smtp.quit()


if __name__ == "__main__":
    main()
