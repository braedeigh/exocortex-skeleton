"""Photos uploaded in conversation, served back for the journal to show.

When a photo is handed to a conversation it's saved as a timestamped file in
the uploads folder, and the journal card records it as
`[uploaded: /…/uploads/<name>]`. A day later the upload sweep files it into
the uploads archive under the same name (data_helpers.sweep_uploads). So a
name is looked up in both places: the inbox first, then the archive.

  - GET /api/photos/<name>        — the photo itself, full size
  - GET /api/photos/<name>/thumb  — a small JPEG copy for the journal's
                                    thumbnail row

Thumbnails are made the first time they're asked for and kept in
store.THUMB_DIR, a cache that can be deleted at any time. Upload names carry
their own timestamp and are never reused, so browsers may keep both answers
for a year.

Prompt: "every time i've uploaded a photo, i'm wanting them to show up as
clickable thumbnails in the journal ... real small thumbnails, with the option
to click to enlarge."

Touches: `store.py` (UPLOAD_DIR, UPLOAD_ARCHIVE_DIR, THUMB_DIR), and the
journal's `frontend/src/features/journal/photoRefs.ts`, which finds the names
in a card's text.
"""
import os
import re
import tempfile

from flask import abort, send_file

import store

# Only a bare file name with an image ending: no slashes, no leading dot, so a
# request can never reach outside the two upload folders.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp)$", re.IGNORECASE)

# Longest side of a thumbnail, in pixels. Shown at about a third of this, so
# it stays sharp on a phone's high-density screen.
THUMB_PIXELS = 240
_THUMB_QUALITY = 80
_YEAR_SECONDS = 365 * 24 * 3600


def find_photo(name):
    """The file for an upload name, from the inbox or the archive, or None."""
    if not _NAME_RE.match(name):
        return None
    for folder in (store.UPLOAD_DIR, store.UPLOAD_ARCHIVE_DIR):
        path = folder / name
        if path.is_file():
            return path
    return None


def make_thumbnail(source, dest):
    """Write a small JPEG copy of `source` to `dest`.

    Turned upright first: phone photos are often stored sideways with a note
    saying which way is up, and a thumbnail that ignores the note comes out
    on its side. Transparent areas (screenshots, PNGs) sit on white rather
    than turning black. Written to a temp file and swapped in, so a
    half-written thumbnail is never served.
    """
    # Imported here so the rest of the app starts even where Pillow is missing.
    from PIL import Image, ImageOps

    with Image.open(source) as image:
        # For JPEGs, decode at a fraction of full size (the format allows it
        # cheaply): a phone photo is ~12 megapixels and we want a few
        # thousand pixels. A no-op for other formats.
        image.draft("RGB", (THUMB_PIXELS * 2, THUMB_PIXELS * 2))
        image = ImageOps.exif_transpose(image)
        image.thumbnail((THUMB_PIXELS, THUMB_PIXELS))
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            image = image.convert("RGBA")
            flat = Image.new("RGB", image.size, (255, 255, 255))
            flat.paste(image, mask=image.getchannel("A"))
            image = flat
        else:
            image = image.convert("RGB")
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=dest.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                image.save(f, "JPEG", quality=_THUMB_QUALITY, optimize=True)
            os.replace(tmp, dest)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def _off_the_event_loop(work, *args):
    """Run slow picture work on a helper thread, when the server is gevent's.

    The web workers are gevent: one thread juggling every request, so a few
    seconds decoding a big photo would freeze every other page load that
    worker holds. gevent's thread pool runs it alongside instead (Pillow
    lets go of Python's lock while it decodes). Outside gevent, as in tests,
    it just runs.
    """
    try:
        import gevent.monkey
        if gevent.monkey.is_module_patched("threading"):
            import gevent
            return gevent.get_hub().threadpool.apply(work, args)
    except ImportError:
        pass
    return work(*args)


def register(app):

    @app.route("/api/photos/<name>", methods=["GET"])
    def photo_full(name):
        path = find_photo(name)
        if path is None:
            abort(404)
        return send_file(path, conditional=True, max_age=_YEAR_SECONDS)

    @app.route("/api/photos/<name>/thumb", methods=["GET"])
    def photo_thumb(name):
        path = find_photo(name)
        if path is None:
            abort(404)
        # Serve the cached thumbnail, making it first if it's missing. Keyed
        # by name and size, so changing THUMB_PIXELS makes fresh ones.
        thumb = store.THUMB_DIR / f"{name}.{THUMB_PIXELS}.jpg"
        if not thumb.is_file():
            try:
                _off_the_event_loop(make_thumbnail, path, thumb)
            except Exception:
                # Not a readable image after all (corrupt, or a type Pillow
                # can't open): say so without a stack trace in the journal.
                app.logger.warning("photo thumbnail failed for %s", name, exc_info=True)
                abort(415)
        return send_file(thumb, mimetype="image/jpeg", conditional=True, max_age=_YEAR_SECONDS)
