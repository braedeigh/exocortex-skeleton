<!-- Origin: personal vault mailclaude/README.md. Scrubbed modular copy —
     plug-in points marked PLUG-IN(...) -->
# mailclaude — corpus-QA email bot with privilege separation

A self-contained email bot: it polls an inbox over IMAP, hands each new
message to a headless Claude Code "clerk" that answers only from a fixed
corpus of files, and emails the drafted reply to one owner address for
review and manual sending — the bot never sends mail to anyone but the
owner. It runs as three unprivileged Linux users (`mail`, `mailer`,
`mailroom` group) with setgid data directories and a locked-down clerk
permission sandbox, driven by systemd timers/paths.

This folder is a **staging area** — nothing here runs until you copy it to
the target host and run `install.sh`.

```
scp -r agents/mailclaude <APP_USER>@<your-host>:~/mailclaude
```

<!-- PLUG-IN(APP_USER): the Linux user who owns the corpus and clerk
     workspace on the target host — normally whoever operates the bot. -->

Then on the target host, as root, `~/mailclaude/install.sh` creates the
users, the `<SRV_DIR>` tree (default `/srv/mailclaude`), and copies
everything into place. After that:

<!-- PLUG-IN(SRV_DIR): base install directory. The default /srv/mailclaude
     is baked into the systemd units and clerk/.claude/settings.json as a
     literal path — if you relocate the tree, update those files too. -->

1. Fill in `<SRV_DIR>/secrets/imap.json` and `smtp.json` from the
   `.example` templates (as root; the dir is `mailer:mailer 0700`).
2. Add a `Match User mail` ForceCommand block to `/etc/ssh/sshd_config`
   pointing at `<SRV_DIR>/bin/session.sh`, restricting that user to key auth
   only.
3. Log in to Claude Code as the `mail` user (shared subscription auth), and
   accept the trust dialog for `<SRV_DIR>/clerk` — allow rules in
   `clerk/.claude/settings.json` are ignored until the workspace is trusted.
4. `systemctl enable --now mail-poll.timer mail-draft.path mail-send.timer`
5. Run your own network-hardening checklist (VPN/firewall scoping for SSH,
   etc.) before inviting anyone else to use the mailbox.

## What's here

```
install.sh                  # run as root: users, dirs, perms, copy files
bin/session.sh               # SSH ForceCommand target — lands group members in claude
bin/poll-mail.py             # mailer: IMAP → data/inbox/<id>.json
bin/draft-runner.sh           # mail: pending inbox records → claude -p → drafts/
bin/send-to-owner.py         # mailer: drafts/ → email to the owner (pinned) → sent/
clerk/CLAUDE.md               # the clerk's role
clerk/.claude/settings.json   # the clerk's permission sandbox (lock #1 of 2)
systemd/                      # mail-poll.{service,timer}, mail-draft.{service,path},
                               # mail-send.{service,timer}
secrets/*.example             # templates; fill in real credentials only on the target host
```

## The privilege-separation design (the part worth sharing)

Three Linux identities, each able to do only its one job:

- **`mail`** — runs the clerk (`claude -p ...` in `draft-runner.sh`) and is
  the SSH landing user for people who want to talk to the clerk directly.
  Can read the corpus and inbox/drafts data, can only *write* inside
  `data/drafts/` (enforced twice: OS file permissions, and the
  `clerk/.claude/settings.json` allow/deny lists — see below).
- **`mailer`** — the only identity that ever touches network credentials
  (`secrets/imap.json`, `secrets/smtp.json`) or speaks IMAP/SMTP. It never
  runs Claude and never reads the corpus.
- **`mailroom`** (a group, not a user) — the setgid group shared by `data/`
  so that `mail` and `mailer` can hand files to each other (inbox → drafts →
  sent) without either one owning the other's files outright.

Two independent locks keep a compromised or misbehaving clerk from doing
anything beyond drafting a reply:

1. **OS permissions** from `install.sh` — `data/inbox`, `data/sent`,
   `data/failed`, and `corpus/` are not writable by `mail`; only
   `data/drafts/` is.
2. **The clerk's own permission sandbox**, `clerk/.claude/settings.json` —
   denies `Bash`, `WebFetch`, `WebSearch`, and `Edit` outside
   `data/drafts/**` outright, so even if OS permissions were ever
   misconfigured, the clerk's tool use is independently constrained.

`bin/send-to-owner.py` adds a third belt-and-suspenders invariant of its
own: the recipient address is a literal constant, never read from config or
the draft record, so a fully hijacked clerk still can't redirect outbound
mail — see the comment at the top of that file.

## Flow notes (small deltas from the design above, all boring)

- **Inbox files are removed once drafted.** The draft record contains a full
  copy of the inbox record, so after a draft exists the runner deletes the
  inbox file. This lets `mail-draft.path` use `DirectoryNotEmpty=` — inbox
  non-empty simply *means* "work pending".
- **Failures don't spin.** If headless claude exits without producing a
  draft, the runner moves the record to `data/failed/` instead of looping on
  it. Check `data/failed/` occasionally; move a file back to `inbox/` to
  retry.
- **Dedup** checks inbox/drafts/sent/failed by id (= first 16 hex of
  sha256(Message-ID)), and the poller also marks messages `\Seen`, so
  restarts and overlaps are safe.
- **Routing rule:** `imap.json` has an optional `"match_to"` — if set, only
  messages addressed to that alias get picked up (others are marked seen and
  skipped). Leave it out to answer everything in the box.
