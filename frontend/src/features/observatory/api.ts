/**
 * api.ts — typed calls for the observatory (routes/observatory.py).
 * Roster/conversation reads use the shared api client; the send is a raw
 * fetch because it streams: the endpoint answers with SSE frames and the
 * response body is read incrementally (EventSource can't POST).
 *
 * Session-first (07-24): the "bot" persona concept dissolved server-side —
 * a session carries its own config now instead of belonging to one of a
 * handful of named bots. GET /api/observatory's `bots` key is legacy and
 * unused here; `sessions` is the flat roster.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { parseSseChunk } from './sseFrames';

/** Cached facts about the nightly rollover job, updated after each run
 * (on-demand or the cron original) — surfaced so the on-demand trigger can
 * tell success from failure once the run it kicked off finishes. */
export interface KeeperRolloverRegistry {
  last_run?: string;
  last_status?: string;
  last_conv_id?: string;
  last_cost_usd?: number;
  [key: string]: unknown;
}

export interface KeeperRolloverStatus {
  /** A rollover (on-demand or the nightly cron) is running right now. */
  running: boolean;
  /** The fresh pinned Keeper session's id, once the run that made it has
   * finished — the on-demand trigger's navigation target. */
  pinned_conv_id: string | null;
  registry: KeeperRolloverRegistry | null;
}

/** A gated command a session is blocked on, awaiting her Approve / Deny.
 * `command` is the exact Bash line the act-ask gate stopped. */
export interface PendingApproval {
  tool: string;
  command: string;
}

/** Every lane a session can carry. A session BELONGS to one — this is assigned
 * at creation, not derived from whether it happens to be running. Every lane
 * carries the same full toolkit; what the lane decides is WHERE the session
 * stands and whether it stops and ASKS:
 *
 *   personal   her, talking about her life — rooted where both repos meet,
 *              ungated (she's the check)
 *   coding     her, building — rooted in the app checkout, also ungated
 *   orchestra  RETIRED as a room (her 08-12 ask, "remove the orchestra section
 *              for now") — app checkout, gated. Still a real lane server-side:
 *              it's what night-crew workers run in and what routes/
 *              observatory.py falls back to for any session it can't place, so
 *              an unplaceable session still asks before anything irreversible.
 *              It has no room on the roster and the pickers don't offer it;
 *              its history stays reachable under Past sessions.
 *
 *   research   her research desk, and where dispatched research workers run
 *              now (they left tmux, 09-24). Rooted in the research-room
 *              folder, ungated — every write it makes lands reviewed:false
 *              for her to check. A DOOR on the roster (ResearchDoor →
 *              /observatory/research), not a room block, like Helpers.
 *
 * Personal and Coding differ by GROUND. */
export type Lane = 'orchestra' | 'personal' | 'coding' | 'research';

/** Every lane the client can name — used for PARSING and LABELLING (the archive
 * scopes and chips), not for deciding what the roster draws. Orchestra is in
 * here because sessions still carry it; see ROOMS for what's actually offered. */
export const ALL_LANES: Lane[] = ['personal', 'coding', 'research', 'orchestra'];

/** The rooms the Observatory actually DRAWS and offers, in the order the roster
 * stacks them. Split from ALL_LANES when Orchestra was retired: a lane can
 * exist (old sessions, night-crew workers, the server's fail-toward-ask
 * fallback) without having a room on the page. Anything that walks the rooms —
 * the roster's sections, the create/edit picker — reads this. */
export const ROOMS = ['personal', 'coding'] as const satisfies readonly Lane[];
export type Room = (typeof ROOMS)[number];

/** Is this lane one she can see a room for? False for a retired lane, which is
 * what tells the roster to fold those sessions somewhere visible instead of
 * dropping them off the page. */
export function isRoom(lane: Lane): lane is Room {
  return (ROOMS as readonly Lane[]).includes(lane);
}

/** Narrow whatever the server said into a lane this client can name. An
 * unknown value falls to Orchestra — the gated lane, the same fail-toward-ask
 * the backend uses for anything it can't place. Orchestra has no room, so the
 * roster shows such a session in Coding rather than dropping it (RosterPage). */
