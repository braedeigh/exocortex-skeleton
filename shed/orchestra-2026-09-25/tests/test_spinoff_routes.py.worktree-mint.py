# Shed 2026-09-25 from tests/test_spinoff_routes.py — see ../SHED.md.
# The fixture's fake_mint (spinoff_client) still exists there; these used it.

# --- the private copy of the checkout (worktrees.py) -------------------------
# Only Orchestra gets one. That room is the unwatched one, and two unwatched
# agents editing one folder is how sessions have twice committed each other's
# half-written files. Coding and Personal are her own hands and need the real
# checkout — it's the one gunicorn serves and the one she refreshes.

def test_an_orchestra_spinoff_is_rooted_in_its_own_worktree(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "isolated")
    body = _post(spinoff_client, "isolated", room="orchestra").get_json()

    assert spinoff_client._mints == ["isolated"]
    entry = _index()[body["conversation_id"]]
    assert entry["cwd"] == body["worktree"]
    assert entry["cwd"] != str(store.BUILD_DIR)
    assert entry["branch"].startswith("agent/isolated-")


def test_her_own_rooms_stay_in_the_real_checkout(spinoff_client):
    """Coding and Personal must keep the live edit-refresh loop — a worktree
    session can't see its change in the browser, and that's the whole reason
    those two rooms exist."""
    for room in ("coding", "personal"):
        _write_brief(store.SPINOFF_DIR, f"hers-{room}")
        body = _post(spinoff_client, f"hers-{room}", room=room).get_json()
        entry = _index()[body["conversation_id"]]
        assert entry.get("worktree") is None
        assert entry["cwd"] == observatory._lane_profile(room)["cwd"]
    assert spinoff_client._mints == []


def test_the_opt_out_keeps_an_orchestra_spinoff_in_the_shared_checkout(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "shared-on-purpose")
    body = _post(spinoff_client, "shared-on-purpose",
                 room="orchestra", worktree=False).get_json()

    assert spinoff_client._mints == []
    assert _index()[body["conversation_id"]]["cwd"] == str(store.BUILD_DIR)


def test_a_rejoin_never_cuts_a_second_worktree(spinoff_client):
    """The bug worth naming: a live spinoff re-opened must not get a fresh
    copy — and must certainly not have its running agent's directory
    re-created underneath it."""
    _write_brief(store.SPINOFF_DIR, "rejoined")
    first = _post(spinoff_client, "rejoined", room="orchestra").get_json()

    again = _post(spinoff_client, "rejoined", room="orchestra").get_json()

    assert again["newly_spawned"] is False
    assert again["conversation_id"] == first["conversation_id"]
    assert spinoff_client._mints == ["rejoined"]


def test_a_spinoff_whose_worktree_fails_still_runs_and_says_so(spinoff_client, monkeypatch):
    """Degraded is still usable — the same call _launch_runner makes — but it
    is never silent: without the flag nobody could tell which sessions are
    sharing a tree, which is the exact thing the copy exists to remove."""
    def boom(slug, base="HEAD"):
        raise spinoff.worktrees.WorktreeError("no space left")
    monkeypatch.setattr(spinoff.worktrees, "mint", boom)
    _write_brief(store.SPINOFF_DIR, "degraded")

    body = _post(spinoff_client, "degraded", room="orchestra").get_json()

    assert body["ok"] is True
    assert "no space left" in body["worktree_failed"]
    entry = _index()[body["conversation_id"]]
    assert entry["cwd"] == str(store.BUILD_DIR)
    assert "no space left" in entry["worktree_failed"]




def test_adoption_without_a_worktree_is_a_caller_bug(spinoff_client):
    _write_brief(store.SPINOFF_DIR, "steward-bare")
    r = _post(spinoff_client, "steward-bare", room="orchestra",
              branch="agent/x", worktree=False)
    assert r.status_code == 400
    assert _index() == {}


