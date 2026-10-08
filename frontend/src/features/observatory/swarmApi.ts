/**
 * swarmApi.ts — the swarm data the Observatory draws (routes/swarms.py).
 *
 * What this is, in plain English: sessions that have messaged each other form
 * a swarm, and each swarm has a helper that names it and keeps a summary of
 * every member (docs/swarms.md). This file is the typed door to that data,
 * plus one shared poll: every room on the page asks for swarms through
 * useSwarms(), and because they all use the same query key, the page makes
 * ONE request however many rooms are showing.
 *
 * Closed swarms (fewer than two sessions still at work) come with the rest, marked `closed`;
 * pages draw them only when the shared "show closed swarms" switch is on.
 *
 * Touches: routes/swarms.py (the endpoints), SwarmClosingFold.tsx (a closed swarm's summary, opened from a room
 * helper's chat), terrain/codeHeatPref.ts (the sticky switch), SwarmCard.tsx and SessionLane.tsx
 * (the cards in each room), RoomMap.tsx (the room from above), SwarmPage.tsx (one swarm's page), ObservatoryPage.tsx
 * (the helper button above a chat's message box, and the "context" button in a
 * helper's own chat), HelperContextPage.tsx (what a helper is working from, and
 * her standing rules for it), and
 * terrain/TerrainPage.tsx (the outlines around swarm members on the map).
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { makeStickyToggle } from '../terrain/codeHeatPref';

export type MemberState = 'working' | 'silent' | 'needs_input';

export interface SwarmMember {
  conv: string;
  title: string;
  lane: string;
  state: MemberState;
  /** Archived, or handed its work on to a successor. Absent from an older
   * server, so treat it as optional. */
  retired?: boolean;
  joined_at: string;
  summary: string | null;
  summary_at: string | null;
}

export interface Swarm {
  id: number;
  name: string;
  /** False until the helper has named it — the name is then "Swarm N". */
  named: boolean;
  lane: string;
  helper_conv: string | null;
  summary: string | null;
  summary_at: string | null;
  created_at: string;
  counts: { working: number; silent: number; needs_input: number };
  members: SwarmMember[];
  /** Fewer than two of its sessions are still at work (a session and its
   * continuations count as one; done, archived and handed-on ones don't count)
   * — swarms.py `is_closed`. A swarm is two sessions working together; the
   * one left on its own works alone in its room. Opens again by itself when
   * a second one is at work again. Absent from
   * an older server, so treat it as optional. */
  closed?: boolean;
  links: { from: string; to: string; messages: number }[];
  /** Which member took over from which (a continuation). Absent from an
   * older server, so treat it as optional. */
  continues?: { from: string; to: string }[];
  /** How many messages the swarm's helper has sent each member. Absent
   * from an older server, so treat it as optional. */
  helper_links?: { to: string; messages: number }[];
}

export interface HelperRun {
  id: number;
  at: string;
  trigger: string | null;
  input: string | null;
  output: {
    name?: string;
    summary?: string;
    members?: { conv: string; summary: string }[];
    differences?: string[];
    messages?: { to: string; text: string }[];
  } | null;
  cost_usd: number | null;
  error: string | null;
}

/** What a swarm did, written when it closed (swarm_helper.py `close_out`):
 * the helper's summary in plain words, and the closing check read from git
 * and the session records. One per time the swarm closed. `summary` is null
 * when the model call failed; `error` then says why. */
export interface SwarmClosing {
  id: number;
  at: string;
  name: string | null;
  headline: string | null;
  summary: string | null;
  facts: string;
  cost_usd: number | null;
  error: string | null;
}

export interface SwarmDetail extends Swarm {
  runs: HelperRun[];
  messages: { id: number; at: string; from: string; to: string; text: string; mode: string; status: string }[];
  differences: string[];
  /** Newest first. Absent from an older server, so treat it as optional. */
  closings?: SwarmClosing[];
}

/** Every live swarm — one shared, polled query for the whole page. */
export function useSwarms(enabled = true) {
  return useQuery({
    queryKey: ['swarms'] as const,
    // Off for a logged-out visitor on Terrain: swarms are the owner's.
    enabled,
    queryFn: async ({ signal }) => (await api.get<{ swarms: Swarm[] }>('/api/swarms', signal)).swarms,
    staleTime: 4_000,
    refetchInterval: 5_000,
  });
}