export function toLane(value: string | undefined): Lane {
  return (ALL_LANES as string[]).includes(value ?? '') ? (value as Lane) : 'orchestra';
}

/** The lanes' display names — one copy, here beside ALL_LANES, so the roster
 * headings, the dialog's picker and the archive's chips can't drift into
 * spelling the same one differently. Retired lanes keep a label: the archive
 * still has to say which room an old session was in. */
export const LANE_LABEL: Record<Lane, string> = {
  personal: 'Personal',
  coding: 'Coding',
  research: 'Research',
  orchestra: 'Orchestra',
};

/** Each room in one line: where it stands, then whether it asks. Those are the
 * two switches the lane actually flips, and Personal/Coding differ only on the
 * first — so the blurb has to say both or a picker looks like it has a
 * duplicate. (RosterPage's fuller room introductions are its own prose — this
 * is the one-liner surfaces share.) */
export const LANE_BLURB: Record<Lane, string> = {
  personal: 'Rooted where both repos meet, so it can reach your vault. Just acts — you’re the one watching.',
  coding: 'Rooted in the app code, where the build happens. Just acts — you’re the one watching.',
  research: 'Rooted in the research room, with a read-only door onto your tables. Just acts — everything it writes waits for your review.',
  orchestra: 'Rooted in the app code. Stops and asks before anything irreversible.',
};

export interface SessionMeta {
  id: string;
  title: string;
  last_at: string;
  /** Who minted this session. "nightcrew" marks an overnight worker's
   * session: it renders under the Night crew section (via its run card's
   * session door), never in the room lanes, and replying to it folds her
   * words into the dev note it worked on. */
  origin?: string;
  /** Which room the card lives in. Always present — the server resolves it
   * (deriving from `cwd` for entries that predate lanes), so the client never
   * has to guess. */
  lane?: Lane;
  /** Resolved act-vs-ask state: does this session stop before irreversible
   * work? Defaults from the lane; an explicit per-session choice overrides.
   * Read-only — for SHOWING what the next turn will do. */
  act_gate?: boolean;
  /** Her per-session PIN, raw: absent means no pin and the room is driving it.
   * This is what the ✎ dialog seeds from — seeding from the resolved
   * `act_gate` turned an inherited "asks" into a choice on save, so an
   * Orchestra → Personal move carried every gate along with it. */
  act_gate_set?: boolean;
  /** When the session was created (ISO-8601). The roster sorts on THIS, not
   * last_at, so a card's position is fixed at birth and never churns on
   * activity. Absent on legacy entries minted before it was stamped —
   * consumers fall back to last_at. */
  started?: string;
  /** false = a non-diary session: logs to its own jsonl, never mints cards. */
  journal?: boolean;
  /** Pinned sessions sort first (the Keeper session lives at the top). */
  pinned?: boolean;
  /** When it was closed. Archived sessions are off the roster but reachable
   * from the archive — and SENDING into one reopens it (routes/observatory.py
   * pops the flag on send, deliberately: talking to an old chat is the whole
   * un-archive gesture). The composer says so, so that isn't a surprise. */
  archived?: string;
  /** Cached Haiku one-liner of what the session is working on. */
  summary?: string;
  /** Her last real ask, one line, stamped at send time. Shown on the card only
   * while the session is RUNNING or UNREAD — the window where `summary` is
   * still describing the previous thing, since it refreshes in the background
   * at most once a minute. Never set from an off-the-record send or a
   * journaling session (see routes/observatory.py), so the card can show it
   * without re-deciding what's private. */
  last_prompt?: string;
  /** A turn is running server-side right now — turns outlive their HTTP
   * connection, so a re-attaching client polls this to know whether to
   * keep waiting. */
  running?: boolean;
  /** A staged first message, set server-side (e.g. by an automation that
   * wants her to fire it herself) — a non-empty draft prefills the compose
   * box once on open (see ObservatoryPage's draft-prefill effect). */
  draft?: string;
  /** Set by /spinoff alongside `draft`: fire the staged kickoff automatically
   * on open instead of prefilling the compose box, so a spun-off session
   * starts working the moment she opens it (no manual send). Consumed by the
   * first send, server-side, same as `draft`. */
  autostart?: boolean;
  /** A running (or just-finished) session raised a structural "I need you"
   * via scripts/request_input.py — the question text. Its Orchestra card glows
   * orange until her next send into the session clears it (server-side). */
  awaiting_input?: string;
  /** Which model this session's next turn will actually run on — its own pin
   * if it has one, else the CLI's own default, resolved server-side. Absent
   * only when neither says anything. Read-only, for SHOWING: the ✎ dialog seeds
   * its picker from the raw `model` below, never from this, or an inherited
   * default would save back as a deliberate pin. Same raw-beside-resolved split
   * as act_gate / act_gate_set. */
  model_effective?: string;
  /** The claude session `--resume` reattaches to. Written on FIRST sight of any
   * event in a turn, so an interrupted turn stays resumable — but a turn that
   * died before claude said anything at all (bad spawn, the memory floor) never
   * got one. Its absence is what tells the red card's button to say "Try again"
   * instead of "Resume": there'd be no history to resume INTO. */
  claude_session_id?: string | null;
  /** The last turn ENDED in failure (claude exited non-zero, or the spawn never
   * happened) — the message, capped at the stderr tail the server keeps. Set in
   * _run_turn's finally, cleared by a clean turn or her next send, so it means
   * "the last thing this session did was fail", not "it failed once". Its card
   * glows red. */
  last_error?: string;
  /** A gated command the act-ask gate is blocking, waiting for her Approve /
   * Deny tap on the Orchestra card (see approveConversation / denyConversation).
   * Cleared server-side once she resolves it — or replies by hand. */
  awaiting_approval?: PendingApproval;
  /** What this session has spent, summed server-side from the per-turn
   * records in its own transcript. `output` is tokens the agent actually
   * wrote (input is mostly cache reads — huge, cheap, and meaningless as a
   * measure of work). ABSENT until a first turn finishes, so a brand-new
   * session shows nothing rather than a hollow "0". Lags by the turn in
   * flight; the composer's working line covers that one live. */
  tokens?: { output: number; cost_usd: number };
  /** Model alias this session is pinned to ('opus', 'sonnet[1m]', …).
   * ABSENT = inherit the CLI's own default (~/.claude/settings.json) — the
   * case every session is in until she picks one. Resolved per turn, so
   * changing it takes effect on the next turn with the history intact. */
  model?: string;
}

