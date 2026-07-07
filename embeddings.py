"""OpenAI embedding client — the edge I/O for vector search (→ a thin
async service-client crate, like `anthropic-async`/`exa-async`: one HTTP
call, one normalized response shape, errors as values).

Stdlib urllib only, no new pip deps. `_post_json` is the one seam that
touches the network — tests monkeypatch it directly rather than mocking
urllib guts.

Errors are values: every public function returns
`{"ok": True, ...}` or `{"ok": False, "error": "<code>"}`. Error codes:
`"not_configured"` (no API key), `"http_<status>"` (e.g. `"http_429"`),
`"network"` (couldn't reach the API / unparseable response).
"""
import json
import os
import urllib.error
import urllib.request

MODEL = "text-embedding-3-small"  # 1536 dims
_API_URL = "https://api.openai.com/v1/embeddings"
_TIMEOUT_S = 30
_MAX_CHARS = 8000  # per-text truncation before sending (keeps payloads bounded)


def configured():
    return bool(os.environ.get("OPENAI_API_KEY", "").strip())


def _post_json(url, body, headers):
    """POST `body` as JSON, return the parsed JSON response. Raises
    urllib.error.HTTPError / URLError on failure — callers translate those
    into error-value codes. The one network seam; tests monkeypatch this."""
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def embed_batch(texts):
    """Embed a list of texts in one call. Response `data` rows are sorted by
    `index` before returning, so `vectors[i]` always lines up with `texts[i]`
    regardless of the order the API returns them in."""
    if not configured():
        return {"ok": False, "error": "not_configured"}
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    body = {"model": MODEL, "input": [(t or "")[:_MAX_CHARS] for t in texts]}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        payload = _post_json(_API_URL, body, headers)
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"http_{e.code}"}
    except Exception:
        return {"ok": False, "error": "network"}
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return {"ok": False, "error": "network"}
    try:
        ordered = sorted(data, key=lambda row: row.get("index", 0))
        vectors = [row.get("embedding", []) for row in ordered]
    except Exception:
        return {"ok": False, "error": "network"}
    return {"ok": True, "vectors": vectors}


def embed(text):
    """Single-text convenience over embed_batch."""
    result = embed_batch([text])
    if not result.get("ok"):
        return result
    vectors = result.get("vectors") or []
    if not vectors:
        return {"ok": False, "error": "network"}
    return {"ok": True, "vector": vectors[0]}
