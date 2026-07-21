#!/usr/bin/env python3
"""One-shot migration for the ecosystem map's honesty cleanup (Terra/Spark, 2026-06).

Three fixes, per Terra's read:
  1. Stamp `geo_source` (placed / proxy / guess) on every row — the new axis that
     keeps a USDA commodity dot from masquerading as a factual placement.
  2. Dedupe county FIPS (e.g. broccoli carried 06053 four times).
  3. Recompute the dot anchor (lat/lng) for `counties` rows from the actual county
     outlines — fixing stale centroids that landed in the wrong state (milk → Utah).

Prints a before/after diff for every row. Pass --apply to write; default is a dry run.
"""
import json
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
DATA = os.environ.get("EXOCORTEX_DATA_DIR")
if not DATA:
    sys.exit("set EXOCORTEX_DATA_DIR to the data dir this migration should touch")
ECO = os.path.join(DATA, "ecosystem.json")
GEOJSON = os.path.join(SKELETON, "static/vendor/geo/us-counties.geojson")


def classify_geo_source(s):
    """Which honest placement bucket a legacy row falls in."""
    kind = s.get("area_kind")
    if s.get("precision") == "area" and kind == "counties":
        return "proxy"   # came from USDA "where this commodity is grown"
    if s.get("precision") == "point" and s.get("transparency") == "disclosed":
        return "placed"  # a named, confirmed origin (e.g. Lundberg Richvale)
    return "guess"       # a hand circle, a whole-state hunch, an undisclosed point


def _coords_iter(geom):
    """Yield (lng, lat) pairs from a Polygon or MultiPolygon."""
    t = geom.get("type")
    if t == "Polygon":
        rings = geom.get("coordinates", [])
    elif t == "MultiPolygon":
        rings = [r for poly in geom.get("coordinates", []) for r in poly]
    else:
        rings = []
    for ring in rings:
        for pt in ring:
            yield pt[0], pt[1]


def bbox_center(features):
    """Center of the combined bounding box (mirrors Leaflet getBounds().getCenter(),
    which is what the live UI uses when it fits county shapes)."""
    xs, ys = [], []
    for f in features:
        for lng, lat in _coords_iter(f.get("geometry", {})):
            xs.append(lng); ys.append(lat)
    if not xs:
        return None
    return (min(ys) + max(ys)) / 2.0, (min(xs) + max(xs)) / 2.0


def main():
    apply = "--apply" in sys.argv
    with open(ECO) as fh:
        data = json.load(fh)
    by_fips = {}
    with open(GEOJSON) as fh:
        for f in json.load(fh)["features"]:
            by_fips[f["id"]] = f

    changed = 0
    for s in data["sources"]:
        before = json.dumps({k: s.get(k) for k in ("geo_source", "counties", "lat", "lng")}, sort_keys=True)
        notes = []

        # 1. geo_source
        if not s.get("geo_source"):
            s["geo_source"] = classify_geo_source(s)
            notes.append(f"geo_source → {s['geo_source']}")

        # 2. dedupe FIPS (order-preserving)
        if s.get("counties"):
            deduped = list(dict.fromkeys(s["counties"]))
            if len(deduped) != len(s["counties"]):
                notes.append(f"counties {len(s['counties'])} → {len(deduped)} (deduped)")
                s["counties"] = deduped

        # 3. recompute anchor for county rows
        if s.get("area_kind") == "counties" and s.get("counties"):
            feats = [by_fips[f] for f in s["counties"] if f in by_fips]
            center = bbox_center(feats)
            if center:
                nlat, nlng = round(center[0], 6), round(center[1], 6)
                if abs(nlat - s.get("lat", 0)) > 0.05 or abs(nlng - s.get("lng", 0)) > 0.05:
                    notes.append(f"anchor ({s.get('lat')}, {s.get('lng')}) → ({nlat}, {nlng})")
                s["lat"], s["lng"] = nlat, nlng

        after = json.dumps({k: s.get(k) for k in ("geo_source", "counties", "lat", "lng")}, sort_keys=True)
        if before != after:
            changed += 1
            print(f"• {s['name']}")
            for n in notes:
                print(f"    {n}")

    print(f"\n{changed} row(s) changed." + ("" if apply else "  (dry run — pass --apply to write)"))
    if apply:
        with open(ECO, "w") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        print(f"Wrote {ECO}")


if __name__ == "__main__":
    main()