export function getSessions(
  signal?: AbortSignal,
): Promise<{ sessions: SessionMeta[]; model_choices?: string[] }> {
  return api.get('/api/observatory', signal);
}

export function getConversation(
  id: string,
  signal?: AbortSignal,
): Promise<{ id: string; meta: SessionMeta; events: unknown[] }> {
  // `lean=1`: the server leaves out tool results, which the page never draws
  // and which are most of a transcript's weight (routes/observatory.py).
  return api.get(`/api/observatory/conversation/${encodeURIComponent(id)}?lean=1`, signal);
}

/** The last thing said in a session — the agent's newest reply, or her ask if
 * that's the newest thing in the log. Its own tiny endpoint rather than a slice
 * of getConversation, because the server reads only the tail of the transcript
 * to answer it (routes/observatory.py: _conversation_last_said). */
export interface SessionPreview {
  id: string;
  /** Who said it. null = the session has never spoken, or won't say. */
  role: 'assistant' | 'user' | null;
  text: string;
  /** The reply was longer than the card's cap and got cut. */
  truncated: boolean;
  /** A journaling session — withheld on purpose, not missing. */
  private?: boolean;
}

/** Roster query, for surfaces that want the session cards' own facts (summary,
 * model, spend, what it's waiting on) without RosterPage's polling loop. Terrain
 * uses it for the agent hovercard. Idle-slow by default; the caller passes
 * `live` while something is actually running. */
