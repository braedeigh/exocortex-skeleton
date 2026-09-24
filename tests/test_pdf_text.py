"""Tests for the PDF-reading layer in paperclients.py (`fetch_pdf_text`,
`fetch_url_text`, `pdftotext_available`) and the fetch-text route feeding a
PDF through docstore.

The network seam is `paperclients._get_bytes`, monkeypatched per test to hand
back a small PDF built right here in the test — a hand-written one-page file
with a single text object, xref table and all, that poppler reads as-is. The
real `pdftotext` binary is used where it matters (skipped if it isn't on the
box); the "binary missing" case points the constant at a name that can't
exist. Nothing here touches the network or a file outside the per-test tmp
DATA_DIR (see conftest.data_dir).
"""
import json

import pytest

from conftest import data_dir  # noqa: F401  (imported for fixture visibility)

import paperclients
import store

needs_pdftotext = pytest.mark.skipif(
    not paperclients.pdftotext_available(), reason="pdftotext binary not installed",
)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(paperclients.time, "sleep", lambda s: None)


def build_pdf(text="Hello research"):
    """A minimal but valid one-page PDF carrying `text` in Helvetica.
    Objects are written in order and their byte offsets recorded so the xref
    table at the end is correct — poppler reads it without complaint."""
    header = b"%PDF-1.4\n"
    content = f"BT /F1 24 Tf 20 60 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(header)
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_offset = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode()
    return bytes(out)


def _fake_get_bytes(monkeypatch, raw, content_type):
    """Patch the network seam to hand back `raw` with `content_type`, honouring
    the byte cap the way the real one does (read one byte past it and stop)."""
    calls = []

    def fake(url, headers=None, max_bytes=None):
        calls.append({"url": url, "headers": headers, "max_bytes": max_bytes})
        body = raw if max_bytes is None else raw[: max_bytes + 1]
        return body, content_type
    monkeypatch.setattr(paperclients, "_get_bytes", fake)
    return calls


# --- the PDF itself -----------------------------------------------------------------

def test_built_pdf_has_magic_and_xref():
    pdf = build_pdf()
    assert pdf.startswith(b"%PDF-")
    assert b"xref" in pdf and pdf.rstrip().endswith(b"%%EOF")


# --- fetch_pdf_text -------------------------------------------------------------------

@needs_pdftotext
def test_fetch_pdf_text_reads_a_pdf(monkeypatch):
    calls = _fake_get_bytes(monkeypatch, build_pdf("Hello research"), "application/pdf")
    text, error = paperclients.fetch_pdf_text("https://example.com/paper.pdf")
    assert error is None
    assert "Hello research" in text
    assert "Mozilla" in calls[0]["headers"]["User-Agent"]
    assert calls[0]["max_bytes"] == paperclients.PDF_MAX_BYTES


def test_fetch_pdf_text_missing_binary(monkeypatch):
    _fake_get_bytes(monkeypatch, build_pdf(), "application/pdf")
    monkeypatch.setattr(paperclients, "PDFTOTEXT_BIN", "/nonexistent/exocortex-no-such-pdftotext")
    assert paperclients.fetch_pdf_text("https://example.com/paper.pdf") == (None, "pdftotext_missing")


def test_fetch_pdf_text_too_large(monkeypatch):
    pdf = build_pdf()
    _fake_get_bytes(monkeypatch, pdf, "application/pdf")
    text, error = paperclients.fetch_pdf_text("https://example.com/paper.pdf", max_bytes=len(pdf) - 1)
    assert (text, error) == (None, "pdf_too_large")


@needs_pdftotext
def test_fetch_pdf_text_exactly_at_cap_is_fine(monkeypatch):
    pdf = build_pdf()
    _fake_get_bytes(monkeypatch, pdf, "application/pdf")
    text, error = paperclients.fetch_pdf_text("https://example.com/paper.pdf", max_bytes=len(pdf))
    assert error is None and "Hello research" in text


@needs_pdftotext
def test_fetch_pdf_text_sniffs_magic_when_content_type_is_wrong(monkeypatch):
    _fake_get_bytes(monkeypatch, build_pdf(), "application/octet-stream")
    text, error = paperclients.fetch_pdf_text("https://example.com/download?id=1")
    assert error is None and "Hello research" in text


def test_fetch_pdf_text_refuses_a_non_pdf(monkeypatch):
    _fake_get_bytes(monkeypatch, b"<html><body>landing page</body></html>", "text/html")
    assert paperclients.fetch_pdf_text("https://example.com/landing") == (None, "not_pdf")


@needs_pdftotext
def test_fetch_pdf_text_garbage_labelled_pdf_is_extract_failed(monkeypatch):
    _fake_get_bytes(monkeypatch, b"%PDF-1.4 this is not really a pdf", "application/pdf")
    assert paperclients.fetch_pdf_text("https://example.com/broken.pdf") == (None, "pdf_extract_failed")


def test_fetch_pdf_text_network_error_is_a_value(monkeypatch):
    import urllib.error

    def boom(url, headers=None, max_bytes=None):
        raise urllib.error.HTTPError("u", 403, "forbidden", {}, None)
    monkeypatch.setattr(paperclients, "_get_bytes", boom)
    assert paperclients.fetch_pdf_text("https://example.com/paper.pdf") == (None, "http_403")


def test_pdftotext_available_follows_the_binary_constant(monkeypatch):
    monkeypatch.setattr(paperclients, "PDFTOTEXT_BIN", "/nonexistent/exocortex-no-such-pdftotext")
    assert paperclients.pdftotext_available() is False


# --- fetch_url_text: one GET, dispatch on what came back -------------------------------

