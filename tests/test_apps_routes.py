"""/api/apps (routes/apps.py) — the Terrain's Apps room reads this: each app
with what it's made of, the Based Foods port checklist, and the crossings."""
import pytest
from flask import Flask

import appboundaries
from routes import apps as apps_route


@pytest.fixture
def client(monkeypatch):
    # Finding the real crossings walks the repo; the map's shape is what's
    # under test here, so hand it two.
    monkeypatch.setattr(apps_route, "_crossings", lambda: [
        {"kind": "page", "from": "journal", "to": "/observatory", "from_app": "journal", "to_app": "observatory"},
        {"kind": "import", "from": "x.py", "to": "y.py", "from_app": "journal", "to_app": "finances"},
    ])
    app = Flask(__name__)
    apps_route.register(app)
    return app.test_client()


def test_apps_map_names_every_app_with_its_parts_and_flags_unknown_crossings(client):
    body = client.get("/api/apps").get_json()
    journal = next(a for a in body["apps"] if a["id"] == "journal")
    assert "/terrain/pond" in journal["pages"] and "cards" in journal["tables"]
    assert "cards.py" in journal["routes"]
    known = {c["to"]: c["known"] for c in body["crossings"]}
    # The borrowed session list is in the baseline; the made-up import isn't.
    assert known == {"/observatory": True, "y.py": False}
    statuses = {p["status"] for p in body["based_foods"]["pages"]}
    assert statuses == {"in-based-foods", "to-port", "exocortex-only"} and "foods" in body["based_foods"]["tables"]
    assert "settings.py" in body["shared"]["routes"]
    assert appboundaries.BASED_FOODS == body["based_foods"]["id"]