export function useSessionRoster(live = false, enabled = true) {
  return useQuery({
    queryKey: ['observatory-roster'] as const,
    queryFn: async ({ signal }) => getSessions(signal),
    staleTime: live ? 4_000 : 30_000,
    refetchInterval: live ? 5_000 : false,
    // Off for a public visitor (the map is public, the roster is not): a
    // disabled query never fires, so nothing 401s in their console.
    enabled,
  });
}

/** One session's last line, fetched only while she's actually pointing at it.
 * Cached per session so re-hovering the same orb is instant, and short-stale so
 * a live agent's card catches up as it talks. */
export function useSessionPreview(convId: string | null) {
  return useQuery({
    queryKey: ['session-preview', convId] as const,
    queryFn: async ({ signal }) =>
      api.get<SessionPreview>(
        `/api/observatory/conversation/${encodeURIComponent(convId!)}/preview`,
        signal,
      ),
    enabled: convId !== null,
    staleTime: 10_000,
  });
}

/** One past session on the archive's listing. `gist`/`tags`/`front`/`domain`
 * are written by scripts/sort_bot_chats.py after the fact — a session it hasn't
 * sorted yet simply has none, which is why nothing here is required. */
export interface ArchivedSession {
  id: string;
  title: string;
  /** What actually happened in there, in one cached line. The most useful
   * field on the row: a title says what she meant to do, a gist says what it
   * turned into. */
  gist?: string;
  tags?: string[];
  front?: string | null;
  domain?: string | null;
  lane?: Lane;
  journal?: boolean;
  started?: string;
  last_at?: string;
  archived?: boolean;
  pinned?: boolean;
}

/** Every session ever, archived included — the librarian's view, as opposed to
 * `/api/observatory`, which is only what's open. Still served by the endpoint
 * that was built for the old /atlas map; the shelves it was shaped for are
 * gone, the list it returns is exactly what the archive needs. */
export function useArchiveList() {
  return useQuery({
    queryKey: ['observatory-archive'] as const,
    queryFn: async ({ signal }) =>
      api.get<{ sessions: ArchivedSession[] }>('/api/observatory/atlas', signal),
    // A record of the past changes when a session ends, not second to second.
    staleTime: 60_000,
  });
}

/** One match inside a transcript: where the words sit in the snippet (`at`,
 * `len`) so the client can mark them without re-finding the query in trimmed,
 * ellipsised text. `turn` is its index among that session's spoken lines. */
export interface SearchHit {
  text: string;
  at: number;
  len: number;
  turn: number;
  who: 'B' | 'K';
}

export interface SearchResult {
  id: string;
  title: string;
  /** The query matched the session's NAME, not (only) its contents. */
  title_hit: boolean;
  lane: Lane;
  journal: boolean;
  archived: boolean;
  pinned: boolean;
  started?: string;
  last_at?: string;
  hits: SearchHit[];
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** How many transcripts were actually read — so a partial scan is visible
   * rather than silently passing for "everything". */
  scanned: number;
  truncated: boolean;
}

/** Search every session's transcript, archived included. Plain substring, no
 * query language — see the route's docstring for why. */
export function searchSessions(q: string, signal?: AbortSignal): Promise<SearchResponse> {
  return api.get(`/api/observatory/search?q=${encodeURIComponent(q)}`, signal);
}

/** Create a session ahead of its first message — the roster's '+ New
 * session', and the observatory's own blank-compose first send (the old
 * create-implicitly-on-send flow is gone; the client drives it explicitly
 * now). The server picks the rest of the config (cwd/tools) itself.
 *
 * The lane default stays ORCHESTRA even though that room is retired, and it's
 * deliberate: it's the gated lane, and a session nobody named a room for should
 * stop and ask rather than quietly gain autonomy from a UI change. It shares
 * its ground with Coding, so the only difference is the gate. The roster draws
 * such a session in the Coding room (see RosterPage's byLane) — visible, still
 * asking. The roster's own '+' sheet always sends an explicit room, so this
 * default only catches the blank-compose path. */