/** The room seen from above (routes/swarms.py `room`): its room helper
 * (room_helper.py), the sessions working alone with the helper's summary of
 * each, and the helper's recent moves. */
export interface RoomView {
  room: string;
  helper_conv: string | null;
  solos: { conv: string; title: string; state: MemberState; summary: string | null }[];
  moves: {
    id: number;
    at: string;
    kind: 'form' | 'join' | 'split' | 'release';
    convs: string[];
    from_swarm: number | null;
    to_swarm: number | null;
    reason: string | null;
    undone_at: string | null;
  }[];
}

/** One room's view from above, polled with the swarms. */
export function useRoomView(room: string, enabled = true) {
  return useQuery({
    queryKey: ['swarm-room', room] as const,
    enabled,
    queryFn: async ({ signal }) =>
      api.get<RoomView>(`/api/swarms/room/${encodeURIComponent(room)}`, signal),
    staleTime: 4_000,
    refetchInterval: 10_000,
  });
}

/** The helper one session's chat links to (routes/swarms.py `helper_of`):
 * its swarm's helper, else its room's helper, else null. */
export interface HelperLink {
  kind: 'swarm' | 'room';
  conv: string;
  title: string;
}

/** Which helper the open chat's "helper" button goes to, and whether the
 * open chat is itself a helper's (it then gets a "context" button). One small
 * lookup per chat rather than the whole swarm poll — membership changes
 * rarely, so it's re-asked every minute and whenever the window comes back
 * into focus. `is_helper` is absent from an older server. */
