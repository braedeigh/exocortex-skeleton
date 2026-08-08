#!/usr/bin/env python3
"""Hourly sync of the journal-card mirror in exo.db (see cardstore.py) — and
the mouth of the capture-integrity alarm.

Two jobs in one call:
  - cardstore.sync() — walk the vault's card pool into the cards/card_tags
    tables so the SQL console is never staler than an hour.
  - shout if anything is MISSING — a card that vanished from disk with no
    entry in the pool's deletion cast is silent loss, the one failure the
    capture architecture promises can't happen. It gets an unmissable marker
    line in this cron's log and a nonzero exit; the row also stays in the
    table (`missing_since`) so the incident can't be un-noticed even if
    nobody reads the log that hour.

Sits in the crontab behind the :00 vault backup commit, so by the time it
runs, the hour's pool state is also safely in git.

Usage:
    scripts/update_cards.py             # sync for real
    scripts/update_cards.py --rebuild   # wipe and re-derive (schema repair;
                                        # forgets missing-incident rows)
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cardstore                                   # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild", action="store_true",
                        help="wipe and re-derive instead of syncing")
    args = parser.parse_args()

    result = cardstore.rebuild() if args.rebuild else cardstore.sync()
    print(f"update_cards: {result['cards']} cards ({result['new']} new, "
          f"{result['deleted']} deleted-with-cast)")

    if result["missing"]:
        # The loud half. "CARD INTEGRITY" is grep-bait on purpose — nothing
        # else in the logs says it.
        for cid in result["missing"]:
            print(f"CARD INTEGRITY: {cid} vanished from the pool with no "
                  f"deletion cast — silent loss", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
