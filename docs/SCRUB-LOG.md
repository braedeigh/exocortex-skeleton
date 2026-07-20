# Scrub log — master index

Everything migrated from the original author's private vault into this repo was
**scrubbed**: personal values replaced by the placeholder contract in
`docs/PERSONALIZE.md`, each seam marked inline with `PLUG-IN(<KEY>)`. These per-batch
logs record, for every file: where it came from, what *kind* of value was removed
(never the value itself), and how to plug in your own.

- [A — deploy/ops layer](scrub-log/A-deploy-ops.md) — systemd, nginx, cron, ops scripts, full-machine runbook
- [B — cricket swarm](scrub-log/B-crickets.md) — nightly agent roster, runners, prompts
- [C — research pipeline](scrub-log/C-research.md) — the five research role prompts + examples
- [D — app agent workspaces](scrub-log/D-workspaces.md) — person-summary, triage, receipts, recipes
- [E — mailclaude](scrub-log/E-mailclaude.md) — privilege-separated email bot
- [F — personas](scrub-log/F-personas.md) — /thread, /spark, /thistle + example personas

(The journaling engine and `/journalstart`–`/endsession` were migrated earlier, before
this convention existed — their scrub notes live in the batch that shipped them: see
`content-scaffold/` file headers and the "Journaling" section of `INSTALL.md`.)

## Left in the vault on purpose (not migrated)

Architecture-adjacent things that are really personal data. Each batch log has
details; the master list:

- **Runtime logs** (`scripts/*.log`) — operational history, personal content.
- **Deprecated nginx generators** (`setup_nginx/codeserver/filebrowser.sh`) — would
  regress the `auth_request` security fix; the corrected config ships as
  `deploy/nginx-exocortex.conf.template` instead.
- **`gardener-notes.md`** — verbatim personal design conversation.
- **`prompts/shrike.md`** — job-hunt agent; the prompt body is the author's CV. The
  generic pattern (profile doc + search loop + tracker staging through the pending
  queue) is easy to rebuild — see `agents/crickets/_template.md` for the staging shape.
- **The research library** (`research/*.md` except the two shipped examples), receipt
  images, recipe data, people files, journal content — data, not architecture.
- **`dev_todo.md`** — forward-looking specs live with the author; ideas graduate here
  as they're built.
