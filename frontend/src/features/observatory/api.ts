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

/** The Observatory's two rooms. A session BELONGS to one — this is assigned at
 * creation, not derived from whether it happens to be running. Both lanes carry
 * the same full toolkit; the lane decides whether the session stops and ASKS:
 * `orchestra` works while she isn't watching (gated, raises orange cards),
 * `personal` is her talking in real time (ungated — she's the check). */
export type Lane = 'orchestra' | 'personal';

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
  /** Cached Haiku one-liner of what the session is working on. */
  summary?: string;
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

export interface SendOptions {
  record: boolean;
  /** Set only on the resume send fired right after she taps Approve/Deny on a
   * gated command. It rides along so the server logs a visible "✓ Approved:
   * <command>" marker in the transcript instead of a blank off-record gap —
   * the command still never enters her journal. */
  decision?: { kind: 'approve' | 'deny'; command: string };
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
    body: JSON.stringify({ text, record: opts.record, decision: opts.decision }),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `send failed (${res.status})`);
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
