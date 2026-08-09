#!/usr/bin/env python3
"""Hourly top-up for the code-history tables in exo.db (see codestore.py).

Two jobs, both incremental-or-cheap:
  - codestore.update()        — index any commits newer than what's stored,
                                across both repos. Milliseconds when nothing
                                landed since last hour.
  - codestore.sync_sessions() — re-derive the sessions / session_files /
                                session_turns tables from the bot_chats
                                sidecars (index, gists, footprints) and the
                                conversation transcripts. Small corpus, full
                                rewrite; the transcript sweep is ~2s.

Terrain also runs update() on its own cache misses, so this cron isn't what
keeps the MAP fresh — it's what keeps the TABLES fresh for the SQL console
and any other reader when nobody has the map open. Sits in the crontab a few
minutes behind extract_footprints (:20), so the session tables it derives are
themselves at most an hour old.

Usage:
    scripts/update_code_history.py             # update for real
    scripts/update_code_history.py --rebuild   # full wipe-and-rewalk instead
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import codestore                                   # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild", action="store_true",
                        help="wipe and re-derive everything instead of topping up")
    args = parser.parse_args()

    if args.rebuild:
        result = codestore.rebuild()
        print(f"update_code_history: full rebuild — {result['commits']} commits, "
              f"{result['files']} files, {result['sessions']} session-file rows, "
              f"{result['turns']} turns")
        return

    indexed = codestore.update()
    sessions = codestore.sync_sessions()
    new = ", ".join(f"{repo}: {n} new" for repo, n in indexed.items())
    print(f"update_code_history: {new}; {sessions['files']} session-file rows and "
          f"{sessions['turns']} turns synced")


if __name__ == "__main__":
    main()
