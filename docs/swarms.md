# Swarms, self-continuing sessions, and token accounting — the plan

Built on the agent mailbox ([`peers.md`](peers.md)). This file is the design
and the decisions behind it; each stage links back here as it lands. Status
lines say what exists *now*.

## Decisions (from the owner)

- **Soft context caps, per model.** Opus 500k tokens, Fable 700k (her
  numbers, raised 2026-10-07 from 200k / 500k); Sonnet 150k and Haiku 100k
  (chosen modestly, no owner number yet). A session that
  crosses its cap is **not interrupted** — it finishes the work it's on, and
  the handoff happens when that turn ends.
- **Only the Coding room continues itself unsupervised.** Other rooms never
  auto-continue.
- **A swarm is defined by interaction, not assignment.** Two or more sessions
  where each has talked with at least one other member (a connected group in
  the `agent_messages` graph). Not everyone has to have talked to everyone.
- **Talking means a back-and-forth.** Two sessions are linked only when
  there have been at least three messages between them, at least one each
  way: a message, an answer and a follow-up (`swarms.LINK_MESSAGES`). A
  one-off heads-up about a shared file links no one, whether or not it got a
  "thanks". Her calls: "both ways" (2026-10-07), then the three-message rule
  (2026-10-08) — of 143 past pairs, 23 were exactly a heads-up and a reply. A
  session and its continuations are one sender toward the three, so an answer
  from the session that took over counts (`swarms.links`) — but only the
  sessions that sent or received a message themselves are linked. Members a
  swarm already had before this rule stay until they are released:
  membership only grows.
