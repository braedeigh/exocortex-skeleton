#!/usr/bin/env python3
"""Draw the live proposals that name a state or province as that region's outline.

What this file does: proposals saved before georegions.py existed were drawn as
a dot and a circle even when their words named a region ("Oruro / Potosí
departments", "Sinaloa / Sonora"). For each live proposal still drawn as a
circle, this finds the regions its own region_name names (georegions.match)
and, if any (and not far bigger than its circle — georegions.regions_for),
switches it to those outlines via proposalstore.set_regions. Only
the drawing changes; the claim and its check are left alone. Safe to re-run:
a proposal already drawn as counties or regions is skipped.

    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data venv/bin/python3 scripts/backfill_proposal_regions.py [--dry-run]

Needs the outlines built first: scripts/build_georegions.py.

Touches: georegions.py, proposalstore.py.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import georegions  # noqa: E402
import proposalstore  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print what would change")
    args = parser.parse_args()
    changed = 0
    for proposal in proposalstore.live():
        if proposal["area_kind"] != "circle":
            continue
        regions = georegions.regions_for(proposal["country"], proposal["region_name"],
                                         radius_km=proposal["radius_km"] or 0)
        if not regions:
            continue
        names = ", ".join(r["name"] for r in regions)
        print(f"{proposal['id']:>5}  {proposal['name'][:50]:<50}  → {names}")
        if not args.dry_run and proposalstore.set_regions(proposal["id"], regions):
            changed += 1
    if args.dry_run:
        print("dry run: nothing written")
    else:
        print(f"drew {changed} proposals as regions")


if __name__ == "__main__":
    main()
