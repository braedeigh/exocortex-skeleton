"""The frontend-to-backend seam, against a tiny hand-built app tree.

Plain English: apiseam.py answers "which route module does this frontend file
call?" — the one edge codegraph.py can't draw by reading imports, because a
React file names a URL string instead of importing anything. These tests build
a small pretend app whose right answer is known, and pin the four things that
decide whether the edge is trustworthy: a path written inline, a path written
for the file by a shared endpoint helper, a path that is only mentioned in a
comment, and a call nothing registers.

Touches: apiseam.py.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import apiseam     # noqa: E402


def write(root, relative, text):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture
def app_tree(tmp_path):
    """A five-file pretend app: two route modules, a shared endpoints client,
    and the frontend files that reach them each of the two ways."""
    write(tmp_path, "routes/todos.py",
          '@app.route("/api/todos")\ndef todos(): ...\n'
          '@app.route("/api/todos/<todo_id>", methods=["POST"])\ndef one(): ...\n')
    write(tmp_path, "routes/habits.py",
          '@app.route("/api/habits/log")\ndef log(): ...\n')
    write(tmp_path, "frontend/src/api/endpoints.ts",
          "export const logHabit = () => api.post('/api/habits/log');\n")
    write(tmp_path, "frontend/src/features/todos/TodoCard.tsx",
          "const rows = api.get('/api/todos');\n"
          "const save = (id) => api.post('/api/todos/' + id);\n")
    write(tmp_path, "frontend/src/features/habits/HabitCard.tsx",
          "import { logHabit } from '../../api/endpoints';\n"
          "export function HabitCard() { return logHabit(); }\n")
    return tmp_path


def edges_by_source(root, known_paths=None):
    return {(src, dst): symbols for _repo, src, _dst_repo, dst, _kind, symbols
            in apiseam.seam_edges("skeleton", root, known_paths)}


def test_a_path_written_inline_reaches_its_route_module(app_tree):
    edges = edges_by_source(app_tree)
    assert ("frontend/src/features/todos/TodoCard.tsx", "routes/todos.py") in edges


def test_a_path_written_by_a_shared_helper_is_followed(app_tree):
    """The file names no path of its own — without following endpoints.ts it
    would look like it has no backend at all."""
    edges = edges_by_source(app_tree)
    assert ("frontend/src/features/habits/HabitCard.tsx", "routes/habits.py") in edges


def test_one_edge_per_pair_carries_every_path(app_tree):
    """Two calls into the same module are one edge with two symbols, matching
    how the import edges record the names crossing them."""
    edges = edges_by_source(app_tree)
    symbols = edges[("frontend/src/features/todos/TodoCard.tsx", "routes/todos.py")]
    assert symbols == '["/api/todos", "/api/todos/"]'


def test_a_path_only_mentioned_in_a_comment_is_not_a_call(app_tree):
    write(app_tree, "frontend/src/features/notes/NoteCard.tsx",
          "// this page used to hit /api/todos before the rewrite\n"
          "export function NoteCard() { return null; }\n")
    sources = {src for src, _dst in edges_by_source(app_tree)}
    assert "frontend/src/features/notes/NoteCard.tsx" not in sources


def test_a_call_nothing_registers_draws_no_edge(app_tree):
    """No agreement, no guess — a wrong module is worse than a short list."""
    write(app_tree, "frontend/src/features/ghost/GhostCard.tsx",
          "const x = api.get('/api/nowhere/at/all');\n")
    sources = {src for src, _dst in edges_by_source(app_tree)}
    assert "frontend/src/features/ghost/GhostCard.tsx" not in sources


def test_a_test_file_is_not_the_apps_wiring(app_tree):
    write(app_tree, "frontend/src/features/todos/TodoCard.test.tsx",
          "it('calls', () => api.get('/api/todos'));\n")
    sources = {src for src, _dst in edges_by_source(app_tree)}
    assert "frontend/src/features/todos/TodoCard.test.tsx" not in sources


def test_an_edge_needs_a_destination_that_was_actually_walked(app_tree):
    """Same rule the import edges follow: no dot on the map, no rope to it."""
    kept = edges_by_source(app_tree, known_paths={"routes/habits.py"})
    assert {dst for _src, dst in kept} == {"routes/habits.py"}
    # endpoints.ts writes the path itself, so it is a caller in its own right
    # alongside the feature file that imports its helper.
    assert {src for src, _dst in kept} == {
        "frontend/src/api/endpoints.ts",
        "frontend/src/features/habits/HabitCard.tsx"}


def test_a_repo_with_no_frontend_draws_nothing(tmp_path):
    """The vault is walked by the same builder and simply has neither half."""
    write(tmp_path, "scripts/thing.py", "print('hi')\n")
    assert apiseam.seam_edges("personal", tmp_path) == []


# --- the walk: a file reaches what the names it imports reach ------------------

@pytest.fixture
def hook_tree(app_tree):
    """The pretend app plus a feature whose data hooks live in their own
    module, the way most pages here are built: the page names no path itself."""
    write(app_tree, "frontend/src/features/todos/api.ts",
          "export function useTodos() { return api.get('/api/todos'); }\n"
          "export function useHabitLog() { return logHabit(); }\n")
    write(app_tree, "frontend/src/features/todos/TodosPage.tsx",
          "import { useTodos } from './api';\n"
          "export function TodosPage() { return useTodos(); }\n")
    write(app_tree, "frontend/src/routes/todos.tsx",
          "import { TodosPage as Page } from '../features/todos/TodosPage';\n"
          "export const Route = createFileRoute('/todos')({ component: Page });\n")
    return app_tree


def test_a_page_reaches_the_routes_its_imported_hook_calls(hook_tree):
    reach = apiseam.file_reach(hook_tree)
    assert reach["frontend/src/features/todos/TodosPage.tsx"] == {"routes/todos.py": ["/api/todos"]}


def test_only_the_imported_name_is_followed_not_its_whole_module(hook_tree):
    reach = apiseam.file_reach(hook_tree)
    assert "routes/habits.py" not in reach["frontend/src/features/todos/TodosPage.tsx"]


def test_the_walk_keeps_going_through_a_chain_of_imports(hook_tree):
    reach = apiseam.file_reach(hook_tree)
    assert reach["frontend/src/routes/todos.tsx"] == {"routes/todos.py": ["/api/todos"]}


def test_a_re_export_hands_on_what_the_original_reaches(hook_tree):
    write(hook_tree, "frontend/src/features/todos/index.ts",
          "export { useTodos } from './api';\n")
    write(hook_tree, "frontend/src/features/Other.tsx",
          "import { useTodos } from './todos';\nexport function Other() { return useTodos(); }\n")
    reach = apiseam.file_reach(hook_tree)
    assert reach["frontend/src/features/Other.tsx"] == {"routes/todos.py": ["/api/todos"]}


def test_an_import_cycle_ends(hook_tree):
    write(hook_tree, "frontend/src/features/a.ts",
          "import { b } from './b';\nexport function a() { return b(); }\n")
    write(hook_tree, "frontend/src/features/b.ts",
          "import { a } from './a';\nexport function b() { a(); return api.get('/api/todos'); }\n")
    reach = apiseam.file_reach(hook_tree)
    assert reach["frontend/src/features/a.ts"] == {"routes/todos.py": ["/api/todos"]}