export function createSession(
  title: string,
  journal: boolean,
  model = '',
  lane: Lane = 'orchestra',
): Promise<{ ok: true; id: string; lane: Lane }> {
  return api.post('/api/observatory/conversations', { title, journal, model, lane });
}

/** Put one keeper reply into the journal (a K card) — the tap gesture.
 * Works in any session regardless of its journal switch. */
export function journalOutput(convId: string, text: string): Promise<{ ok: true }> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(convId)}/journal-output`, { text });
}

/** Put one highlighted SPAN into the journal — the precise sibling of
 * journalOutput, which takes a whole reply. `who` is the voice that said the
 * quoted words ('K' a reply, 'B' her own message); an optional `note` mints as
 * her own card replying to the quote. `turn`/`start`/`end` are the anchor the
 * mark comes back lit on (see highlightMarks.ts). Returns the minted card id. */
export function journalHighlight(
  convId: string,
  h: { who: 'B' | 'K'; quote: string; note: string; turn: number; start: number; end: number },
): Promise<{ ok: true; card: string; note_card: string | null }> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(convId)}/journal-highlight`, h);
}

/** Close (archive) a session — it leaves the roster; its log stays. The
 * pinned Keeper session refuses (400). */
export function closeConversation(id: string): Promise<{ ok: true }> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(id)}/close`, {});
}

/** Stop a running turn on purpose — the stop button's door. This is the only
 * thing that kills a turn now; a dropped connection never does. */
export function stopConversation(convId: string): Promise<{ ok: true }> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(convId)}/stop`, {});
}

/** Fork-the-work: stage a clean-context take-over spinoff seeded with the files
 * this session is writing/creating right now (reads excluded). Returns the
 * staged conversation id — she opens it from My Sessions once she's stopped the
 * original (two sessions writing the same files would clobber each other). */
export function forkConversation(
  convId: string,
): Promise<{ ok: boolean; conversation_id: string; newly_spawned?: boolean }> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(convId)}/fork`, {});
}

/** What the server says after an Approve/Deny. `resume` is how the retry cue
 * went out: "sent" (the session was idle) or "queued" (it starts the moment
 * the current reply ends). The server owns that wait now, so a page that sees
 * `resume` sends nothing itself; one that doesn't is talking to an older
 * server and falls back to sending its own. */
export interface DecisionResult {
  ok: boolean;
  command: string;
  resume?: 'sent' | 'queued';
}

/** Approve the gated command a session is blocked on. `sticky` = whitelist it
 * for the whole session (never asks again); false = one-shot (this retry only). */
export function approveConversation(convId: string, sticky: boolean): Promise<DecisionResult> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(convId)}/approve`, { sticky });
}

/** Deny the pending gated command — clears it without whitelisting. */
export function denyConversation(convId: string): Promise<DecisionResult> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(convId)}/deny`, {});
}

/** Patch a session's settings. `model: ''` clears the pin — back to
 * inheriting the CLI default. An unknown alias is rejected server-side (400). */
export function updateConversation(
  id: string,
  patch: {
    title?: string;
    journal?: boolean;
    model?: string;
    /** Move the card to the other room. Re-scopes the safety nets on the next
     * turn (config is resolved per turn) with the history intact — but it does
     * NOT move the session's `cwd`, which is fixed at birth: Claude Code stores
     * conversations per directory, so one that changed ground could never be
     * resumed. A card can change rooms; a session can't change where it stands. */
    lane?: Lane;
    /** Per-session override of "asks before irreversible work". `null` hands it
     * back to the lane default — that's the difference between a choice she
     * made and a value it merely inherited. */
    act_gate?: boolean | null;
  },
): Promise<{ ok: true; conversation: SessionMeta }> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(id)}/settings`, patch);
}

/** Kick off the nightly keeper rollover on demand — /endsession on the
 * pinned session, then archive it and /journalstart a fresh one. 202 once
 * it's started; the caller polls getKeeperRolloverStatus for completion. A
 * 409 (one's already running) surfaces as an ApiError the caller treats as
 * "start tracking", not a failure — see useKeeperRollover.ts. */
export function startKeeperRollover(): Promise<{ ok: boolean; started: boolean }> {
  return api.post('/api/observatory/keeper/rollover', {});
}

