"""Behavioral tests for the recordings API (routes/recordings.py).

What's worth pinning here is the SPLIT: metadata lives in the recordings.json
collection, the bulk (audio bytes, transcript text) lives as loose files in
store.RECORDINGS_DIR. Almost every bug this shelf can have is a seam bug between
those two — a file written but not recorded, a record deleted but its megabytes
left behind, a rename that orphans the old transcript. So these tests assert on
BOTH sides after every call: what the collection says, and what's actually on
disk.

The other guarantees under test: identity is by `id` (two trainings can share a
title), update is a partial patch (absent key = untouched), and the list
endpoint never ships full transcript text.
"""
import io
import json

import pytest

import store
from routes import recordings as rec_module


@pytest.fixture
def client(data_dir):
    """Minimal app with only the recordings routes — no server.py startup, no
    auth gate. `data_dir` is what re-points store.RECORDINGS_DIR at tmp_path."""
    from flask import Flask
    app = Flask(__name__)
    app.config.update(TESTING=True)
    rec_module.register(app)
    return app.test_client()


def read_recordings():
    return store.read("recordings.json", {"items": []})


def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload),
                       content_type="application/json")


def _add(client, title="Lab training", **fields):
    r = _post(client, "/api/recordings/add", {"title": title, **fields})
    assert r.status_code == 200, r.get_data(as_text=True)
    return r.get_json()["recording"]["id"]


def _files_on_disk():
    d = store.RECORDINGS_DIR
    return sorted(p.name for p in d.iterdir()) if d.exists() else []


# --- add ---------------------------------------------------------------------

def test_add_requires_a_title(client):
    r = _post(client, "/api/recordings/add", {"title": "   "})
    assert r.status_code == 400
    assert read_recordings()["items"] == []


def test_add_with_no_files_creates_a_bare_recording(client):
    rec_id = _add(client, "Doctor visit", kind="appointment")
    items = read_recordings()["items"]
    assert len(items) == 1
    assert items[0]["id"] == rec_id
    assert items[0]["title"] == "Doctor visit"
    assert items[0]["kind"] == "appointment"
    # Neither attachment is required — that's the whole point of the shelf.
    assert items[0]["audio"] is None and items[0]["transcript"] is None
    assert _files_on_disk() == []


def test_add_with_pasted_transcript_writes_a_file_not_a_blob(client):
    """The text must land on disk, and must NOT be inlined into the collection —
    a 200KB transcript in the JSON would bloat every list read and every line of
    the git mirror."""
    rec_id = _add(client, "Lab training", transcript_text="beads on the magnet")

    rec = read_recordings()["items"][0]
    assert rec["transcript"]["filename"] in _files_on_disk()
    assert rec["transcript"]["words"] == 4
    assert "beads on the magnet" not in json.dumps(rec)   # not inlined

    text = (store.RECORDINGS_DIR / rec["transcript"]["filename"]).read_text()
    assert text == "beads on the magnet"
    assert rec_module.read_transcript(rec) == "beads on the magnet"


def test_add_accepts_multipart_with_audio_and_transcript(client):
    r = client.post("/api/recordings/add", data={
        "title": "Lab training",
        "kind": "training",
        "audio": (io.BytesIO(b"ID3fake-audio-bytes"), "memo.m4a"),
        "transcript": (io.BytesIO(b"down the hatch"), "memo.txt"),
    }, content_type="multipart/form-data")
    assert r.status_code == 200, r.get_data(as_text=True)

    rec = read_recordings()["items"][0]
    assert rec["audio"]["original_name"] == "memo.m4a"
    assert rec["audio"]["bytes"] == len(b"ID3fake-audio-bytes")
    assert (store.RECORDINGS_DIR / rec["audio"]["filename"]).read_bytes() == b"ID3fake-audio-bytes"
    assert rec_module.read_transcript(rec) == "down the hatch"


def test_add_rejects_a_non_audio_upload_and_leaves_nothing_behind(client):
    """A rejected upload must not half-create the recording: no row, no file."""
    r = client.post("/api/recordings/add", data={
        "title": "Lab training",
        "audio": (io.BytesIO(b"nope"), "notes.pdf"),
    }, content_type="multipart/form-data")
    assert r.status_code == 400
    assert "pdf" in r.get_json()["error"]
    assert read_recordings()["items"] == []
    assert _files_on_disk() == []


# --- identity ----------------------------------------------------------------

