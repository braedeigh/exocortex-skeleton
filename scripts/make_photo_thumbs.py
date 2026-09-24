#!/usr/bin/env python3
"""Make the journal's photo thumbnails ahead of time, for every upload.

The server makes a thumbnail the first time the journal asks for it
(routes/photos.py), which is slow for the first look at a day full of photos.
This walks the uploads inbox and archive and makes every thumbnail that's
missing, so the journal never waits. Safe to re-run: existing thumbnails are
skipped, and a file that won't open is reported and skipped.

    EXOCORTEX_DATA_DIR=… ./venv/bin/python3 scripts/make_photo_thumbs.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store  # noqa: E402
from routes import photos  # noqa: E402


def main():
    made = skipped = failed = 0
    for folder in (store.UPLOAD_DIR, store.UPLOAD_ARCHIVE_DIR):
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            if photos.find_photo(path.name) is None:
                continue  # not a photo name (pasted text, a PDF)
            thumb = store.THUMB_DIR / f"{path.name}.{photos.THUMB_PIXELS}.jpg"
            if thumb.is_file():
                skipped += 1
                continue
            try:
                photos.make_thumbnail(path, thumb)
                made += 1
            except Exception as exc:
                failed += 1
                print(f"skipped {path.name}: {exc}", file=sys.stderr)
    print(f"made {made}, already had {skipped}, couldn't read {failed}")


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py), like the other
    # standalone scripts: which of our files actually execute, and which
    # call which.
    import runtime_sensor
    runtime_sensor.attach()
    main()