export function useHelperOf(convId: string | undefined) {
  return useQuery({
    queryKey: ['swarm-helper-of', convId] as const,
    enabled: !!convId,
    queryFn: async ({ signal }) =>
      api.get<{ helper: HelperLink | null; is_helper?: boolean }>(
        `/api/swarms/helper-of/${encodeURIComponent(convId!)}`,
        signal,
      ),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** One part of a helper's seed — the document a turn of its chat starts from
 * (helper_chat.py seed_parts). `text` is exactly what the model reads. */
export interface SeedPart {
  key: string;
  title: string;
  text: string;
}

/** Her standing rules for one helper: the file, its whole text (what she
 * edits), and the rules the helper is handed from it (its "- " lines). */
export interface HelperRules {
  path: string;
  exists: boolean;
  text: string;
  rules: string[];
}

/** What one helper is working from (routes/swarms.py `helper_context`). */
export interface HelperContext {
  conv: string;
  title: string;
  kind: 'swarm' | 'room' | 'linear';
  swarm_id: number | null;
  room: string | null;
  /** How many of her messages the seed replays (config.HELPER_CHAT_EXCHANGES). */
  exchanges_kept: number;
  /** null until the helper has had a turn. `now`: built this minute rather
   * than read from what its last turn was handed. */
  seed: { at: string; now: boolean; parts: SeedPart[] } | null;
  rules: HelperRules;
}

/** A helper's context. Not polled: the page holds a text box she may be
 * typing in, and building it fresh (`now`) takes the server several seconds. */
export function fetchHelperContext(convId: string, now: boolean, signal?: AbortSignal): Promise<HelperContext> {
  return api.get<HelperContext>(
    `/api/swarms/helper-context/${encodeURIComponent(convId)}${now ? '?now=1' : ''}`,
    signal,
  );
}

export function useHelperContext(convId: string, now: boolean) {
  return useQuery({
    queryKey: ['helper-context', convId, now] as const,
    queryFn: ({ signal }) => fetchHelperContext(convId, now, signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Save her rules file. `loaded` is the text the page was showing when she
 * started; the server refuses (409) if the file changed since. */
export function saveHelperRules(convId: string, text: string, loaded: string): Promise<{ rules: HelperRules }> {
  return api.put(`/api/swarms/helper-context/${encodeURIComponent(convId)}/rules`, { text, loaded });
}

/** Change one of her rules (the edit, delete and add buttons). An edit or a
 * drop names the rule by its number (1 = the first) and by the text the page
 * was showing (`was`); the server refuses (409) if that rule reads otherwise
 * by now. An added rule is stored with today's date, her words in quotes. */
export function changeHelperRule(
  convId: string,
  change:
    | { action: 'add'; words: string }
    | { action: 'edit'; number: number; was: string; words: string }
    | { action: 'drop'; number: number; was: string },
): Promise<{ rules: HelperRules }> {
  return api.post(`/api/swarms/helper-context/${encodeURIComponent(convId)}/rule`, change);
}

/** One message behind a line of the swarm drawing (routes/swarms.py
 * `line_messages`), with the names of who sent it and who it went to. */
export interface LineMessage {
  id: number;
  at: string;
  from: string;
  to: string;
  from_title: string;
  to_title: string;
  text: string;
  mode: string;
  status: string;
}

/** The messages one line of the swarm drawing stands for, newest first,
 * asked for only once `enabled` (when she opens the line). Each side is the
 * sessions one end of the line stands for, or `['helper']` for the swarm's
 * helper. `total` can be more than the list holds: the newest 200 come back.
 * `thread` is the line's summary, when one has been written. */
export function useLineMessages(swarmId: number, sideA: string[], sideB: string[], enabled: boolean) {
  const a = sideA.join(',');
  const b = sideB.join(',');
  return useQuery({
    queryKey: ['swarm-line', swarmId, a, b] as const,
    queryFn: async ({ signal }) =>
      api.get<{ messages: LineMessage[]; total: number; thread?: LineThread | null }>(
        `/api/swarms/${swarmId}/line?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, signal),
    enabled,
  });
}

export function useSwarm(id: number) {
  return useQuery({
    queryKey: ['swarm', id] as const,
    queryFn: async ({ signal }) => api.get<SwarmDetail>(`/api/swarms/${id}`, signal),
  /** One plain line on what the message asked, told or settled
   * (message_summaries.py); missing until it has been written. */
  gist?: string | null;
}

/** What the two ends of a line are coordinating on and where it stands,
 * rewritten each time one messages the other (message_summaries.py). */
export interface LineThread {
  summary: string;
  at: string;
    refetchInterval: 5_000,
  });
}

/** What one swarm did, and who to ask about it (routes/swarms.py
 * `swarm_closings`): the closings newest first, without the rest of the
 * swarm's page. */
export interface SwarmClosings {
  id: number;
  name: string;
  helper_conv: string | null;
  closings: SwarmClosing[];
}

/** One swarm's closing summaries, asked for only once `enabled` — the fold
 * under a "swarm closed" line asks when she opens it. Kept rows never change,
 * so there is no poll. */
export function useSwarmClosings(id: number, enabled: boolean) {
  return useQuery({
    queryKey: ['swarm-closings', id] as const,
    enabled,
    queryFn: async ({ signal }) => api.get<SwarmClosings>(`/api/swarms/${id}/closings`, signal),
    staleTime: 60_000,
  });
}

/** Pick the closing a line announced. The line and the kept row are written
 * with the same timestamp, so an exact match is the usual case. Failing that
 * (a row written by hand), take the newest closing at or before the line, and
 * failing that the newest there is. `closings` is newest first. */
export function closingFor(closings: SwarmClosing[], at: string): SwarmClosing | null {
  return (
    closings.find((closing) => closing.at === at) ??
    closings.find((closing) => at !== '' && closing.at <= at) ??
    closings[0] ??
    null
  );
}

export function refreshSwarm(id: number): Promise<{ ok: boolean; started: boolean }> {
  return api.post(`/api/swarms/${id}/refresh`);
}

/** The card's state, by the same rule as a session card: anyone needing her
 * makes it orange, anyone working makes it purple, otherwise it rests grey. */
export function swarmState(s: Pick<Swarm, 'counts'>): MemberState {
  if (s.counts.needs_input > 0) return 'needs_input';
  if (s.counts.working > 0) return 'working';
  return 'silent';
}

/* Closed swarms: hidden unless she asks. A swarm closes when every member
   has finished (Swarm.closed). One sticky switch (localStorage) for every
   page that draws swarms, so showing them once shows them everywhere. */
const closedShownToggle = makeStickyToggle('swarms-closed-shown');
export const useClosedSwarmsShown = closedShownToggle.useOn;
export const setClosedSwarmsShown = closedShownToggle.set;

/** The swarms a page should draw: the open ones, and the closed ones too
 * when the switch is on. */
export function shownSwarms<S extends Pick<Swarm, 'closed'>>(swarms: S[], showClosed: boolean): S[] {
  return showClosed ? swarms : swarms.filter((s) => !s.closed);
}
