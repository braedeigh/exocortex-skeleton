#!/usr/bin/env python3
"""Retired: the hourly copy of the journal card files into exo.db, and its
missing-card alarm.

The journal moved into the database in November 2026 — see
`docs/journal-database.md`. Cards are written straight into exo.db by
`tools/stream/stream.py`, so there is no second copy to keep in step and
nothing that can go missing from one. What replaced each half:

  - the copy: nothing — the rows ARE the journal now.
  - the alarm: each card's fingerprint (sha256 of who, said_at and body),
    checked by `stream.py validate`; the 24-hour lock triggers in the
    database; and the holding file, where a card the database couldn't take
    waits instead of being lost (`stream.py drain`).

This file stays as a pointer for anyone who finds the old cron line. It does
nothing and exits 0.
"""
import sys

if __name__ == "__main__":
    # On the runtime map like every standalone script (runtime_sensor.py), so
    # anything still calling this pointer shows up there.
    import runtime_sensor
    runtime_sensor.attach()
    print("update_cards.py is retired — the journal lives in exo.db now "
          "(docs/journal-database.md)")
    sys.exit(0)
