"""Guard test: the shareable skeleton repo must never carry the owner's real
name, real acquaintances' names, or absolute paths into her private vault/home
dir. This is the repo-wide belt-and-suspenders equivalent of
test_content_scaffold_seed.py's `test_seed_scaffold_source_carries_no_personal_content`
(which checks only the seeded content-scaffold/ tree) -- this one walks every
tracked source/doc file instead.

Uses `git ls-files` (not a filesystem walk) so it only ever inspects files
actually tracked by git -- venv/, node_modules/, frontend/dist/, and anything
gitignored (e.g. CLAUDE.local.md) are automatically out of scope.
"""
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(
    subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True, cwd=Path(__file__).resolve().parent,
    ).stdout.strip()
)

BANNED = ("bradie", "/opt/exocortex/personal", "/home/bradie")

# Paths (relative to repo root) exempt from the check:
#  - docs/scrub-log/ is a deliberate historical record of what WAS scrubbed
#  - test_content_scaffold_seed.py's banned-strings list is the guard for the
#    seeded scaffold tree specifically, and legitimately quotes the banned
#    strings themselves
#  - this file itself quotes the banned strings
#  - content-scaffold/ is the seed tree shipped to fresh installs, out of scope
#    for this sweep (covered by its own dedicated test)
ALLOWLIST_PREFIXES = (
    "docs/scrub-log/",
    "content-scaffold/",
)
ALLOWLIST_FILES = (
    "tests/test_content_scaffold_seed.py",
    "tests/test_no_personal_strings.py",
)


def _is_allowlisted(rel_path: str) -> bool:
    if rel_path in ALLOWLIST_FILES:
        return True
    return any(rel_path.startswith(prefix) for prefix in ALLOWLIST_PREFIXES)


def _tracked_files():
    result = subprocess.run(
        ["git", "ls-files", "--", "*.py", "*.ts", "*.tsx", "*.md"],
        capture_output=True, text=True, check=True, cwd=REPO_ROOT,
    )
    return [line for line in result.stdout.splitlines() if line]


@pytest.mark.parametrize("rel_path", _tracked_files())
def test_file_carries_no_personal_strings(rel_path):
    if _is_allowlisted(rel_path):
        pytest.skip(f"allowlisted: {rel_path}")

    full_path = REPO_ROOT / rel_path
    if not full_path.is_file():
        pytest.skip(f"not a regular file: {rel_path}")

    text = full_path.read_text(encoding="utf-8", errors="ignore").lower()
    for needle in BANNED:
        assert needle not in text, f"{needle!r} found in {rel_path}"
