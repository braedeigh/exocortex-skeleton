<!-- Origin: no single vault file — this is a new overview doc written for the
     skeleton, synthesizing how personal vault research-runner/, research-worker/,
     research-deep/, research-distiller/, research-filer/ and skeleton
     scripts/research_*.py fit together. No personal content. -->
# Research pipeline — how the pieces fit together

The `/research` page lets the owner hold an ongoing pool of notes, sources,
claims, and questions (`research.json`), then fire off headless Claude Code
agents to work parts of that pool while they're away. This doc is the map;
each piece has its own detailed doc.

<!-- PLUG-IN(OWNER_NAME): the person this pipeline serves.
     PLUG-IN(VAULT_DIR): absolute path to the personal data vault (holds
     data/research.json and the research/ library).
     PLUG-IN(SKELETON_DIR): absolute path to this skeleton checkout. -->

## The five agent roles (this directory)

Each is a Claude Code "skill" folder — a directory containing only a
`CLAUDE.md` that a headless `claude` process reads as its entire job
description when spawned cwd'd into that folder (see `store.py`'s
`RESEARCH_RUNNER_DIR` / `RESEARCH_WORKER_DIR` / `RESEARCH_DEEP_DIR` /
`RESEARCH_DISTILLER_DIR` / `RESEARCH_FILER_DIR`, each overridable via an
`EXOCORTEX_RESEARCH_*_DIR` env var, default `<VAULT_DIR>/<name>/`).

- **`research-runner/`** — batch processor. Fired when the owner sends a
  handful of flagged entries at once; engages each one (answers a question,
  digs into a note, fact-checks a claim, reads a source), leaves one reply
  entry per source entry, then reports and exits. Long-running but not
  single-shot — handles a whole session's worth of entries in one pass.
- **`research-worker/`** — single-shot. One highlighted question in, one
  reply out, then it kills its own tmux session. Used to mimic an
  API-call shape for annotation-batch questions (`routes/research.py`'s
  `/api/research/annotation-batch`), admitted by the dispatcher (below)
  rather than spawned directly, so a burst of questions doesn't OOM the box.
- **`research-deep/`** — the heavyweight: runs the `/deep-research` skill
  (multi-source, verified, cited) on one open question, saves a full
  written report into the research library, and leaves a short digest
  reply pointing at it.
- **`research-distiller/`** — per-topic synthesizer. Reads only
  `"reviewed": true` replies filed under one topic and (re)writes that
  topic's `research/edge/<topic-id>.md` — the settled/shaky/open-edge
  summary the owner reads first when opening the thread. The one file class
  any research agent is allowed to overwrite.
- **`research-filer/`** — housekeeping. Tags entries with an empty
  `topics` list into existing (or, rarely, one new) topic, leaving
  genuinely ambiguous ones unfiled rather than guessing wrong.

All five share one hard rule: **never write `research.json` directly.**
Every mutation goes through `<SKELETON_DIR>/scripts/research_ctl.py` (a
small code-enforced CLI — `reply`, `apply`, `file`, `create-topic`, `close`,
`set-session`), which holds `store.py`'s cross-process file lock and
enforces the same author-boundary rules `routes/research.py` enforces for
UI-driven writes (an `"author": "llm"` entry's `reviewed` field is never
settable by an agent; a question's `status` stays the owner's alone). This
replaces an earlier prompt-only contract — see `research_ctl.py`'s module
docstring for the incident that motivated the code-enforced rewrite.

## The research room (`research-room/`) — where sessions stand now

The sixth folder is not a role but a GROUND. `research-room/CLAUDE.md`
(store.py's `RESEARCH_ROOM_DIR`, env `EXOCORTEX_RESEARCH_ROOM_DIR`, default
`<VAULT_DIR>/research-room/`) is the cwd of every conversation in the
Observatory's `research` lane (`routes/observatory.py`, listed by
`routes/research_room.py` at `GET /api/research-room`, drawn at
`/observatory/research`). Two kinds of session stand there:

- **the owner's own desk session** — opened from the Research door with
  "+ New research session"; the room's CLAUDE.md teaches it the read-only
  query door (`scripts/exo_query.py`) over her tables and the one write door
  (`scripts/research_ctl.py`) into the pool.
- **a dispatched worker or distiller** — since 2026-09-24 these no longer run
  in tmux panes. `scripts/research_dispatcher.py`'s `spawn_worker` mints a
  research-lane conversation stamped `origin: "research"` and
  `research_session_id`, appends the role's CLAUDE.md (worker or distiller)
  as the session's system prompt, and stamps the research session record
  with `conv_id` + `run_id` (`research_ctl.py set-session --conv --run`).
  The run dispatcher starts it through the same runner as any queued
  Observatory turn, and reaps it by the conversation's liveness plus the
  research record's status. `worker_apply_result.py` copies `conv_id` onto
  the reply entry, so a reply, its session, its conversation and its
  run-queue receipt (`usage_ledger.py`: `research_session`, `conv_id`,
  `claude_session`) all point at each other.

