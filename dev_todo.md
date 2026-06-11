# Build TODO

## Movement tab
- [ ] Habit → routine deep-link: tap a habit (e.g. an evening stretch habit) and jump straight to its routine in the Movement tab. Deferred — decide the interaction (▶ icon on the habit row, scroll-to-routine on open). Tab + data model already built.

## Infrastructure
- [ ] Back up Claude session transcripts to the exocortex laptop. Transcripts live in `~/.claude/projects/` on the VPS (~136 MB, outside both git repos so the hourly `git_backup.sh` cron doesn't catch them). Auto-delete now disabled (`cleanupPeriodDays: 3650`), but they're still single-copy on the VPS. Plan: sync to the laptop. Contains personal content — keep off the public skeleton repo.
