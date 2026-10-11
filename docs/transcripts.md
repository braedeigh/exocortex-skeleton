# Transcripts — anyone's chatbot history, sorted by topic

A standalone tool meant to ship beside Terrain. Someone downloads their history
from ChatGPT or Claude.ai, brings the file in, and gets every message drawn as a
pond (by day and hour, like the journal's pond) with the conversations filed
under topics by **their own** AI subscription.

## The pieces, in the order data flows

| Step | File | What it does |
|---|---|---|
| Read | `transcript_import.py` | One small reader per export format, each turning it into the same shape: conversations of `{role, text, at}` messages. |
| Keep | `transcriptstore.py` | `transcripts.db`: conversations, messages, topics, the links between them, a full-text index. |
| Sort | `scripts/sort_transcripts.py` | Batches of unfiled conversations to the model; files each under 1–3 topics, reusing existing ones. |
| Ask | `llm.py` | The one door AI calls go through: `ask(prompt)` → text, `status()` → signed in or not. |
| Serve | `routes/transcripts.py` | `/api/transcripts/*`: import, overview, pond cards, one conversation, start a sort. |
| Show | `frontend/src/features/transcripts/` | The pond page at `/transcripts`. |

## Decisions worth knowing

- **Its own database file, not exo.db.** exo.db is the owner's record with one
  shared migration ladder. The organizer has to work for someone who has no
  exo.db, and what it holds is *their* history. Same precedent as `commons.db`.
  Because of that its tables are not in `table_notes.json` or on the Terrain
  table map.
- **Topics are invented, not picked from a list.** A stranger's chats have no
  preset vocabulary. The sorter shows the model the busiest existing topics and
  tells it to reuse one whenever it fits; that's what keeps the list from
  splintering into near-duplicates.
- **Reading never needs a login.** Import and the pond work with no AI at all;
  only sorting does. The page says where to sign in rather than hiding the
  button. That's the "don't gate first launch behind login" rule from the
  shipping plan.
- **Same pond, not a copy.** The page draws with the journal pond's own layout
  code (`pond/pondMath.ts`: `layoutPond`, `threadLine`, `POND_ZOOMS`,
  `fitZoom`) and its stylesheet. Messages are shaped as pond cards: `who` is
  `B` for the user and `K` for the chatbot, `tags` are the conversation's
  topics as `t<id>`.
- **Times become days in the server's local zone.** Right for a desktop install
  (the server *is* the user's machine); a hosted install would show the host's
  zone.

## Adding a chatbot or an AI provider

- **A new export format** is a new `read_<name>()` in `transcript_import.py`
  plus a line in `read_conversations()` that recognises it by its keys. Nothing
  downstream changes.
- **A new AI provider** (Codex, Gemini CLI, Ollama) is one class in `llm.py`
  with `ask()` and `status()`, one entry in `PROVIDERS`, and
  `EXOCORTEX_LLM_PROVIDER=<name>` to switch to it.

## Where the export formats are guessed

Neither company publishes a spec; the readers follow public write-ups
(2026-09). Guesses are marked in `transcript_import.py`'s header: which ChatGPT
`content_type`s carry readable text, and Claude.ai's `content` blocks as a
fallback for empty `text`. The test samples in `tests/fixtures/transcripts/`
are made up. The first real export run through it is the real test.