def test_same_title_recordings_stay_independent(client):
    """Two trainings can share a name; only the id may distinguish them."""
    first = _add(client, "Lab training", transcript_text="part A")
    second = _add(client, "Lab training", transcript_text="part B")
    assert first != second

    _post(client, "/api/recordings/remove", {"id": first})
    items = read_recordings()["items"]
    assert [r["id"] for r in items] == [second]
    assert rec_module.read_transcript(items[0]) == "part B"
    # ...and only the removed one's file is gone.
    assert len(_files_on_disk()) == 1


# --- list --------------------------------------------------------------------

def test_list_previews_the_transcript_instead_of_shipping_it(client):
    long_text = "x" * (rec_module.PREVIEW_CHARS + 50)
    _add(client, "Long one", transcript_text=long_text)

    body = client.get("/api/recordings").get_json()
    t = body["items"][0]["transcript"]
    assert len(t["preview"]) == rec_module.PREVIEW_CHARS
    assert t["truncated"] is True
    assert "transcript_text" not in body["items"][0]


def test_short_transcript_is_not_flagged_truncated(client):
    """`.strip()` shortens the preview on its own — that must not read as
    truncation."""
    _add(client, "Short one", transcript_text="  a few words  ")
    t = client.get("/api/recordings").get_json()["items"][0]["transcript"]
    assert t["truncated"] is False


def test_list_is_newest_first_with_undated_last(client):
    _add(client, "Middle", date="2026-03-01")
    _add(client, "Newest", date="2026-08-01")
    _add(client, "Undated", date="")

    titles = [r["title"] for r in client.get("/api/recordings").get_json()["items"]]
    assert titles == ["Newest", "Middle", "Undated"]


def test_get_one_returns_the_full_transcript_text(client):
    rec_id = _add(client, "Lab training", transcript_text="the whole thing")
    body = client.get(f"/api/recordings/{rec_id}").get_json()
    assert body["recording"]["transcript_text"] == "the whole thing"


def test_get_missing_recording_is_404(client):
    assert client.get("/api/recordings/nope").status_code == 404


# --- update ------------------------------------------------------------------

def test_update_only_touches_the_keys_it_was_given(client):
    rec_id = _add(client, "Lab training", notes="keep me", kind="training")
    _post(client, "/api/recordings/update", {"id": rec_id, "title": "Flex library prep"})

    rec = read_recordings()["items"][0]
    assert rec["title"] == "Flex library prep"
    assert rec["notes"] == "keep me"       # absent key -> untouched
    assert rec["kind"] == "training"


def test_update_rewrites_the_transcript_and_removes_the_stale_file(client):
    """The filename carries a slug of the title, so re-saving after a rename
    writes a NEW file — the old one has to go, or the dir accretes orphans."""
    rec_id = _add(client, "Old title", transcript_text="v1")
    old_name = read_recordings()["items"][0]["transcript"]["filename"]

    _post(client, "/api/recordings/update",
          {"id": rec_id, "title": "New title", "transcript_text": "v2"})

    rec = read_recordings()["items"][0]
    assert rec["transcript"]["filename"] != old_name
    assert rec_module.read_transcript(rec) == "v2"
    assert _files_on_disk() == [rec["transcript"]["filename"]]


def test_update_with_empty_transcript_text_clears_it(client):
    rec_id = _add(client, "Lab training", transcript_text="v1")
    _post(client, "/api/recordings/update", {"id": rec_id, "transcript_text": "   "})

    assert read_recordings()["items"][0]["transcript"] is None
    assert _files_on_disk() == []


def test_update_missing_recording_is_404(client):
    assert _post(client, "/api/recordings/update", {"id": "nope"}).status_code == 404


def test_tags_accept_a_list_or_a_comma_string(client):
    rec_id = _add(client, "Lab training", tags="wgs, flex, sequencing, flex")
    assert read_recordings()["items"][0]["tags"] == ["wgs", "flex", "sequencing"]

    _post(client, "/api/recordings/update", {"id": rec_id, "tags": ["a", "b"]})
    assert read_recordings()["items"][0]["tags"] == ["a", "b"]


# --- attachments -------------------------------------------------------------

def test_attaching_audio_twice_replaces_the_file(client):
    rec_id = _add(client, "Lab training")
    for payload in (b"first-take", b"second-take"):
        r = client.post(f"/api/recordings/{rec_id}/audio", data={
            "audio": (io.BytesIO(payload), "memo.m4a"),
        }, content_type="multipart/form-data")
        assert r.status_code == 200, r.get_data(as_text=True)

    rec = read_recordings()["items"][0]
    assert (store.RECORDINGS_DIR / rec["audio"]["filename"]).read_bytes() == b"second-take"
    assert len(_files_on_disk()) == 1


