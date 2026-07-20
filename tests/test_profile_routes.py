"""HTTP contract for the owner profile store (routes/profile.py + config.get_profile()).

Mirrors test_devnotes_routes.py's minimal-app pattern. The schema-violation
test also installs schemas.install_error_handler, same as test_schemas.py's
test_route_returns_400_on_schema_violation.
"""
import pytest
from flask import Flask

import store
import schemas
from routes import profile


@pytest.fixture
def client(data_dir):
    app = Flask(__name__)
    app.config.update(TESTING=True)
    profile.register(app)
    schemas.install_error_handler(app)
    return app.test_client()


def read_stored():
    return store.read("profile", {})


# --- GET on a fresh install ---------------------------------------------

def test_fresh_install_returns_defaults_and_empty_stored(client):
    res = client.get("/api/profile")
    assert res.status_code == 200
    body = res.get_json()
    assert body["profile"] == {"owner_name": "", "owner_email": "", "app_name": "Exocortex"}
    assert body["stored"] == {}


# --- PUT partial merge ----------------------------------------------------

def test_put_partial_merge_persists_and_is_reflected_on_get(client):
    res = client.put("/api/profile", json={"owner_name": "Bradie"})
    assert res.status_code == 200
    assert res.get_json()["profile"]["owner_name"] == "Bradie"
    assert read_stored() == {"owner_name": "Bradie"}

    res = client.put("/api/profile", json={"owner_email": "bradie@example.com"})
    assert res.status_code == 200
    body = res.get_json()
    assert body["profile"]["owner_name"] == "Bradie"  # untouched key survives the merge
    assert body["profile"]["owner_email"] == "bradie@example.com"
    assert read_stored() == {"owner_name": "Bradie", "owner_email": "bradie@example.com"}

    res = client.get("/api/profile")
    assert res.get_json()["profile"]["owner_name"] == "Bradie"


def test_put_non_dict_body_is_rejected(client):
    res = client.put("/api/profile", json=["not", "a", "dict"])
    assert res.status_code == 400


# --- PUT "" clears a key back to inherited --------------------------------

def test_put_empty_string_clears_stored_value_back_to_default(client):
    client.put("/api/profile", json={"owner_name": "Bradie"})
    res = client.put("/api/profile", json={"owner_name": ""})
    assert res.status_code == 200
    assert res.get_json()["profile"]["owner_name"] == ""
    assert read_stored()["owner_name"] == ""


def test_put_empty_string_clears_stored_value_back_to_env(client, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_OWNER_NAME", "Env Name")
    client.put("/api/profile", json={"owner_name": "Bradie"})
    res = client.put("/api/profile", json={"owner_name": ""})
    assert res.status_code == 200
    assert res.get_json()["profile"]["owner_name"] == "Env Name"


# --- schema validation at the write seam ----------------------------------

def test_put_invalid_email_returns_400_with_schema_error_shape(client):
    res = client.put("/api/profile", json={"owner_email": "not-an-email"})
    assert res.status_code == 400
    body = res.get_json()
    assert body["collection"] == "profile"
    assert "path" in body
    assert "error" in body
    # the invalid write must not have persisted
    assert read_stored() == {}


# --- precedence: stored (non-empty) > env > default ------------------------

def test_stored_value_wins_over_env(client, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_OWNER_NAME", "Env Name")
    client.put("/api/profile", json={"owner_name": "Stored Name"})
    res = client.get("/api/profile")
    assert res.get_json()["profile"]["owner_name"] == "Stored Name"


def test_env_wins_over_default_when_stored_is_empty(client, monkeypatch):
    monkeypatch.setenv("EXOCORTEX_OWNER_NAME", "Env Name")
    res = client.get("/api/profile")
    assert res.get_json()["profile"]["owner_name"] == "Env Name"
