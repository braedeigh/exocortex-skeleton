"""Recordings routes — the shelf for audio recordings and their transcripts.

A recording is one captured thing: a training session, a doctor's appointment,
a lecture, a voice memo. Each one can carry an audio file, a transcript, or
both — neither is required, so a transcript with no audio (someone sent you the
text) and audio with no transcript (recorded now, transcribed later) are both
first-class.

WHERE THE PIECES LIVE, and why they're split:
  - ``recordings.json`` (the store layer, SQL-backed) holds only METADATA —
    title, date, kind, source, tags, notes, and the filenames of the attached
    files. Small, diffable, cheap to list.
  - ``store.RECORDINGS_DIR`` holds the BULK — the audio blobs and the full
    transcript text, one loose file each. A transcript is tens of kilobytes and
    audio is megabytes; putting either in the JSON collection would bloat every
    read of the list and every line of the git mirror.
That split is why listing recordings never touches transcript text: the list
endpoint returns metadata plus a short preview, and the full text is a separate
fetch per recording.

Identity is by stable ``id`` (uuid hex), never by title — two trainings can
share a name.

Files are named ``<slug-of-title>-<id6>.<ext>`` so the directory stays browsable
by a human poking around the vault, but nothing ever *resolves* a file by
parsing that name: the metadata record is the only index.

Talks to: store.py (the collection + RECORDINGS_DIR), server.py (registers this
module's routes; its before_request gate is what keeps all of this private —
none of these paths are in public_config.PUBLIC_PATHS).

Prompt that produced it: "Needing somewhere in the exocortex to store
transcripts and audio recordings. Please make one."
"""
import re
import uuid
from datetime import datetime
from pathlib import Path

from flask import request, jsonify, send_from_directory

import store

# What we'll accept as audio. Deliberately a floor, not a taxonomy: phones and
# recorders emit all of these, and the browser's <audio> plays most of them.
AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".aac", ".ogg", ".oga", ".opus",
              ".webm", ".flac", ".amr", ".3gp", ".mp4", ".aiff", ".caf"}
# Transcripts arrive as plain text far more often than anything structured.
TRANSCRIPT_EXTS = {".txt", ".md", ".vtt", ".srt", ".json", ".csv"}

# The kinds she's likely to capture. Free text still stores fine (_coerce_kind
# falls back to "other" only for the empty string) — this list drives the
# picker's chips, it isn't a lock on the data.
KINDS = ("training", "meeting", "appointment", "lecture", "interview",
         "conversation", "voice-memo", "other")

# How much transcript text rides along in the list response. Enough to
# recognize a recording at a glance, small enough that a hundred of them is
# still a small payload.
PREVIEW_CHARS = 400
# Snippet window either side of a search hit.
SNIPPET_PAD = 120


def _load():
    return store.read("recordings.json", {"items": []})


def _find(data, rec_id):
    return next((r for r in data.get("items", []) if r.get("id") == rec_id), None)


def _slugify(s):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower())
    return s.strip("-")[:40] or "recording"


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _coerce_kind(value):
    s = str(value or "").strip().lower()
    return s or "other"


def _coerce_tags(value):
    """Accept a list or a comma-separated string; dedupe, keep order."""
    if isinstance(value, list):
        parts = [str(v).strip() for v in value]
    else:
        parts = [p.strip() for p in str(value or "").split(",")]
    out = []
    for p in parts:
        if p and p not in out:
            out.append(p)
    return out


def _rec_dir():
    """Resolve fresh each call so tests (and an env re-point) are honored, and
    create on demand — a fresh install has no recordings dir until the first
    upload."""
    d = store.RECORDINGS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_file(rec, ext, data, *, kind):
    """Save one attachment's bytes/text and return its file record. `kind` is
    'audio' or 'transcript' and only affects the filename suffix, so the two
    attachments of one recording never collide."""
    fname = f"{_slugify(rec.get('title'))}-{rec['id'][:6]}-{kind}{ext}"
    path = _rec_dir() / fname
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        store.write_text_file(path, data)
    return {"filename": fname, "bytes": path.stat().st_size, "added_at": _now()}