export function getKeeperRolloverStatus(signal?: AbortSignal): Promise<KeeperRolloverStatus> {
  return api.get('/api/observatory/keeper/rollover/status', signal);
}

/**
 * A send that the server refused, carrying the HTTP status so callers can tell
 * the kinds of "no" apart. The one that matters: 409 means "a turn is already
 * running in this conversation" — a wait-and-retry, not a failure. Every other
 * status is a real error. Before this, every refusal arrived as a bare Error
 * and the approve-then-resume path could not distinguish "busy for another
 * second" from "broken", so it treated both as nothing-to-do.
 */
export class SendError extends Error {
  status: number;

  /** Present on a 503 memory refusal: what the server saw when it said no, so
   * the prompt can draw the bar instead of showing a dead-end toast. */
  headroom?: unknown;

  /** True when the refusal is one this turn could be QUEUED past. */
  canQueue?: boolean;

  constructor(message: string, status: number, extra?: { headroom?: unknown; canQueue?: boolean }) {
    super(message);
    this.name = 'SendError';
    this.status = status;
    this.headroom = extra?.headroom;
    this.canQueue = extra?.canQueue;
  }
}

/** True for the one refusal that just means "not yet" — see SendError. */
export function isTurnBusy(err: unknown): boolean {
  return err instanceof SendError && err.status === 409;
}

/** True when the send was refused for want of memory. Distinct from a real
 * failure: nothing is broken, the box is just full, and the turn can be queued
 * rather than lost. */
export function isOutOfMemory(err: unknown): boolean {
  return err instanceof SendError && err.status === 503 && err.canQueue === true;
}

export interface SendOptions {
  /** False = off the record, which now means one thing only: this turn is not
   * minted into the journal. It still lands in the conversation log and reads
   * back in the chat like anything else she said. */
  record: boolean;
  /** Set only on the resume send fired right after she taps Approve/Deny on a
   * gated command. It rides along so the server logs a visible "✓ Approved:
   * <command>" marker in the transcript instead of a blank off-record gap —
   * the command still never enters her journal. */
  decision?: { kind: 'approve' | 'deny'; command: string };
  /** Text the app is saying on her behalf, not something she typed (the red
   * card's resume nudge). This is the only send that still leaves a blank gap
   * in the transcript — putting the app's words in her mouth would be worse
   * than the hole. */
  operator?: boolean;
  signal?: AbortSignal;
}

/**
 * Send one turn on an existing conversation and stream its events. `onEvent`
 * fires per SSE frame with the parsed event object (the same vocabulary
 * events.ts reduces). Resolves with the conversation id (echoed back on the
 * first 'conv' frame) when the stream ends; rejects on transport failure or
 * an error status — the caller restores the composer text on rejection.
 *
 * The conversation must already exist (createSession first) — the old
 * implicit-create-on-send is gone; this only ever sends into a known id.
 */
export async function streamSend(
  convId: string,
  text: string,
  opts: SendOptions,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<string | undefined> {
  const res = await fetch(`/api/observatory/conversation/${encodeURIComponent(convId)}/send`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      text,
      record: opts.record,
      decision: opts.decision,
      operator: opts.operator,
    }),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      headroom?: unknown;
      can_queue?: boolean;
    };
    throw new SendError(data.error || `send failed (${res.status})`, res.status, {
      headroom: data.headroom,
      canQueue: data.can_queue,
    });
  }

  let convIdOut: string | undefined = convId;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Frame-cutting is pure and tested on its own — see sseFrames.ts.
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, rest } = parseSseChunk(pending + decoder.decode(value, { stream: true }));
    pending = rest;
    for (const event of events) {
      if (event.type === 'conv' && typeof event.conversation_id === 'string') {
        convIdOut = event.conversation_id;
      }
      onEvent(event);
    }
  }
  return convIdOut;
}

/** Replying to a finished branch's card is what wakes it: mints (or rejoins)
 * the ONE steward session standing on that existing branch, briefed with the
 * literal evidence plus her message (routes/branches.py). `existing` = a live
 * session already claims the branch and was rejoined instead; refusals (merged
 * branch, no branch) arrive as ApiError with the server's plain-words reason. */
