"""The page-tag deriver, against a tiny hand-built app tree.

Plain English: derive_page_tags.py answers "which files ARE the Kitchen
page?" by reading the router and following what the page calls. These tests
build a five-file pretend app whose right answer is known, and check the
three things that were actually wrong the first time it ran: a page whose
data hooks live in ANOTHER feature resolved to no backend at all, a room
whose front door is a redirect owned no files, and a path named in a comment
counted as a call.

Touches: scripts/derive_page_tags.py.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import derive_page_tags as deriver     # noqa: E402


def write(root, relative, text):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture
def app_tree(tmp_path):
    """A pretend checkout: two pages, one shared hook module, one sub-room."""
    write(tmp_path, "frontend/src/routes/kitchen.tsx",
          "import { KitchenPage } from '../features/kitchen/KitchenPage';")
    write(tmp_path, "frontend/src/routes/threads.tsx",
          "import { ThreadsPage } from '../features/threads/ThreadsPage';")
    write(tmp_path, "frontend/src/routes/terrain_.usage.tsx",
          "import { UsageRoom } from '../features/terrain/UsageRoom';")
    write(tmp_path, "frontend/src/routes/index.tsx", "export const Route = {};")

    write(tmp_path, "frontend/src/api/endpoints.ts",
          "export function getThreads() { return api.get('/api/threads'); }\n"
          "export function getCards() { return api.get('/api/cards'); }\n")

    write(tmp_path, "frontend/src/features/kitchen/KitchenPage.tsx",
          "const items = api.get('/api/kitchen/items');")
    # The page under test borrows ONE hook from a module that exports several.
    write(tmp_path, "frontend/src/features/threads/ThreadsPage.tsx",
          "// Consumes the roster (GET /api/cards) somewhere else.\n"
          "import { useThreads } from '../journal/useJournalData';\n")
    write(tmp_path, "frontend/src/features/journal/useJournalData.ts",
          "import { getThreads, getCards } from '../../api/endpoints';\n"
          "export function useThreads() { return getThreads(); }\n"
          "export function useCards() { return getCards(); }\n")
    write(tmp_path, "frontend/src/features/terrain/UsageRoom.tsx",
          "const pulse = api.get('/api/usage/pulse');")

    write(tmp_path, "routes/kitchen.py", '@app.route("/api/kitchen/items")\ndef items(): ...\n')
    write(tmp_path, "routes/threads.py", '@app.route("/api/threads")\ndef threads(): ...\n')
    write(tmp_path, "routes/cards.py", '@app.route("/api/cards")\ndef cards(): ...\n')
    write(tmp_path, "routes/usage.py", '@app.route("/api/usage/pulse")\ndef pulse(): ...\n')
    write(tmp_path, "server.py", '@app.route("/api/data/today")\ndef today(): ...\n')
    return tmp_path


def prefixes_for(tree, page):
    return {rule["prefix"] for rule in deriver.rules(tree)
            if rule["tags"][0]["tag"] == page}


def test_page_gets_its_frontend_and_its_backend(app_tree):
    assert prefixes_for(app_tree, "kitchen") == {
        "frontend/src/features/kitchen/",
        "frontend/src/routes/kitchen.tsx",
        "routes/kitchen.py",
    }


def test_borrowed_hook_reaches_the_backend_it_uses(app_tree):
    """The Threads page calls nothing itself — it imports one hook from the
    journal feature. Without following that, the page has no backend."""
    assert "routes/threads.py" in prefixes_for(app_tree, "threads")


def test_borrowing_takes_only_the_symbols_the_page_named(app_tree):
    """useCards sits in the same module but nobody imported it, and the
    `/api/cards` in the comment is not a call. Either one leaking in is how
    every page ends up owning every route module."""
    assert "routes/cards.py" not in prefixes_for(app_tree, "threads")


def test_a_sub_room_is_filed_under_itself_and_its_parent(app_tree):
    """/terrain is a door that redirects, so the room only owns files through
    its sub-rooms."""
    assert "frontend/src/features/terrain/" in prefixes_for(app_tree, "terrain-usage")
    assert "frontend/src/features/terrain/" in prefixes_for(app_tree, "terrain")


def test_the_spine_is_never_tagged(app_tree):
    every_prefix = {rule["prefix"] for rule in deriver.rules(app_tree)}
    assert "server.py" not in every_prefix


def test_page_named_for_the_page_not_the_url():
    """A note carries the page's name; the tag has to match it."""
    assert deriver.page_slugs("todos") == ["today"]
    assert deriver.page_slugs("terrain_.usage") == ["terrain-usage", "terrain"]
    assert deriver.page_slugs("index") == []
    assert deriver.page_slugs("person.$slug") == []


def test_rewriting_keeps_every_other_namespace():
    """tag_rules.json is hers — the page layer is swapped, the front tags she
    wrote are not touched."""
    mixed = {"repo": "skeleton", "prefix": "routes/kitchen.py",
             "tags": [{"ns": "front", "tag": "health"}, {"ns": "page", "tag": "kitchen"}]}
    assert deriver._without_page_tags(mixed)["tags"] == [{"ns": "front", "tag": "health"}]
    only_page = {"repo": "skeleton", "prefix": "x", "tags": [{"ns": "page", "tag": "x"}]}
    assert deriver._without_page_tags(only_page) is None