- **Continuations connect on their own** (2026-10-23, her reading confirmed).
  After a handoff the old session keeps its place in its swarm. The
  continuation joins only if it takes part itself: one of the messages sent or
  received by it, or two shared files changed by it (`file_alerts` rows are
  credited to `conv_a`/`conv_b`, the sessions that changed the files, not the
  whole line). A silent continuation works alone. Before this, every handoff
  carried its parent's links forward, which is half of how swarm 16 grew to
  68 member rows. One gap: a file pair is written down once per pair of lines,
  so a continuation that shares only files its parent was already alerted on
  doesn't connect by files. `room_helper.clusters` still unions continuations
  (it's only a view), moves still take a whole line of work, and closing still
  counts lines.
- **Hubs don't glue** (2026-10-23). A line of work in back-and-forth with
  `swarms.HUB_LINES` (four) or more other lines is a hub (`swarms.hubs`):
  its messages link nobody, its shared files still do. That's a project-level
  coordinator — the Linear keeper that messaged every Based Foods session, a
  planner handing out briefs — and through it every session it talks to
  became one swarm. Her call: automatic, plus a manual override both ways,
  `scripts/room_moves.py hub <conv> on|off|auto --reason "…"` (the
  `swarm_hubs` table; `hubs` lists them). Every message counts toward being a
  hub, placements or not.
- **Nobody leaves for being idle.** Her words (2026-10-14): "I don't want
  things idle over 24 hours removed. If something had the number of messages
  already making a swarm, keep it in the swarm." No dormancy rule.
- **Or keeping to the same files.** Two sessions that never wrote to each
  other are linked too when both have changed two or more of the same files
  (`swarms.LINK_FILES`), each within the file-alert window — the `same-file`
  rows `file_alerts.py` writes. Her call (2026-10-08): a swarm also forms "if
  they are continuously working on things in the same files". One shared
  file isn't enough, and sharing the checkout or the project isn't either:
  nearly every Coding session works in the one repo.
- **No topics inside a swarm.** Sub-swarms by topic were built on 2026-10-07
  (the room helper sorted a swarm's members into named topics, each with its
  own summary) and removed the next day at her word, once the linking rule
  was made strict enough to keep unrelated sessions out in the first place.
  A swarm that still holds unrelated work is the room helper's to split.
- **A swarm is at least two sessions still working, plus its helper.** Her
  words: "i don't necessarily want a swarm to be just 1 agent and the helper.
  i want a swarm to be a minimum of 2 sessions and a helper." Counted in
  *lines of work*: a session and its continuations are one, finished members
  (done, archived, handed on) and helpers don't count (`swarms.live_lines`).
  Below two, the swarm is closed (below) and its one working session stands
  in the room as working alone. The room helper won't form a swarm from
  fewer than two working lines; a split or release that leaves one behind
  closes the old swarm, says so in the move, and tells that session.
- **One helper per swarm**, running Sonnet. It names the swarm (its own
  "project"), keeps one current summary per member and one for the swarm,
  notices where members' work differs or collides, and coordinates. Its
  summaries are **replaced, not accumulated**: each update is a fresh call that
  sees only the latest summaries plus what's new, so its context never grows.
  Every summary is a few short **labelled lines**, not a paragraph — a
  session's is "Now / Done / Waiting on", the swarm's "Goal / Where it stands /
  Next / Waiting on" — and the code cuts anything longer before storing it
  (`swarm_helper.tidy_summary`), so they can't grow run after run. Her ask:
  "Make the helper summaries more separated and succinct ... They're too long.
  Labeled lines." `swarm_helper.py reshape <id>` rewrites a swarm's stored
  summaries into that shape without waiting for new activity.
- **One helper chat for the swarm's whole life.** The owner's chat with the
  helper is never handed off or archived while the swarm is active. Each turn
  in it is a fresh model session, seeded with **exactly three things** (her
  spec, 2026-10-01): (1) **a doc** — that the chat is rolling and it gets only
  the last 15 exchanges, its job, where to search the rest (every transcript,
  `peers.py show`, `exo_query.py` over `swarms` / `agent_messages` /
  `tool_calls`, git), and inside it her **standing rules** and its open
  watches; (2) **her last `HELPER_CHAT_EXCHANGES` (15) messages to it, each
  with its reply**, whole — only turns she started count, so a wake-up, a
  watch or an agent's mail is neither counted nor replayed; (3) **one entry
  per active session** — its summary (one summarizer call per session, run
  side by side), every file it has edited and every file it has read, for its
  whole life (`edited_files.edits` / `reads`; shell commands are caught only
  when they name the file, so the lists are incomplete and the seed says so).
  Helper sessions are never listed. There is no chat summary: nothing retells
  the chat, and no model is called when a helper's turn ends. Only what the
  model is handed rolls; the full transcript stays on disk. The chat is exempt
  from the context cap.
- **Her standing rules.** The one thing that survives the roll: a short list
  of her lasting instructions to a helper, in her exact words with the date —
  `<data dir>/helper_rules/room-<room>.md` or `swarm-<id>.md`, a markdown file
  she can open and edit (a rule is a line starting `- `). The helper adds one
  with `scripts/helper_rule.py add "<her words>"` (`list`, `drop <n>`) only
  when she says something meant to last; the helper gate lets that write
  through. Nothing writes to it on its own.
- **She can see what a helper is working from, and edit her rules for it.**
  Her ask: "some kind of option to edit the rolling context directly or at
  least see what is in the rolling context for a room helper", and on what to
  edit: "the standing rules is the part that should be edited." Every helper
  has a context page (`/observatory/context/<helper>`; the "context" button
  in its chat, and a link on its swarm's page). It shows the seed its last
  turn was handed, part by part, as the model reads it — `write_seed` keeps
  the parts beside the seed (`<conv>.parts.json`) — and can build the seed as
  it would be this minute (seconds of work; nothing is written and it doesn't
  count as the helper having seen anything). Each rule is a row with Edit and Delete
  buttons, with "Add a rule" under the list ("I want edit buttons for the
  rules"); the whole file in one text box is folded away beneath. A change
  is refused when the rules changed since the page loaded them (the helper
  added one meanwhile), so neither edit wipes the other. The other parts are rebuilt every turn and are not editable.
- **A helper is woken when what it watches changes** (`helper_chat.wake_tick`,
  the minute tick). Every seed records what the helper was shown of each
  session (`bot_chats/helper_seed/<conv>.seen.json`); the tick compares the
  sessions now against it. `config.HELPER_WAKE_ON`: `new-or-files` (default —
  a session has a new summary and is new to the helper or has edited a file
  it hadn't edited before), `new-or-any-files` (a newly read file counts too —
  about as often as every summary), `summary`, `edit`, or `off`. At most one wake-up per
  `HELPER_WAKE_MIN_SEC` (300), every change since its last turn folded into
  one System message; a handoff is the same line of work, not a new session.
  The helper may stay silent: it replies with exactly `(nothing to say)`, the
  chat page leaves that turn out (`events.ts`, `silent`), and its card's "last
  active" time is put back so no unread dot lights. The transcript keeps every
  line.
- **Finished members drop out of the helper's view after a day.** Her ask: "drop
  off done/retired sessions from your checking after 24 hours." A member that
  is finished (the same rule as retiring, below) and whose last activity, done
  mark or archiving is over `config.SWARM_HELPER_FORGET_HOURS` (24) old is left
  out of the summarizer's runs and the chat seed (`swarms.in_helper_view`). It
  stays a member: the pages, the network drawing and the closing check still
  count it, and the chat seed names it in one line so it can still be looked up.
- **Old helper sessions are out of the helper's view entirely.** Her ask: "for
  the helper session, i don't want it to read and receive summaries from the
  retired helpers anymore." A helper could once be handed off, and its
  successor ("Swarm helper · … (cont.)") has no role, so an agent messaging it
  made it a member. `swarms.is_helper_session` recognises a helper or any
  continuation of one; `in_helper_view` leaves those out (not even named), and
  the summarizer's "Messages between members" leaves out their messages. They
  stay members for the pages and the closing check.
- **A closing summary and a closing check when the swarm retires.** A swarm
  is *retired* when fewer than two of its lines of work are still going — the
  rest done (`done_at`), archived, handed on to a continuation, or gone from
  the index, and none of them mid-turn (`swarms.retired`). The helper then
  posts one last message with two halves, and marks itself done; the usual
  two-hour countdown closes it.
  - *The closing summary*, written by the helper's model. Her ask: "when a
    swarm retires, i want a summary of what was done to be written by that
    swarm's helper, which will then be put in the chat and noted ... so i can
    know what was completed and ask it questions about what happened." One
    call per retirement, in a process of its own (`swarm_helper.py close
    <id>`, started by the minute tick). It reads the swarm's last summary,
    every member whenever it finished (its summary, what it said when it
    marked itself done, the end of what it did), the messages between
    members, and the closing check — which it is told is the truth about
    what shipped: it may say something was committed only when a commit
    there shows it.
  - *The closing check*, plain code, built from git and the session records,
    not the agents' word: the commits the members made, files written but not
    committed, members closed without saying they were done (or still
    working, on their own now), questions still waiting on her, detached jobs
    still running. A commit is found two ways, because agents mostly commit
    quietly: git announced it in a tool result, or a repo the session worked
    in holds a commit made in the seconds its `git commit` command ran.
  - *Kept.* Both go into `swarm_closings`, one row per time the swarm closed.
    A swarm that opens again and closes again gets a new row; the earlier ones
    stay, and the new summary is written from the last closing on. The swarm's
    page shows them ("What this swarm did"). A dissolved swarm's rows go with it.
  - *Handed back to the helper.* The closing message is posted on a turn she
    didn't start, so the rolling chat would never replay it. Instead the kept
    summaries (the latest with its closing check) are a part of the helper's
    doc on every later turn (`swarm_helper.closings_text`, the "closings" part
    on its context page), with every member the swarm had named by session id
    — finished members drop out of the helper's view after a day (below), and
    this is how it still finds their transcripts. A run that answers her from
    the swarm page's box reads the same text (`gather`). When a closed
    swarm's helper has answered her, it starts its countdown again
    (`swarm_helper.rest_again`): her message took its done mark off, and a
    helper can't mark itself done.
  - *The room is told.* One line in the room helper's chat: the swarm closed,
    and the summary's one-sentence headline. Tapping the button under the
    line opens the whole summary and its closing check in place
    (`SwarmClosingFold.tsx`, reading `GET /api/swarms/<id>/closings`), with
    buttons to the swarm's helper and its page.
  - *When the summary can't be written* — the model call fails, or the
    closing process dies — the closing check is posted alone, saying why, and
    the row keeps the reason. It is never tried again by itself: one
    retirement, one model call. `swarm_helper.py close <id>` by hand writes a
    closing for a swarm that is closed.
  If two lines of work are going in the swarm again, the helper comes back. A
  closed swarm's helper isn't poked by member turns (`swarm_helper.poke`).
- **A swarm closes when its work is over.** Her ask: "closes swarms on the
  UI when all agents within it are closed", then the two-session minimum
  above. Closed is the retired rule above (fewer than two lines of work
  still going; the swarm's own helper doesn't count), worked out fresh on
  every read, never stored (`swarms.is_closed`) — so a second line of work
  going again, a member or a new session messaging or joining, opens the
  same swarm again by itself.
  `swarms.overview` marks each card `closed`. The rooms, the room map,
  Worktrees and Terrain hide closed swarms unless the shared "Show closed
  swarms" switch is on (`swarmApi.shownSwarms`); a hidden closed swarm's
  members stand in the room as ordinary cards — its finished ones as done
  cards until they close, its one working session as working alone.
  The room helper reads only open swarms and can't join or split into a
  closed one (`room_helper.open_swarms`).
- **Visible everywhere.** A swarm card in its room on the Observatory (summary,
  counts of working / silent / needs input; tap in for the member cards in the
  usual orange / purple / grey), a swarm on the Terrain map, and a helper page
  showing what the helper read, the messages between members, and its
  summaries — with an input box to talk to the helper.

## The room helper

A layer above the swarm helpers: one helper per room (the Coding room only,
for now — `config.ROOM_HELPER_ROOMS`), in `room_helper.py`. Her ask: "a helper
in the coding room at large … reads just the summary of what's going on with
the swarm and the summaries of the single agents and determines if they
should be designated as a swarm … or placed into an existing swarm. It also
can separate out swarms if a cluster is not talking to other clusters anymore
or move solo sessions out of a swarm into the layer above."

- **What it reads.** Summaries only: each swarm's and its members', each
  swarm's *clusters* (worked out in code: who messaged whom within
  `config.ROOM_HELPER_QUIET_HOURS`, plus handoffs, and when each cluster last
  messaged another), and each session working alone (its own summary of it,
  kept in `session_summaries`, plus what's new). And its last ten moves.
- **Which files each open session is editing** (`edited_files.py`), a
  section of its own beside the summaries, in both its runs and its chat. Her
  ask: "all of the files being edited by any agent that's open … so that you
  can direct agents better." Every open session in the room with the files it
  changed in the last `config.ROOM_HELPER_FILES_HOURS`, any file two of them
  touched flagged at the top, and the files git shows changed that no open
  session claims. Read from `tool_calls` (seconds behind for Observatory
  turns). Edit/Write calls are always caught (a failed one is left out); a
  Bash edit is a guess from the command's text, checked against whether the
  file changed afterwards — see the file's top block for exactly what that
  misses and what it can still get wrong.
- **What it does.** Four moves — **form** a swarm from sessions working alone,
  **join** sessions to a swarm, **split** a cluster out of a swarm into its
  own, **release** sessions to work alone. It acts on its own (her decision,
  2026-09-27), conservatively: never splitting clusters that talked within the
  quiet window, never redoing a move she undid.
- **Placements override messages.** Her words: "look at who's connected in
  the current swarm and you'll see what I mean. Spins could lead to
  disconnected swarms." A move is stored as a placement (`swarm_pins`): the
  messages a session exchanged at or before it no longer link it; newer ones
  do, so a released session that starts talking again is pulled back in
  naturally. A session's continuations always move with it.
- **Every move is visible and undoable.** Posted in the room helper's chat
  with its reason and undo line, stored in `room_moves` with what it
  replaced; `scripts/room_moves.py undo <id>` (and `list`, and the four moves
  by hand). Each moved session gets one message, queued for the end of its
  turn — never an interrupt. A join note names the swarm, how many others
  are still working in it and at most three of them; `scripts/peers.py swarm`
  lists the rest (it once listed all seventeen of a big swarm's ids).
- **When it runs.** At the minute tick, at most every
  `config.ROOM_HELPER_MIN_SEC`, only when something in the room happened since.
  One tool-less Sonnet call; every run in `room_helper_runs`.
- **Its chat** works like a swarm helper's (helper_chat.py): fresh every turn,
  with the same three-part seed; its sessions are every open session in the
  room. The room overview (swarms, clusters, recent moves) is what a RUN
  reads; the chat looks those up when it needs them.
- **Watches: promises kept between turns** (`watches.py`, both kinds of
  helper). Her ask: "i need something that alerts you to watch things
  between turns." A helper's chat runs only when a turn starts, so "I'll tell
  you when that session ships" had nothing to wake it. Now it sets a watch
  from its chat (`scripts/helper_watch.py add <session> --on
  done,asked,committed,stalled,error --note "…"`, stored in `helper_watches`;
  the helper gate lets that one write through). The minute tick checks every
  open watch against what the session did *after* the watch was set: marked
  itself done or was closed; filed questions or a sudo card; a `git commit`
  that succeeded; a failed turn; or nothing written for
  `config.HELPER_WATCH_STALLED_MINUTES` (90) while nothing waits on her. A
  watch that fires is marked fired first, then the helper's chat gets one
  System message (the follow-up queue, as a finished detached job does); all
  of one helper's watches firing in the same minute share that message. Each
  fires once, follows its session into a continuation, and is retired after
  `config.HELPER_WATCH_EXPIRE_DAYS` (7) with the helper told. Open watches
  are listed in the helper's seed, and its instructions say to set one with
  every such promise.
- **The room from above** (`RoomMap.tsx`, at the head of any room with a room
  helper). Her ask: "a display on the front with circles for each swarm and
  the generated helpers in the middle and extra agents in rows below that."
  The room helper on top with its last move, each swarm in a circle drawn as
  on its page (`SwarmNetwork.tsx`, its helper in the middle), and the
  sessions working alone in rows beneath. Data: `GET /api/swarms/room/<room>`.

## Project rooms and the project helper

A middle layer between the Coding room and its swarms (2026-10-14 and
10-23). Her words: "maybe we make rooms where swarms can form like based
foods. Swarms could form within the room? based off the room helper? Which
can coordinate with the smaller swarm helpers." Swarm 16 had grown to 68
member rows, "everything Based Foods": it was working as a project room, not
as a few sessions in the same files.

- **What one is** (`project_rooms.py`). A build from the Builds list
  (`buildlist.py`, `terrain_builds.json`) switched on with `"project_room":
  true` (`scripts/room_moves.py project on|off <build id>`). Her call: one
  exists only when switched on, not for every build. Named "project room" in
  code, never "project": `projects.json` already means the code-ownership map.
- **The exocortex itself is not a project.** Sessions in the app checkout or
  the vault stay with the Coding room helper exactly as before.
- **How a session lands in one**, first rule that applies: a placement by
  hand (`room_moves.py project-place <build id|none> <conv>…`, the whole line
  of work); then where it works — most of its places in the build's repo or
  any git worktree of it; then being spun off or continued from a session
  already in the room (a spinoff only while it works nowhere else; a
  continuation always — her words: "they'd probably stay in the same room if
  they connected once in the past"). A place is an Edit/Write file, or the
  folder a Bash command `cd`s into: she approved Edit/Write only, but most
  project sessions edit through Bash (`cd /…/based-foods-x && python3 - <<…`)
  — on 10-23 Edit/Write alone placed 2 of 8 working Based Foods sessions. cwd
  says nothing: they all sit in the app checkout. A worktree is told by its
  `.git` file pointing into the build's `.git/worktrees/`.
- **Membership is stored** (`project_room_members`, rung 59), at most one room
  per session, and only grows, like a swarm's. `project_rooms.sync` is a dry
  pass first and takes the write lock only when someone new lands.
- **A swarm's project** is the room most of its working members are in
  (`project_rooms.swarm_room`).
- **The project helper** is the room helper scoped to one project: role
  `project_helper`, scope `coding:<build id>` everywhere `room_helper.py` takes
  a room (`_scope`). It reads its project's open swarms, clusters and solo
  sessions, makes form / join / split / release moves only inside its
  project (`execute` refuses the rest), and runs on the room helper's pacing
  from the minute tick. Its chat has `PROJECT_LEAD` (helper_chat.py); it may
  message swarm helpers with `peers.py send`, which starts their own run.
  Its rules file is `helper_rules/project-<build id>.md`.
- **The Coding room helper** sees each project room as ONE block in its
  overview (name, the project helper's latest overview line, counts of open
  swarms and working sessions), makes swarm moves only for sessions in no
  project room, and may place sessions into or out of one.
- **Swarm helpers** are unchanged, except that a closing swarm's one line goes
  to its project helper's chat when it belongs to a project room
  (`swarm_helper._tell_room`).
- **Only the closest helper is woken** (`helper_chat.own_sessions`). A member
  of an open swarm wakes only its swarm helper; a session working alone in a
  project wakes only the project helper; anything else wakes the room helper.
  The higher helpers still see those sessions in part 3 of their seed, but get
  no "new / files / asked / error / stalled / finished" wake for them. This is
  what keeps chat turns — the real cost — from tripling.
- **Questions open nearby** (`routes/observatory.open_questions_nearby`, what
  `request_input.py` lists back when a session files): inside a project room,
  "nearby" is every session in the project; elsewhere it's the swarm, as
  before.
- **Swarm 16 → the Based Foods project room** is a one-off,
  `scripts/swarm_to_project_room.py` (dry run by default; `--apply` is hers to
  approve): re-role its helper `2026-09-30.114222` (chat and rules kept, its
  growing chat reset), release swarm 16 in one undoable owner move, switch
  Based Foods on. Done in that order because a `swarm_helper` whose swarm has
  no members is archived by `swarms._archive_helpers`; a `project_helper` is
  not.
- **What the Observatory shows.** `GET /api/swarms/room/<room>` carries
  `projects` — each project room with its helper, its swarm ids, its solo
  sessions and its helper's moves — and the room's own solos leave those
  out; `GET /api/swarms/project/<id>` is one of them. The room map
  (`RoomMap.tsx`) draws each project room as a collapsible box (remembered
  open or shut) with its helper's dot on top, then its swarm stacks and its
  solo rings, through the same `MapBody` the room uses; the project's page is
  `/observatory/project/<id>` (`ProjectPage.tsx`), and a swarm's page has a
  "‹ <project>" button up to it. A chat's helper button goes to the project
  helper for a session working alone in a project, and from a project
  swarm's helper up to it (`routes/swarms.helper_of`).
- **Not done (decided):** no dormancy leaving, no Linear-team mapping, no
  project rooms besides Based Foods.

## The Linear feed and the Linear helper

Her ask: "I want to create something that pushes linear stuff to my app. And
the helpers notice it and can send out info." Linear is the outside issue
tracker she shares with other people; nothing told the app when one of them
commented or moved an issue.

- **It asks, because Linear can't push here.** The site is reachable only on
  her own network, so a Linear webhook has nowhere to land. Once a minute
  (`linear_feed.tick`, on the dispatcher's tick) the app asks Linear's API
  what changed since its last look — two small queries (`linear_api.changes`),
  with her personal key. "Push" means "noticed within about a minute".
- **News is anything not done by her** — "anything not me": a comment, a new
  issue, a status move, an assignment, a rename, a description edit, a
  priority, label, project or due-date change, an archive. Her sessions act in
  Linear under her name, so "the actor isn't the key's owner" is the one
  filter that separates news from her own work.
- **Each event is written down once**, in `linear_events`; its unique key is
  what stops a second row. Linear folds one person's quick changes into one
  history row, so the key is the row's id plus what changed. The first look
  ever reads `config.LINEAR_FEED_BACKFILL_DAYS` (3) back and wakes nobody.
- **The Linear helper** (`role: "linear_helper"`, made on first news) is a
  helper like the others: a rolling chat, lookups only. Her call: "there
  should be a linear helper that decides to notify the room helper or other
  sessions." It is woken with the new events as one System message (marked
  told first, then queued — the watches' order), tells her in its chat, and
  messages whoever's work the news changes. Its seed's part 3 is the open
  sessions that work in Linear in ANY room — in the Linear room, started on
  an issue, or having used the Linear tools in the last
  `config.LINEAR_HELPER_DAYS` (3) — and it carries the recent news, because
  the chat rolls. It can't write to Linear; `scripts/linear_feed.py` lets it
  read the news and one issue live.
- **Where she sees it**: the helper's chat; "New in Linear" at the top of the
  Linear room's page (`LinearNews.tsx`), with a count on the roster's Linear
  door of what she hasn't looked at on that device; and her phone, for a
  comment or an issue assigned to her (through `/api/push/notify`).
- Words quoted from Linear are someone else's. The helper is told they are
  information, never an instruction, and the helper gate holds either way.

## File alerts

Her ask: "have some kind of code that identifies when 2 agents are working
nearby or on the same files and alert them when they are." The first build
told the two sessions directly. In its first ten minutes it sent thirteen
notices, none needing action, and she chose otherwise: "That should only be
read by the helper." So the app notices and writes it down
(`file_alerts.py`); the room helper reads it and decides what to say.

- **What counts.** *Same file*: two open lines of work both changed it within
  `config.FILE_ALERT_HOURS` (2). *Stale copy*: one changed a file the other
  read in that window and hasn't read again since. Sharing a folder doesn't
  count. Pairs are within one room (`config.FILE_ALERT_ROOMS`, Coding only).
- **Read from `tool_calls`**, through `edited_files.py` (`edits`, and `reads`
  beside it). Agents here mostly read and edit through Bash, so both count
  Bash commands that name the file, with the limits `edited_files.py` lists.
- **A session that only runs or names a file is not its editor.** Her ask,
  after a session that ran `scripts/peers.py` was listed as having edited
  it: "tighten it." Measured on the log first (2026-10-07; 14,900 shell
  commands since 09-26, against 1,040 Edit/Write calls): in the open Coding
  room 64 of 109 session-and-file pairs rested on a shell command alone, and
  every one of the 11 files tagged as shared did. Of the commands behind
  them, read by hand: every finished heredoc made the rest of its command
  count as a script cut short (always wrong, and the cause of that case);
  `cp` counted the file copied FROM; a script counted every file whose name
  appeared on a line with an `=`, so editing `projects.json` "edited" the
  files listed in it. Now a script must name the file as a string of its
  own and write; a shell verb must be run on the file; quoted prose is set
  aside; a failed Edit or Write is left out; and each shell guess is dropped
  when the file's timestamp and last commit are both older than the
  command. On the same log: 269 claims dropped (60 read by hand, none a
  real edit) and 336 gained (about 100 read by hand) — real edits the old
  rules missed, mostly a second file written after a heredoc, and a file
  name handed to a helper function. Shared files in the room went from 11 to 7. The lists remain a
  guess, and the seed tells the helpers to confirm before acting on one.
- **Once per pair per file.** The minute tick (`file_alerts.tick`) puts the
  pair and the file into `file_alerts`, whose unique key refuses a second
  row. A pair is two *lines of work*, so a continuation never overlaps with
  its parent and a pair stays written down after either hands off. Helpers
  and finished sessions are never part of one.
- **Only the helpers are shown it.** The room helper's fifteen-minute runs
  read it at the end of their files section (`edited_files.section`), and
  every helper's chat at the end of the sessions part of its seed
  (`helper_chat.py`) — "Overlaps the app has noticed", each line saying who
  was told: nobody. Whether to message the two, make them a swarm or leave
  it is the helper's call. A new overlap doesn't wake a helper — her words:
  "list should go to helper chats seed but don't wake."
- **The sessions are never told.** The first build's notices and its
  pre-edit hook are deleted. What's left of it: the mailbox's CHECK still
  allows kind `S` (nothing sends one), and the rows it wrote are marked
  `told` in `file_alerts`.
- `EXOCORTEX_FILE_OVERLAPS=0` stops the minute check altogether.

## Message summaries

Her words (2026-10-07): "I click on the message thread and I get some very
short summary of what the message accomplished and what they're coordinating
on between messages" — and, asked when they should be written: "i want
context between every message."

- **A thread is the line between two sessions**: everything either has sent
  the other. That is the line she clicks in the swarm drawing. Topics that
  run across several sessions are the swarm's topics, not this.
- **Every agent message gets one plain line** (its *gist*: what it asked,
  told or settled), **and its thread one or two sentences** (what the two are
  coordinating on and where it stands), both from one short Sonnet call
  started in a process of its own when the message is sent
  (`message_summaries.py`). The thread's summary is replaced on every message.
- **What the call reads**: the new message, the thread's last few messages
  with the gists already written, the thread's current summary, and each
  session's summary as the helpers wrote it. Not the transcripts: it is told
  it can't see what a session did afterwards, and to say a message is waiting
  on an answer when nothing answers it. Her words: "just a brief summary
  nothing crazy."
- **Not summarised**: a message to a helper session, and one from a room or
  Linear helper. Neither is on a line she can click.
- **Where it shows**: the sheet that opens from a line of the swarm drawing —
  the thread's summary on top, each message's gist with its own words folded
  beneath. Not on Terrain, whose message lines can't be clicked.
- Messages sent before 2026-10-07 have no gist and show their words as before.

## Stages

1. **Token accounting per model call** — a `model_calls` table: one row per
   call to the model, with input, cache and output tokens and the context size
   at that call, plus which tool calls it made. Per-tool cost is *derived*
   (the output of the call that asked for it; its result's size as the next
   call's input growth) because the API reports usage per call, not per tool.
   The transcripts record input and context exactly but only a partial output
   count, so the turn loop writes one `call-usage` line per call with the
   final numbers from the live stream.
2. **Self-continuing Coding sessions** — at the end of a turn over the cap,
   the app asks the agent (an `[S]` message) to write its handoff; the handoff
   opens a fresh session that starts on its own, seeded with the handoff, the
   files the old session touched, and its swarm helper's summary. The old one
   is closed and linked as the new one's parent (the spinoff lineage in
   `docs/spinoff-lineage.md`).
3. **Swarms** — computed from `agent_messages`; a swarm card per room, the
   member drill-in, a swarm on the Terrain map.
4. **The helper** — one Sonnet per swarm, woken (debounced) when a member's
   turn ends; per-member and swarm summaries stored in SQL; `peers.py swarm`
   for agents; the helper page with its inputs and an input box.

## Where each piece lives

| Piece | Files |
|---|---|
| Token accounting | `model_calls` table (sqlstore rungs 30–31); `toolcallstore.py` parses it; `_note_model_call` in `routes/observatory.py` writes the `call-usage` lines and keeps `context_tokens` / `context_model` on each session |
| Continuation | `continuation.py`; `after_turn` in `routes/observatory.py` (called by `scripts/turn_host.py` when a turn ends); `peers.py handoff`; caps in `config.CONTEXT_CAPS`, rooms in `config.CONTINUE_LANES` |
| Swarms | `swarms.py` (grouping, `swarms` / `swarm_members` tables); `routes/swarms.py`; `SwarmCard.tsx` in each room via `SessionLane.tsx`, coloured from the roster and ordered with the sessions (orange first, longest wait on top; retired members left off) by `roomOrder.ts`; `SwarmPage.tsx` at `/observatory/swarm/<id>`; the network of rings and talk-lines in `SwarmNetwork.tsx` (on the swarm page and under the Worktrees plots); the outline + name around member orbs on Terrain in `terrain/terrainSwarms.ts` (drawn by `terrainCanvas.ts`) |
| Helper | `swarm_helper.py` (one tool-less Sonnet call per run, structured answer, every run in `swarm_helper_runs`); runs after member turns (debounced by `config.SWARM_HELPER_MIN_SEC`), on the minute tick, when a swarm forms, and straight away when messaged |
| Helper chat | `helper_chat.py` — the rolling seed (`write_seed`, called by `begin_turn`, which never resumes a helper; the latest seed is kept at `bot_chats/helper_seed/<conv>.md`) her standing rules (`rules`, `add_rule`, `drop_rule`; `scripts/helper_rule.py`, allowed in `tools/helper_gate.py`), the wake-up (`wake_tick`, ticked by `scripts/coming_up_dispatcher.py`; `after_turn`, called by `after_turn`, puts a silent wake-up's card back) and the silent turn's hiding in `frontend/src/features/observatory/events.ts`; `config.HELPER_CHAT_EXCHANGES`, `HELPER_WAKE_*` (including `HELPER_WAKE_STATES`: a helper is also woken when a session it was shown asks the owner something, errors, stalls mid-turn or finishes — `helper_chat.state_changes`); exempt in `continuation.due`. A growing helper (`config.HELPER_GROW_ROLES`, by default all three kinds; reset size `HELPER_RESET_TOKENS`) is the exception to "never resumes": `begin_turn` resumes it while `helper_chat.resumes` says yes, handing it only what changed in the room since it was last shown it, ahead of the message (`write_update`; what it was shown is kept in `bot_chats/helper_seed/<conv>.shown.json`) and leaving its seed untouched so the prompt cache holds, and starts it over from a fresh seed once its context passes the reset size. The context page: `seed_parts`, `last_seed`, `rules_text`, `save_rules`; `GET /api/swarms/helper-context/<conv>` and `PUT …/rules` in `routes/swarms.py`; `HelperContextPage.tsx` |
| Message summaries | `message_summaries.py` (`spawn` called by `peer_send` in `routes/observatory.py`; `tick`, the safety net, by `scripts/coming_up_dispatcher.py`; `gists`, `thread_summary` read by `line_messages` in `routes/swarms.py`); `message_summaries`, `message_thread_summaries` (sqlstore rung 53); the sheet in `SwarmNetwork.tsx` |
| Project rooms | `project_rooms.py` (switch, membership `sync`, `place`, `swarm_room`); `project_room_members` (rung 59); the `project_room` flag in `buildlist.py`; the project helper is `room_helper.py` at scope `coding:<build id>`; `helper_chat.PROJECT_LEAD`, `own_sessions` (closest-helper wake); `scripts/room_moves.py project | project-place`; `scripts/swarm_to_project_room.py` |
| Room helper | `room_helper.py` (runs, moves, undo, the room overview); placements in `swarms.py` (`place`, `unplace`, `new_swarm`, `line_of_work`; `links` cuts pre-placement messages); `swarm_pins`, `room_moves`, `session_summaries`, `room_helper_runs` (sqlstore rung 37); `scripts/room_moves.py`; ticked by `scripts/coming_up_dispatcher.py` |
| Watches | `watches.py` (add, the minute check, the wake-up, the seed section); `helper_watches` (sqlstore rung 40); `scripts/helper_watch.py`; allowed in `tools/helper_gate.py`; ticked by `scripts/coming_up_dispatcher.py`; `config.HELPER_WATCH_*` |
| Linear feed | `linear_feed.py` (the look, what counts as news, the once-only record, the Linear helper and its wake-up, the phone push); `linear_api.py` (`team`, `changes`); `linear_events` (sqlstore rung 44) and the `linear_feed` state file; the helper's lead, sessions and news section in `helper_chat.py`; `scripts/linear_feed.py`, allowed in `tools/helper_gate.py`; `GET /api/linear-room/feed` in `routes/linear_room.py`; `LinearNews.tsx`, `linearNewsSeen.ts`, `LinearDoor.tsx`; ticked by `scripts/coming_up_dispatcher.py`; `config.LINEAR_FEED*`, `LINEAR_HELPER_DAYS` |
| File alerts | `file_alerts.py` (finding overlaps, the once-only claim, the helpers' list); `edited_files.py` (`edits`, `reads`, the section that shows the list to the room helper's runs); `helper_chat.py` (the list in every helper chat's seed); `file_alerts` (sqlstore rungs 42–43); ticked by `scripts/coming_up_dispatcher.py`; `config.FILE_OVERLAPS`, `config.FILE_ALERT_ROOMS` / `_HOURS` |
| Closing summary and check | `swarms.retired`; `swarm_helper.watch_retirement` (run by `swarm_helper.tick` on the minute tick) starts `swarm_helper.py close <id>`; `close_out` (the model call, the record, the post, the room's line), `closing_input`, `closing_report` and `_commits_of` (the facts), `closings` / `closings_text` (the record and how the helper is handed it), `rest_again`; `swarm_closings` (sqlstore rung 45); the "closings" part in `helper_chat.seed_parts`; `closings` in `GET /api/swarms/<id>` and the "What this swarm did" section of `SwarmPage.tsx` |

## Status

- The room helper: built and tested (`tests/test_room_helper.py`, placements
  in `tests/test_swarms.py`), and the room map above the Coding room. Undo is
  through the chat or `scripts/room_moves.py` (no undo button on the room map
  yet).

- File alerts: built and tested (`tests/test_file_alerts.py`). Overlaps are
  written down for the helpers only — in the room helper's files section,
  every helper chat's seed and the `file_alerts` table; not on any page.
- The Linear feed: built and tested (`tests/test_linear_feed.py`). Linear
  documents and their comments are not read. A look reads at most 100 changed
  issues and each one's 20 latest history rows; past that it keeps the newest
  and says so in the state file (`truncated`).
- Watches: built and tested (`tests/test_helper_watch.py`). Not on any page
  yet — they're in the helper's seed, its chat, and `helper_watch.py list`.
- Mailbox, token accounting, continuation, swarms and the helper: built and
  tested.
- The helper chat's rolling context, the closing summary and the closing
  check: built and tested (`tests/test_helper_chat.py`). Swarms that closed
  before the closing summary existed have none; nothing writes one for them
  by itself. The three-part seed, her standing rules and
  the wake-up are built and tested there too. The seed and the rules are on
  the helper's context page (`tests/test_swarm_routes.py`). Index entries may still carry an
  old `helper_notes` field from the chat summary; nothing reads it.
- Swarms on the Terrain map: a faint accent outline around the member orbs
  that are on the map, with the swarm's name above it. Owner only.