export function wakeSteward(
  branch: string,
  message: string,
): Promise<{ ok: boolean; conversation_id: string; existing?: boolean; note?: string }> {
  return api.post('/api/branches/steward', { branch, message });
}

/** One button-fired Claude job (routes/helpers.py): a triage chat, a recipe
 * or receipt parse, a person impression. `archived` set = already closed;
 * `last_error` set = its last turn failed. */
export interface HelperRun {
  id: string;
  kind: string;
  label: string;
  title: string;
  started: string;
  last_at: string;
  archived: string | null;
  running: boolean;
  last_error: string | null;
  tokens?: { output: number; cost_usd: number };
}

export interface HelpersState {
  runs: HelperRun[];
  running: number;
  failed: number;
}

/** One conversation in the spinoff family tree (GET /api/spinoff/tree,
 * routes/spinoff.py spinoff_tree). `parent` is the conversation it was spun
 * off from; `via` is how ("skill", "go", "fork", "helper", "steward",
 * "terminal", "app"). A parent that was never itself spun off has no `via`. */
export interface SpinoffTreeNode {
  id: string;
  title: string;
  slug: string | null;
  lane: string;
  started: string | null;
  last: string | null;
  archived: boolean;
  running: boolean;
  parent: string | null;
  via: string | null;
}

/** GET /api/spinoff/tree — every conversation in a spinoff family, flat,
 * archived ones included. SpinoffTreePage folds it into a tree. */
export function getSpinoffTree(signal?: AbortSignal): Promise<{ nodes: SpinoffTreeNode[] }> {
  return api.get('/api/spinoff/tree', signal);
}

/** GET /api/helpers — every helper session ever minted, archived included,
 * newest first. Drawn by HelpersDoor (census) and HelpersPage (the list). */
export function getHelpers(signal?: AbortSignal): Promise<HelpersState> {
  return api.get('/api/helpers', signal);
}

/** One row of the Research room's list: her own desk sessions and the
 * dispatched workers alike. `research_session_id` is set on a worker — the
 * research.json session it served — and absent on a desk session. */
export interface ResearchRoomSession {
  id: string;
  title: string;
  started: string;
  last_at: string;
  running: boolean;
  archived: string | null;
  last_error: string | null;
  origin: string | null;
  research_session_id: string | null;
  tokens?: { output: number; cost_usd: number };
}

export interface ResearchRoomState {
  sessions: ResearchRoomSession[];
  running: number;
  failed: number;
  /** The model picker's choices, so the page's "+" sheet matches the roster's. */
  model_choices: string[];
}

/** Every research-lane session, archived included, newest first
 * (routes/research_room.py). */
export function getResearchRoom(signal?: AbortSignal): Promise<ResearchRoomState> {
  return api.get('/api/research-room', signal);
}

/** A /spinoff the agent staged as a Go button on this conversation
 * (routes/spinoff.py offer_spinoff). `sessions` carries each brief's title. */
export interface SpinoffOffer {
  slugs: string[];
  offered: string;
  lane?: string;
  sessions: { slug: string; title: string }[];
}

export interface SpinoffGoResult {
  ok: boolean;
  spawned: { slug: string; conversation_id: string; lane: string; newly_spawned: boolean; started: boolean }[];
  errors: { slug: string; error: string }[];
}

export function getSpinoffOffer(convId: string, signal?: AbortSignal): Promise<{ offer: SpinoffOffer | null }> {
  return api.get(`/api/spinoff/offer/${encodeURIComponent(convId)}`, signal);
}

export function goSpinoffOffer(convId: string): Promise<SpinoffGoResult> {
  return api.post(`/api/spinoff/offer/${encodeURIComponent(convId)}/go`, {});
}

export function dismissSpinoffOffer(convId: string): Promise<{ ok: true }> {
  return api.post(`/api/spinoff/offer/${encodeURIComponent(convId)}/dismiss`, {});
}