def _delete_file(fileref):
    if not fileref:
        return
    target = _rec_dir() / fileref.get("filename", "")
    # Guard against a metadata record carrying a path rather than a bare name —
    # everything under this dir is deletable, nothing above it should be.
    if target.parent.resolve() != _rec_dir().resolve():
        return
    if target.exists():
        target.unlink()


def read_transcript(rec):
    """Full transcript text for one recording, or "" if it has none / the file
    went missing (a vault restored without RECORDINGS_DIR shouldn't 500)."""
    ref = rec.get("transcript")
    if not ref:
        return ""
    path = _rec_dir() / ref.get("filename", "")
    try:
        return path.read_text()
    except OSError:
        return ""


def _text_stats(text):
    return {"chars": len(text), "words": len(text.split()),
            "lines": len(text.splitlines())}


def _save_transcript_text(rec, text, ext=".txt"):
    """Replace a recording's transcript with `text`, cleaning up the old file
    when the extension changes (otherwise it's overwritten in place)."""
    old = rec.get("transcript")
    ref = _write_file(rec, ext, text, kind="transcript")
    if old and old.get("filename") != ref["filename"]:
        _delete_file(old)
    ref.update(_text_stats(text))
    rec["transcript"] = ref
    return ref


def _summarize(rec):
    """The list-response shape: everything except the transcript body, plus a
    short preview of it so a card can show what's inside without a second
    request per recording."""
    out = dict(rec)
    if rec.get("transcript"):
        text = read_transcript(rec)
        out["transcript"] = dict(rec["transcript"])
        out["transcript"]["preview"] = text[:PREVIEW_CHARS].strip()
        # Compare against the UNstripped slice: `.strip()` can shorten the
        # preview on its own, which would flag a short transcript as truncated.
        out["transcript"]["truncated"] = len(text) > PREVIEW_CHARS
    return out


def _sorted(items):
    """Newest first by the recording's own date, undated last; created_at
    breaks ties so same-day captures stay in capture order (newest first)."""
    return sorted(
        items,
        key=lambda r: (r.get("date") or "", r.get("created_at") or ""),
        reverse=True,
    )


# Plain-string fields settable straight off a request on add/update.
_TEXT_FIELDS = ("date", "source", "notes", "duration")


def _apply_fields(rec, get):
    """Copy the editable fields off a request onto `rec`. `get(key)` returns
    None for a key the caller didn't send, so an update only touches what it
    was actually given — the same partial-patch contract as /api/media/update."""
    title = get("title")
    if title is not None and title.strip():
        rec["title"] = title.strip()
    for k in _TEXT_FIELDS:
        v = get(k)
        if v is not None:
            rec[k] = v.strip()
    kind = get("kind")
    if kind is not None:
        rec["kind"] = _coerce_kind(kind)
    tags = get("tags")
    if tags is not None:
        rec["tags"] = _coerce_tags(tags)


def _form_getter(form):
    return lambda k: form.get(k)


def _json_getter(body):
    def get(k):
        if k not in body:
            return None
        v = body[k]
        return v if isinstance(v, list) else str(v if v is not None else "")
    return get


def _body():
    """The JSON body, or {} — never a 400. `request.json` RAISES when the
    Content-Type isn't application/json, which turns a client sending a bare
    POST into an unhelpful 415 instead of this module's own "Not found" /
    "Empty title" errors."""
    return request.get_json(silent=True) or {}


