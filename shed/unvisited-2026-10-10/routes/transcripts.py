"""Transcripts API — import a chatbot export, sort it into topics, read it as a pond.

The HTTP side of the transcript organizer (design: docs/transcripts.md). Five
endpoints, all under /api/transcripts:

    GET  /overview              counts, every topic with its conversations,
                                the sorter's progress, and whether the AI
                                provider is signed in — everything the page's
                                rail and header need in one read
    GET  /pond?from=&q=         every message as a pond card (the journal
                                pond's card shape), optionally only since a
                                day and only conversations matching a search
    GET  /conversation/<id>     one conversation in full, for the reading panel
    POST /import                a ChatGPT or Claude.ai export (zip or
                                conversations.json) as the multipart field
                                `export`
    POST /sort                  start the sorter in the background; body may
                                carry {"limit": n} to sort only n

Importing and reading never need an AI login — the pond of a raw import is
already worth opening. Only /sort does, and it says so plainly instead of
failing halfway (llm.status()).

The sorter runs as its own process (scripts/sort_transcripts.py), started
detached so it outlives this request and any worker recycle; the page polls
/overview for its progress.

Touches: transcript_import.py (reading exports), transcriptstore.py (all
data), llm.py (sign-in state), scripts/sort_transcripts.py (launched).
Tests: tests/test_transcripts_routes.py.
"""
from pathlib import Path
import os
import subprocess
import sys
import tempfile

from flask import jsonify, request

import llm
import store
import transcript_import
import transcriptstore

SORTER = Path(__file__).resolve().parent.parent / "scripts" / "sort_transcripts.py"


def _start_sorter(limit):
    """Launch the sorter detached, logging beside the database. Separate so tests can swap it."""
    argv = [sys.executable, str(SORTER)] + (["--limit", str(limit)] if limit else [])
    log = open(store.DATA_DIR / "transcripts.sort.log", "a")
    subprocess.Popen(argv, env={**os.environ, "EXOCORTEX_DATA_DIR": str(store.DATA_DIR)},
                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    log.close()


def register(app):

    @app.route("/api/transcripts/overview")
    def transcripts_overview():
        return jsonify({
            "stats": transcriptstore.stats(),
            "topics": transcriptstore.topics(),
            "sort": transcriptstore.sort_status(),
            "llm": llm.status(),
        })

    @app.route("/api/transcripts/pond")
    def transcripts_pond():
        cards, truncated = transcriptstore.pond_cards(
            from_day=request.args.get("from") or None, query=request.args.get("q") or None)
        return jsonify({"cards": cards, "truncated": truncated})

    @app.route("/api/transcripts/conversation/<int:conversation_id>")
    def transcripts_conversation(conversation_id):
        found = transcriptstore.conversation(conversation_id)
        if found is None:
            return jsonify({"error": "No such conversation."}), 404
        return jsonify(found)

    @app.route("/api/transcripts/import", methods=["POST"])
    def transcripts_import():
        # Read the upload from a temp file: an export can be hundreds of MB,
        # and zipfile needs a seekable file rather than a stream.
        upload = request.files.get("export")
        if upload is None or not upload.filename:
            return jsonify({"error": "Choose an export file (the .zip, or conversations.json)."}), 400
        with tempfile.NamedTemporaryFile(suffix=Path(upload.filename).suffix) as tmp:
            upload.save(tmp.name)
            try:
                conversations = transcript_import.read_export(tmp.name)
            except transcript_import.ImportFormatError as exc:
                return jsonify({"error": f"Couldn't read that file: {exc}"}), 400
        counts = transcriptstore.save(conversations)
        return jsonify({"read": len(conversations), **counts})

    @app.route("/api/transcripts/sort", methods=["POST"])
    def transcripts_sort():
        # Refuse up front, with the reason, rather than start a run that fails.
        if transcriptstore.sort_running():
            return jsonify({"error": "A sort is already running."}), 409
        signed = llm.status()
        if not signed["signed_in"]:
            return jsonify({"error": f"Sign in to {signed['provider']} first ({signed['detail']})."}), 400
        if transcriptstore.stats()["unsorted"] == 0:
            return jsonify({"error": "Everything is already sorted."}), 400
        limit = (request.get_json(silent=True) or {}).get("limit")
        _start_sorter(int(limit) if isinstance(limit, int) and limit > 0 else None)
        return jsonify({"started": True})
