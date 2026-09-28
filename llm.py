"""llm.py — the one door the app's AI calls go through: send a prompt, get text back.

What it's for: a feature that needs a model to read something (sort a chat into
topics, write a summary) calls `llm.ask(prompt)` and gets the reply as a string,
without knowing WHICH model or tool answered. `llm.status()` says whether the
current provider is signed in, so a page can offer "sign in to sort" instead of
failing halfway through.

It runs on the user's OWN subscription through a headless command-line tool
(today: Claude Code's `claude -p`), never an API key the app owner pays for.
That's the "bring your own subscription" plan for shipping Terrain.

Adding a provider (Codex, Gemini CLI, a local Ollama) is one more class with
the same two methods — `ask` and `status` — and one entry in PROVIDERS. The
provider in use is picked by the `EXOCORTEX_LLM_PROVIDER` environment variable.
Deliberately thin: no streaming, no tool use, no retries. A caller that needs
more than "prompt in, text out" should grow this when it arrives, not before.

Older callers (recap_summary.py, scripts/sort_bot_chats.py,
scripts/propose_sources.py, scripts/check_proposals.py) still shell out to
`claude` themselves; moving them here is what makes a second provider reach
the whole app.

Touches: nothing in the app — callers import it. Tests: tests/test_llm.py.

Prompt that produced it: "put every AI call behind one small, provider-neutral
seam — take a prompt, return text, report whether it's signed in — with Claude
as the first implementation", so a Codex backend can slot in beside it.
"""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

# Which provider answers, by name. Env-overridable per install.
PROVIDER_ENV = "EXOCORTEX_LLM_PROVIDER"
DEFAULT_PROVIDER = "claude"


class LLMError(RuntimeError):
    """The model couldn't be reached or gave nothing back. Callers catch this
    one exception rather than each provider's own failure types."""


class ClaudeCode:
    """Claude through the Claude Code CLI, signed in with the user's own account.

    `claude -p` reads the prompt on stdin and prints the reply. It runs from the
    home directory so a stray project CLAUDE.md never leaks into the answer."""

    name = "claude"
    # Tiers, not model ids, are what callers ask for — so a caller never has to
    # know one provider's model names.
    MODELS = {"fast": "claude-haiku-4-5", "strong": "claude-sonnet-5"}

    def _binary(self):
        # Find the CLI: an explicit override, the installer's default spot, then PATH.
        configured = os.environ.get("EXOCORTEX_CLAUDE_BIN")
        if configured:
            return configured
        default = Path.home() / ".local" / "bin" / "claude"
        if default.exists():
            return str(default)
        return shutil.which("claude") or "claude"

    def ask(self, prompt, tier, timeout):
        # Run one headless turn and hand back its printed reply.
        try:
            result = subprocess.run(
                [self._binary(), "-p", "--model", self.MODELS.get(tier, self.MODELS["fast"])],
                input=prompt, capture_output=True, text=True, timeout=timeout,
                cwd=str(Path.home()),
            )
        except (subprocess.SubprocessError, OSError) as exc:
            raise LLMError(f"claude could not run: {exc}") from exc
        if result.returncode != 0 or not (result.stdout or "").strip():
            last = (result.stderr or "").strip().splitlines()[-1:] or ["no output"]
            raise LLMError(f"claude exited {result.returncode}: {last[0]}")
        return result.stdout.strip()

    def status(self):
        # Signed in = an API key in the environment, or a login whose refresh
        # half hasn't expired. The credentials file is where `claude /login`
        # keeps it (same file routes/claude_auth.py reads for its countdown).
        if os.environ.get("ANTHROPIC_API_KEY"):
            return {"provider": self.name, "signed_in": True, "detail": "API key"}
        base = os.environ.get("CLAUDE_CONFIG_DIR")
        path = (Path(base) if base else Path.home() / ".claude") / ".credentials.json"
        try:
            oauth = json.loads(path.read_text()).get("claudeAiOauth") or {}
        except (OSError, ValueError, AttributeError):
            return {"provider": self.name, "signed_in": False, "detail": "not signed in"}
        expires = oauth.get("refreshTokenExpiresAt") if isinstance(oauth, dict) else None
        if isinstance(expires, (int, float)) and expires / 1000 < time.time():
            return {"provider": self.name, "signed_in": False, "detail": "login expired"}
        if not oauth:
            return {"provider": self.name, "signed_in": False, "detail": "not signed in"}
        return {"provider": self.name, "signed_in": True, "detail": "subscription"}


PROVIDERS = {"claude": ClaudeCode}


def provider():
    """The provider this install uses, by EXOCORTEX_LLM_PROVIDER (default claude)."""
    name = os.environ.get(PROVIDER_ENV, DEFAULT_PROVIDER)
    if name not in PROVIDERS:
        raise LLMError(f"unknown LLM provider {name!r} — known: {', '.join(PROVIDERS)}")
    return PROVIDERS[name]()


def ask(prompt, *, tier="fast", timeout=180):
    """Send one prompt, return the reply text. Raises LLMError on any failure.
    `tier` is 'fast' (cheap, for sorting and labelling) or 'strong'."""
    return provider().ask(prompt, tier, timeout)


def status():
    """{provider, signed_in, detail} — never raises, so a page can always show it."""
    try:
        return provider().status()
    except LLMError as exc:
        return {"provider": os.environ.get(PROVIDER_ENV, DEFAULT_PROVIDER),
                "signed_in": False, "detail": str(exc)}