def register(app):

    @app.route("/api/recordings")
    def list_recordings():
        """Every recording, newest first, metadata + transcript preview."""
        data = _load()
        return jsonify({
            "items": [_summarize(r) for r in _sorted(data.get("items", []))],
            "kinds": list(KINDS),
        })

    @app.route("/api/recordings/<rec_id>")
    def get_recording(rec_id):
        """One recording WITH its full transcript text — what the reader view
        fetches when a card is opened."""
        rec = _find(_load(), rec_id)
        if not rec:
            return jsonify({"error": "Not found"}), 404
        out = dict(rec)
        out["transcript_text"] = read_transcript(rec)
        return jsonify({"recording": out})

    @app.route("/api/recordings/add", methods=["POST"])
    def add_recording():
        """Create a recording. Multipart so audio and/or a transcript file can
        ride along with the fields; a JSON body works too when there's nothing
        to upload (transcript text can be pasted straight into `transcript_text`
        either way)."""
        is_form = bool(request.form) or bool(request.files)
        get = _form_getter(request.form) if is_form else _json_getter(_body())

        title = (get("title") or "").strip()
        if not title:
            return jsonify({"error": "Empty title"}), 400

        rec = {
            "id": uuid.uuid4().hex[:12],
            "title": title,
            "date": datetime.now().strftime("%Y-%m-%d"),
            "kind": "other",
            "source": "",
            "notes": "",
            "duration": "",
            "tags": [],
            "audio": None,
            "transcript": None,
            "created_at": _now(),
        }
        _apply_fields(rec, get)

        try:
            audio = request.files.get("audio")
            if audio and audio.filename:
                rec["audio"] = _attach_audio(rec, audio)
            tfile = request.files.get("transcript")
            if tfile and tfile.filename:
                _attach_transcript_file(rec, tfile)
            else:
                text = get("transcript_text")
                if text:
                    _save_transcript_text(rec, text)
        except ValueError as e:
            _delete_file(rec.get("audio"))
            _delete_file(rec.get("transcript"))
            return jsonify({"error": str(e)}), 400

        with store.mutate("recordings.json", {"items": []}) as data:
            data.setdefault("items", []).append(rec)
        return jsonify({"ok": True, "recording": _summarize(rec)})

    @app.route("/api/recordings/update", methods=["POST"])
    def update_recording():
        """Patch metadata (and optionally the transcript text) on one
        recording. Only the keys present in the body are touched."""
        body = _body()
        rec_id = body.get("id")
        get = _json_getter(body)
        # Note on the early `return`s inside every `store.mutate` block below:
        # returning is a NORMAL exit, so the block commits — but on each of
        # those paths `data` is untouched, so the commit rewrites the identical
        # document. Harmless. Only an exception rolls back, and nothing here
        # mutates-then-bails.
        with store.mutate("recordings.json", {"items": []}) as data:
            rec = _find(data, rec_id)
            if not rec:
                return jsonify({"error": "Not found"}), 404
            _apply_fields(rec, get)
            if "transcript_text" in body:
                text = body.get("transcript_text") or ""
                if text.strip():
                    _save_transcript_text(rec, text)
                else:
                    _delete_file(rec.get("transcript"))
                    rec["transcript"] = None
            rec["last_edited"] = _now()
            out = _summarize(rec)
        return jsonify({"ok": True, "recording": out})

    @app.route("/api/recordings/remove", methods=["POST"])
    def remove_recording():
        """Delete a recording and both of its files. Destructive and
        unrecoverable — the UI confirms before calling this."""
        rec_id = _body().get("id")
        with store.mutate("recordings.json", {"items": []}) as data:
            rec = _find(data, rec_id)
            if not rec:
                return jsonify({"error": "Not found"}), 404
            _delete_file(rec.get("audio"))
            _delete_file(rec.get("transcript"))
            data["items"] = [r for r in data["items"] if r.get("id") != rec_id]
        return jsonify({"ok": True})

    @app.route("/api/recordings/<rec_id>/audio", methods=["POST"])
    def attach_audio(rec_id):
        """Attach (or replace) the audio file on an existing recording."""
        f = request.files.get("audio")
        if not f or not f.filename:
            return jsonify({"error": "No audio file"}), 400
        with store.mutate("recordings.json", {"items": []}) as data:
            rec = _find(data, rec_id)
            if not rec:
                return jsonify({"error": "Not found"}), 404
            old = rec.get("audio")
            try:
                ref = _attach_audio(rec, f)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            if old and old.get("filename") != ref["filename"]:
                _delete_file(old)
            rec["audio"] = ref
            rec["last_edited"] = _now()
        return jsonify({"ok": True, "audio": ref})

    @app.route("/api/recordings/<rec_id>/audio/remove", methods=["POST"])
    def remove_audio(rec_id):
        with store.mutate("recordings.json", {"items": []}) as data:
            rec = _find(data, rec_id)
            if not rec:
                return jsonify({"error": "Not found"}), 404
            _delete_file(rec.get("audio"))
            rec["audio"] = None
            rec["last_edited"] = _now()
        return jsonify({"ok": True})

    @app.route("/api/recordings/<rec_id>/transcript", methods=["POST"])
    def attach_transcript(rec_id):
        """Set the transcript from an uploaded file (multipart `transcript`) or
        from pasted text (JSON `text`)."""
        f = request.files.get("transcript")
        with store.mutate("recordings.json", {"items": []}) as data:
            rec = _find(data, rec_id)
            if not rec:
                return jsonify({"error": "Not found"}), 404
            try:
                if f and f.filename:
                    ref = _attach_transcript_file(rec, f)
                else:
                    text = _body().get("text") or ""
                    if not text.strip():
                        return jsonify({"error": "No transcript"}), 400
                    ref = _save_transcript_text(rec, text)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            rec["last_edited"] = _now()
        return jsonify({"ok": True, "transcript": ref})

    @app.route("/api/recordings/search")
    def search_recordings():
        """Full-text across every transcript — the reason the transcripts are
        worth storing at all. Reads each transcript file per request: fine at
        this corpus size, and the seam to move behind SQLite FTS when it isn't."""
        q = (request.args.get("q") or "").strip()
        if not q:
            return jsonify({"query": "", "results": []})
        needle = re.compile(re.escape(q), re.IGNORECASE)
        results = []
        for rec in _sorted(_load().get("items", [])):
            text = read_transcript(rec)
            hits = list(needle.finditer(text))
            if not hits:
                continue
            snippets = []
            for m in hits[:5]:
                start = max(0, m.start() - SNIPPET_PAD)
                end = min(len(text), m.end() + SNIPPET_PAD)
                snip = text[start:end].replace("\n", " ").strip()
                if start > 0:
                    snip = "…" + snip
                if end < len(text):
                    snip += "…"
                snippets.append(snip)
            results.append({
                "id": rec["id"], "title": rec.get("title", ""),
                "date": rec.get("date", ""), "kind": rec.get("kind", ""),
                "count": len(hits), "snippets": snippets,
            })
        results.sort(key=lambda r: r["count"], reverse=True)
        return jsonify({"query": q, "results": results})

    @app.route("/recordings/audio/<path:filename>")
    def serve_recording_audio(filename):
        """Stream one audio file. Auth-gated by the before_request gate in
        server.py (not a PUBLIC_PATH). conditional=True is what makes the
        <audio> scrubber work: Werkzeug answers Range requests, so seeking a
        long recording doesn't re-download it from the start."""
        return send_from_directory(str(_rec_dir()), filename, conditional=True)


def _attach_audio(rec, f):
    ext = Path(f.filename).suffix.lower()
    if ext not in AUDIO_EXTS:
        raise ValueError(f"Unsupported audio format: {ext or '(none)'}")
    fname = f"{_slugify(rec.get('title'))}-{rec['id'][:6]}-audio{ext}"
    path = _rec_dir() / fname
    f.save(str(path))
    return {"filename": fname, "bytes": path.stat().st_size,
            "original_name": f.filename, "added_at": _now()}


def _attach_transcript_file(rec, f):
    ext = Path(f.filename).suffix.lower()
    if ext not in TRANSCRIPT_EXTS:
        raise ValueError(f"Unsupported transcript format: {ext or '(none)'}")
    raw = f.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
    ref = _save_transcript_text(rec, text, ext)
    ref["original_name"] = f.filename
    return ref