The worker and distiller CLAUDE.md files should therefore no longer tell the
agent to kill a tmux session — there isn't one; it just stops.

## research.json — the shared schema

Three top-level lists, read/written only via `store.mutate("research.json", ...)`:

- **`topics`** — `{id, name, status, created}`. Lenses over the pool, not
  boxes: an entry can carry several topic ids, or none (unfiled).
- **`entries`** — `{id, kind, text, topics, url, verdict, status, reply_to,
  created, flagged, processed, author, reviewed, session, file, re_quote,
  context_ids}`. `kind` is one of note / source / claim / question. Entries
  the owner writes have no `author`; agent replies carry `"author": "llm"`
  and start `"reviewed": false` (review is the owner's to give). Entry ids
  are legible timestamp stamps (`YYYY-MM-DD.HHMM`, with a `-2`/`-3` suffix
  on same-minute collisions).
- **`sessions`** — `{id, entry_ids, topics, created, status, report, mode,
  worker, claude_session, claude_cwd, attempts}`. One record per agent run:
  `entry_ids` are the source entries it's working, `status` goes
  queued → running → done/failed, `report` is the one-line summary the UI
  shows. `worker: true` marks a `research-worker`-dispatched session (the
  ones the dispatcher, below, admits by memory budget); runner/deep/filer/
  distiller sessions are spawned directly and aren't dispatcher-managed.

## Wiring: who spawns what

- **runner / deep / filer** are spawned straight from `routes/research.py`'s
  route handlers into a long-lived named tmux session (`"research-runner"`,
  `"research-deep"`, `"research"`) via `shared.ensure_claude_session` +
  `shared.send_prompt` — one shared session per role, reused across fires.
- **worker / distiller** are single-shot and memory-budgeted: a batch or a
  distill request only *queues* a session (`"worker": true`); it's
  `scripts/research_dispatcher.py` that actually spawns the `claude`
  process, one at a time, only when `/proc/meminfo`'s `MemAvailable` has
  headroom (hard cap 3 concurrent, ~450MB budgeted per worker, 1GB kept
  free — each `claude` process runs ~400MB, and spawning a batch of them
  at once used to OOM a small VPS). The dispatcher also recovers worker
  sessions stuck `"running"` behind a dead tmux pane, and is kicked
  event-driven (right after a batch is queued, and right after
  `scripts/worker_apply_result.py` applies a worker's result) rather than
  waiting for the next cron tick.
- **`scripts/worker_apply_result.py`** is the `APPLY` command every worker
  and distiller prompt is handed verbatim — it appends the reply entry,
  marks the question processed (or, for a distill, just closes the
  session), deregisters the worker's terminal tab, and kicks the
  dispatcher, all inside one `store.mutate`.
- **`scripts/research_doctor.py`** is the read-only watchdog: walks
  `research.json` + `annotations.json` + `research_vectors.json` +
  `sessions.json` + the `research/*.md` corpus end to end and reports
  drift no single route would notice on its own (dangling `reply_to`,
  orphaned vectors, a session stuck `"running"` with no tmux behind it,
  illegal verdict/status combinations). `--fix` repairs only the safe
  subset with one obvious correct answer; anything needing judgment is
  report-only forever. `--devnote` posts a `[doctor] ...` summary onto the
  research tab of `dev_notes.json` so a finding actually surfaces.
- **`scripts/populate_research.py`** is a one-shot, idempotent seed script
  — not part of the running pipeline — for bootstrapping `research.json`'s
  topics/anchor-notes/sources/claims from an existing `research/*.md`
  corpus. Dry-run by default (`--apply` to write).

Cron wiring for the dispatcher and doctor lives in
`deploy/crontab.template.txt` (search for "Research worker dispatcher" and
"Research doctor") — both already use the `<VAULT_DIR>` / `<SKELETON_DIR>`
placeholders this doc uses.

## Sample corpus

`agents/research-examples/` holds two saved chat transcripts from the
personal vault's `research/` library, kept as exemplars of the two question
species this pipeline exists to answer: a one-off decision
(`*-mattress-decision.md`) and a reusable-procedure / meta-decision
question (`*-purchase-prioritization.md`). They're real transcripts, not
synthetic samples — useful for seeing the target shape of a saved research
record, not for wiring anything.
