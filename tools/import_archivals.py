#!/usr/bin/env python3
"""One-shot import: pull the old standalone inventory-app catalog into the
exocortex archivals store.

Fetches every item from the old Render API (the catalog GET is public),
downloads each item's photos into store.ARCHIVALS_DIR, and writes
archivals.json in the exocortex schema. Existing archivals items are kept
unless they came from a previous import run (matched by imported id), so the
script is safe to re-run.

Usage (from /opt/exocortex/skeleton):
    EXOCORTEX_DATA_DIR=/opt/exocortex/personal/data ./venv/bin/python3 tools/import_archivals.py
Then restart: sudo systemctl restart exocortex.service (data only — no restart
actually needed; refresh the page).
"""
import sys
import re
import json
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import store  # noqa: E402

OLD_API = "https://bradie-inventory-api.onrender.com"


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.loads(r.read().decode())


def slugify(s):
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:30] or "item"


def norm_flag(v):
    """Old app stored yes/no-ish strings loosely; normalize to yes/no/''."""
    v = (v or "").strip().lower()
    if v in ("yes", "true", "1", "on"):
        return "yes"
    if v in ("no", "false", "0"):
        return "no"
    return ""


def download_photo(url, fname):
    target = store.ARCHIVALS_DIR / fname
    if target.exists():
        return
    with urllib.request.urlopen(url, timeout=120) as r:
        target.write_bytes(r.read())


def main():
    print(f"Data dir: {store.DATA_DIR}")
    print(f"Photos:   {store.ARCHIVALS_DIR}")
    store.ARCHIVALS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Fetching catalog from {OLD_API} (Render cold start can take ~1 min)...")
    old_items = fetch_json(f"{OLD_API}/")
    print(f"  {len(old_items)} items")

    imported = []
    for n, old in enumerate(old_items, 1):
        item = {
            "id": old["id"],  # keep the old uuid — makes re-runs idempotent
            "name": (old.get("itemName") or "Unnamed").strip(),
            "description": old.get("description") or "",
            "category": (old.get("category") or "").strip().lower(),
            "subcategory": (old.get("subcategory") or "").strip().lower(),
            "origin": old.get("origin") or "",
            "secondhand": (old.get("secondhand") or "").strip().lower(),
            "gifted": norm_flag(old.get("gifted")),
            "private": norm_flag(old.get("private")),
            "private_photos": norm_flag(old.get("privatePhotos")),
            "private_description": old.get("privateDescription") or "",
            "private_origin": old.get("privateOrigin") or "",
            "materials": old.get("materials") or [],
            "photos": [],
            "created_at": (old.get("createdAt") or "")[:10],
        }

        photos = fetch_json(f"{OLD_API}/item/{old['id']}/photos").get("photos", [])
        if not photos and old.get("mainPhoto"):
            photos = [{"id": old["id"][:8], "url": old["mainPhoto"], "position": 0}]
        for p in sorted(photos, key=lambda x: x.get("position") or 0):
            pid = (p.get("id") or "")[:8] or f"p{len(item['photos'])}"
            ext = Path(p["url"].split("?")[0]).suffix.lower() or ".jpg"
            fname = f"{slugify(item['name'])}-{item['id'][:6]}-{pid}{ext}"
            try:
                download_photo(p["url"], fname)
                item["photos"].append({"id": pid, "filename": fname})
            except Exception as e:
                print(f"  ! photo failed for {item['name']}: {e}")

        imported.append(item)
        print(f"  [{n}/{len(old_items)}] {item['name']} ({len(item['photos'])} photos)")

    data = store.read("archivals.json", {"items": []})
    imported_ids = {i["id"] for i in imported}
    kept = [i for i in data["items"] if i.get("id") not in imported_ids]
    data["items"] = kept + imported
    store.write("archivals.json", data)
    print(f"Done: {len(imported)} imported, {len(kept)} existing items kept.")


if __name__ == "__main__":
    main()
