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

/** The Observatory's three rooms. A session BELONGS to one — this is assigned
 * at creation, not derived from whether it happens to be running. Every lane
 * carries the same full toolkit; what the lane decides is WHERE the session
 * stands and whether it stops and ASKS:
 *
 *   personal   her, talking about her life — rooted where both repos meet,
 *              ungated (she's the check)
 *   coding     her, building — rooted in the app checkout, also ungated
 *   orchestra  work while she isn't watching — app checkout, gated, raises
 *              orange approval cards
 *
 * Personal and Coding differ by GROUND; Coding and Orchestra by GATE. */
export type Lane = 'orchestra' | 'personal' | 'coding';

/** Every room the client knows, in the order the roster stacks them: the two
 * she's present for, then the one running underneath. Anything that walks the
 * set (the roster's sections, the dialog's picker) reads this rather than
 * repeating the list. */
export const ALL_LANES: Lane[] = ['personal', 'coding', 'orchestra'];

/** Narrow whatever the server said into a room this client can draw. An
 * unknown value falls to Orchestra — the gated room, the same fail-toward-ask
 * the backend uses for anything it can't place. */
export function toLane(value: string | undefined): Lane {
  return (ALL_LANES as string[]).includes(value ?? '') ? (value as Lane) : 'orchestra';
}

export interface SessionMeta {
  id: string;
  title: string;
  last_at: string;
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
  return api.get(`/api/observatory/conversation/${encodeURIComponent(id)}`, signal);
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
export function useSessionRoster(live = false) {
  return useQuery({
    queryKey: ['observatory-roster'] as const,
    queryFn: async ({ signal }) => getSessions(signal),
    staleTime: live ? 4_000 : 30_000,
    refetchInterval: live ? 5_000 : false,
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
 * now). The server picks the rest of the config (cwd/tools) itself. */
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

/** Approve the gated command a session is blocked on. `sticky` = whitelist it
 * for the whole session (never asks again); false = one-shot (this retry only).
 * The caller fires a resume send right after so the agent retries and the gate
 * now lets it through. */
export function approveConversation(
  convId: string,
  sticky: boolean,
): Promise<{ ok: boolean; command: string }> {
  return api.post(`/api/observatory/conversation/${encodeURIComponent(convId)}/approve`, { sticky });
}

/** Deny the pending gated command — clears it without whitelisting. */
export function denyConversation(convId: string): Promise<{ ok: boolean; command: string }> {
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
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    // SSE frames are blank-line separated; keep the trailing partial frame.
    const frames = pending.split('\n\n');
    pending = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data: ')) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
      } catch {
        continue; // torn frame — the next one resyncs us
      }
      if (event.type === 'conv' && typeof event.conversation_id === 'string') {
        convIdOut = event.conversation_id;
      }
      onEvent(event);
    }
  }
  return convIdOut;
}