def test_removing_audio_deletes_the_file_and_keeps_the_transcript(client):
    rec_id = _add(client, "Lab training", transcript_text="still here")
    client.post(f"/api/recordings/{rec_id}/audio", data={
        "audio": (io.BytesIO(b"bytes"), "memo.m4a"),
    }, content_type="multipart/form-data")

    _post(client, f"/api/recordings/{rec_id}/audio/remove", {})

    rec = read_recordings()["items"][0]
    assert rec["audio"] is None
    assert rec_module.read_transcript(rec) == "still here"
    assert _files_on_disk() == [rec["transcript"]["filename"]]


def test_attach_transcript_from_pasted_text(client):
    rec_id = _add(client, "Lab training")
    r = _post(client, f"/api/recordings/{rec_id}/transcript", {"text": "pasted later"})
    assert r.status_code == 200
    assert rec_module.read_transcript(read_recordings()["items"][0]) == "pasted later"


def test_attach_transcript_rejects_an_unsupported_file(client):
    rec_id = _add(client, "Lab training")
    r = client.post(f"/api/recordings/{rec_id}/transcript", data={
        "transcript": (io.BytesIO(b"nope"), "doc.pdf"),
    }, content_type="multipart/form-data")
    assert r.status_code == 400
    assert read_recordings()["items"][0]["transcript"] is None
    assert _files_on_disk() == []


def test_audio_is_served_with_range_support(client):
    """conditional=True is what makes the <audio> scrubber work: without a
    206 on a Range request, seeking re-downloads from the start."""
    rec_id = _add(client, "Lab training")
    client.post(f"/api/recordings/{rec_id}/audio", data={
        "audio": (io.BytesIO(b"0123456789"), "memo.m4a"),
    }, content_type="multipart/form-data")
    fname = read_recordings()["items"][0]["audio"]["filename"]

    r = client.get(f"/recordings/audio/{fname}", headers={"Range": "bytes=2-5"})
    assert r.status_code == 206
    assert r.get_data() == b"2345"


# --- remove ------------------------------------------------------------------

def test_remove_deletes_both_files(client):
    rec_id = _add(client, "Lab training", transcript_text="gone soon")
    client.post(f"/api/recordings/{rec_id}/audio", data={
        "audio": (io.BytesIO(b"bytes"), "memo.m4a"),
    }, content_type="multipart/form-data")
    assert len(_files_on_disk()) == 2

    r = _post(client, "/api/recordings/remove", {"id": rec_id})
    assert r.status_code == 200
    assert read_recordings()["items"] == []
    assert _files_on_disk() == []


def test_remove_missing_recording_is_404(client):
    assert _post(client, "/api/recordings/remove", {"id": "nope"}).status_code == 404


# --- search ------------------------------------------------------------------

def test_search_matches_across_transcripts_with_snippets(client):
    _add(client, "Lab training", transcript_text="put it on the magnet until clear")
    _add(client, "Doctor visit", transcript_text="nothing relevant here")

    body = client.get("/api/recordings/search?q=MAGNET").get_json()
    assert len(body["results"]) == 1
    hit = body["results"][0]
    assert hit["title"] == "Lab training"
    assert hit["count"] == 1
    assert "magnet" in hit["snippets"][0]


def test_search_ranks_by_hit_count(client):
    _add(client, "One hit", transcript_text="beads")
    _add(client, "Three hits", transcript_text="beads beads beads")

    results = client.get("/api/recordings/search?q=beads").get_json()["results"]
    assert [r["title"] for r in results] == ["Three hits", "One hit"]


def test_empty_search_returns_nothing_rather_than_everything(client):
    _add(client, "Lab training", transcript_text="beads")
    assert client.get("/api/recordings/search?q=  ").get_json()["results"] == []


def test_search_query_is_literal_not_a_regex(client):
    """A stray '(' in the box must not 500 the page."""
    _add(client, "Lab training", transcript_text="the P200 (multichannel) tip")
    body = client.get("/api/recordings/search?q=(multichannel)").get_json()
    assert body["results"][0]["count"] == 1


# --- resilience --------------------------------------------------------------

def test_missing_transcript_file_reads_as_empty_not_a_crash(client):
    """A vault restored without RECORDINGS_DIR still has to list."""
    _add(client, "Lab training", transcript_text="here for now")
    fname = read_recordings()["items"][0]["transcript"]["filename"]
    (store.RECORDINGS_DIR / fname).unlink()

    assert client.get("/api/recordings").status_code == 200
    assert rec_module.read_transcript(read_recordings()["items"][0]) == ""


def test_a_post_with_no_body_is_a_clean_404_not_a_415(client):
    """`request.json` raises on a missing Content-Type; this shelf must not."""
    assert client.post("/api/recordings/remove").status_code == 404