@needs_pdftotext
def test_fetch_url_text_routes_pdf_content_type_to_pdftotext(monkeypatch):
    calls = _fake_get_bytes(monkeypatch, build_pdf(), "application/pdf")
    r = paperclients.fetch_url_text("https://example.com/paper.pdf")
    assert r["ok"] is True and r["kind"] == "pdf"
    assert "Hello research" in r["text"]
    assert len(calls) == 1


@needs_pdftotext
def test_fetch_url_text_sniffs_pdf_magic_under_octet_stream(monkeypatch):
    _fake_get_bytes(monkeypatch, build_pdf(), "application/octet-stream")
    r = paperclients.fetch_url_text("https://example.com/download")
    assert r["ok"] is True and r["kind"] == "pdf"
    assert "Hello research" in r["text"]


def test_fetch_url_text_still_reads_html_pages(monkeypatch):
    html = b"<html><head><title>A Post</title></head><body><p>Body text.</p></body></html>"
    _fake_get_bytes(monkeypatch, html, "text/html; charset=utf-8")
    r = paperclients.fetch_url_text("https://example.com/post")
    assert r == {"ok": True, "title": "A Post", "text": "Body text.", "kind": "page"}


def test_fetch_url_text_keeps_not_html_for_other_binary_types(monkeypatch):
    _fake_get_bytes(monkeypatch, b"PK\x03\x04 zip bytes", "application/zip")
    assert paperclients.fetch_url_text("https://example.com/archive.zip") == {"ok": False, "error": "not_html"}


def test_fetch_url_text_missing_binary_surfaces_real_code(monkeypatch):
    _fake_get_bytes(monkeypatch, build_pdf(), "application/pdf")
    monkeypatch.setattr(paperclients, "PDFTOTEXT_BIN", "/nonexistent/exocortex-no-such-pdftotext")
    assert paperclients.fetch_url_text("https://example.com/paper.pdf") == {"ok": False, "error": "pdftotext_missing"}


# --- the `_get` text seam still sits on top of `_get_bytes` ------------------------------

def test_get_decodes_over_get_bytes(monkeypatch):
    _fake_get_bytes(monkeypatch, "café".encode("utf-8"), "text/plain")
    assert paperclients._get("https://example.com/x") == "café"
    assert paperclients._get("https://example.com/x", want_content_type=True) == ("café", "text/plain")


# --- the route, end to end through docstore --------------------------------------------

def _post(client, path, payload):
    return client.post(path, data=json.dumps(payload), content_type="application/json")


@pytest.fixture
def client(data_dir):
    """A test client for a minimal app exposing only the research-text routes."""
    from flask import Flask
    from routes import research_text
    app = Flask(__name__)
    app.config.update(TESTING=True)
    research_text.register(app)
    return app.test_client()


def _seed_entry(**overrides):
    entry = {
        "id": "2026-09-24.1200",
        "kind": "source",
        "text": "a paper",
        "topics": [],
        "url": "",
        "verdict": "",
        "status": "",
        "reply_to": None,
        "created": "2026-09-24 12:00",
    }
    entry.update(overrides)
    store.write("research.json", {"topics": [], "entries": [entry]})
    return entry


@needs_pdftotext
def test_route_stores_pdf_text_via_docstore(client, monkeypatch, data_dir):
    import docstore
    _seed_entry(url="https://example.com/paper.pdf")
    _fake_get_bytes(monkeypatch, build_pdf("Hello research"), "application/pdf")

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-09-24.1200"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["strategy"] == "pdf"
    assert body["doc"] == "entry:2026-09-24.1200"

    saved_files = list((data_dir / "doc_texts").iterdir())
    assert len(saved_files) == 1
    resolved = docstore.resolve("entry:2026-09-24.1200")
    assert resolved["ok"] is True
    assert "Hello research" in resolved["text"]


@needs_pdftotext
def test_route_reads_the_annotators_pdf_url(client, monkeypatch, data_dir):
    import docstore
    _seed_entry(
        url="https://journal.example.com/landing",
        meta={"pdf_url": "https://oa.example.org/paper.pdf"},
    )
    calls = _fake_get_bytes(monkeypatch, build_pdf("Hello research"), "application/pdf")

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-09-24.1200"})
    assert r.status_code == 200
    assert r.get_json()["strategy"] == "pdf"
    assert calls[0]["url"] == "https://oa.example.org/paper.pdf"
    assert "Hello research" in docstore.resolve("entry:2026-09-24.1200")["text"]


def test_route_reports_missing_binary_and_saves_nothing(client, monkeypatch, data_dir):
    _seed_entry(url="https://example.com/paper.pdf")
    _fake_get_bytes(monkeypatch, build_pdf(), "application/pdf")
    monkeypatch.setattr(paperclients, "PDFTOTEXT_BIN", "/nonexistent/exocortex-no-such-pdftotext")

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-09-24.1200"})
    assert r.status_code == 502
    assert r.get_json()["error"] == "pdftotext_missing"
    assert not (data_dir / "doc_texts").exists()


def test_route_reports_too_large_and_saves_nothing(client, monkeypatch, data_dir):
    _seed_entry(url="https://example.com/huge.pdf")
    _fake_get_bytes(monkeypatch, build_pdf(), "application/pdf")
    monkeypatch.setattr(paperclients, "PDF_MAX_BYTES", 10)

    r = _post(client, "/api/research/entry/fetch-text", {"id": "2026-09-24.1200"})
    assert r.status_code == 502
    assert r.get_json()["error"] == "pdf_too_large"
    assert not (data_dir / "doc_texts").exists()
