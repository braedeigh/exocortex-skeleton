#!/usr/bin/env python3
"""Split Natural Earth's world states/provinces file into per-country outlines.

What this file does: runs georegions.build(), which reads
`<commons>/natural-earth/ne_10m_admin_1_states_provinces.geojson` (fetched
through scripts/commons_fetch.py) and writes one small outline file per
country, plus a names index, to `<commons>/natural-earth/admin1/`. Those are
derived and rebuildable, so the commons repo ignores them. Run it once after
fetching, and again if the source file is replaced.

    cd <SKELETON_DIR> && EXOCORTEX_DATA_DIR=<VAULT_DIR>/data venv/bin/python3 scripts/build_georegions.py

Touches: georegions.py, commons.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import georegions  # noqa: E402

if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), same as the other
    # standalone scripts.
    import runtime_sensor
    runtime_sensor.attach()
    print(f"wrote {georegions.build()} regions to {georegions.derived_dir()}")
