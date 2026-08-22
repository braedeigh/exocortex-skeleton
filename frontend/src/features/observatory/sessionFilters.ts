/**
 * sessionFilters.ts — the three coloured buttons on the Observatory's
 * top-right rail, as pure predicates so the counts and the filtering can't
 * disagree.
 *
 * The three colours are the ones the cards already wear (SessionLane.module.css):
 *
 *   purple  RUNNING — a turn is in flight this second (the breathing one)
 *   purple  ACTIVE  — running, or it did anything in the last hour (steady)
 *   orange  UNREAD  — output she hasn't opened, or a session stopped to ask her
 *   red     ERROR   — the last turn ended in failure / was aborted
 *
 * RUNNING nests inside ACTIVE rather than competing with it — same colour, and
 * the breath is the difference, exactly as the cards already draw it.
 *
 * A BUTTON MEANS ITS COLOUR — the cards wearing it, nothing else. Press orange
 * and only orange cards come back. That's the whole contract, and it's why
 * there are two layers here rather than one:
 *
 *   sessionIs()     the raw fact — is this session unread / running / broken
 *   cardState()     those facts ranked into the ONE colour a card can wear
 *   matchesFilter() does that colour match the button she pressed
 *
 * The buttons used to ask sessionIs directly, which read as broken the moment
 * anything was in two states at once: a running session she hadn't read is
 * honestly unread, but its card paints purple, so the orange button handed back
 * purple cards (her 08-21 report). Filtering by the paint is what makes the
 * rail and the roster tell the same story. Full reasoning at FILTER_PAINT.
 *
 * They still UNION when several are pressed — purple and orange together is
 * every card that's alive or unwatched, not the sliver that's somehow both.
 * Nothing is unreachable; every card wears exactly one of these colours.
 *
 * `openedAt` comes from the same `exo-bot-opened` map as everything else —
 * passed in, never read here, so readReceipts.ts stays the only reader.
 *
 * Prompt that produced it: "buttons on the top right side by color — orange
 * for sessions that are not read, purple at the top for active/running
 * sessions (last used in the past hour), a red one that only appears when
 * there's an error/aborted one"; "you can press more than one at a time".
 */
import type { SessionMeta } from './api';
import { isUnread } from './readReceipts';

export type StateFilter = 'running' | 'active' | 'unread' | 'error';

/** Every button, in the order they stack. Anything that walks the whole set
 * (the counts, the tests) reads this rather than repeating the list. */
export const ALL_FILTERS: StateFilter[] = ['running', 'active', 'unread', 'error'];

/** "Last used in the past hour" — her words, and the whole definition of the
 * purple ACTIVE button's idle half. */
export const ACTIVE_WINDOW_MS = 60 * 60 * 1000;

/** Is this plainly TRUE of the session — regardless of what its card ends up
 * painted. The raw facts; `cardState` ranks them into one colour and
 * `matchesFilter` reads that colour back. Exported because the card needs the
 * bare fact in one place (SessionCard's unread accent): a running session that
 * she hasn't read is still unread, it just wears purple. */
export function sessionIs(
  meta: SessionMeta,
  openedAt: string | undefined,
  filter: StateFilter,
  nowMs: number = Date.now(),
): boolean {
  switch (filter) {
    case 'running':
      // A turn is in flight RIGHT NOW. Already staleness-corrected server-side
      // (routes/observatory.py), so there's no clock to consult and no window
      // to argue about — it's the one state that's simply true or not.
      //
      // A STRICT SUBSET of 'active' below, deliberately: a session running this
      // second was also used inside the last hour, so it counts under both.
      // That's the nesting she asked for — "only those actually active" beside
      // "active in the past hour" — not two rival definitions.
      return meta.running === true;
    case 'active': {
      // Running is the server's already-staleness-corrected value, so it wins
      // outright and needs no clock. Otherwise: did it do anything recently?
      // last_at moves on both her send and the turn's finish, which is exactly
      // "last used". Date.parse, not string maths — the server stamps zoneless
      // local time while other stamps here are UTC-with-Z (same reasoning as
      // isUnread).
      if (meta.running === true) return true;
      const last = Date.parse(meta.last_at ?? '');
      if (Number.isNaN(last)) return false;
      return nowMs - last <= ACTIVE_WINDOW_MS;
    }
    case 'unread':
      // A session that stopped to ask counts as unread even if she has opened
      // it since: the ask is still standing there unanswered.
      if (meta.awaiting_input || meta.awaiting_approval) return true;
      return isUnread(meta.last_at, openedAt);
    case 'error':
      return typeof meta.last_error === 'string' && meta.last_error !== '';
  }
}

/** What a card WEARS. Same three predicates as the buttons, read in precedence
 * order — so the rail and the cards can never drift apart, and "active in the
 * last hour" is written down exactly once (change ACTIVE_WINDOW_MS and both the
 * purple button's count and the purple dots move together).
 *
 *   error    red     the last turn failed — broken beats everything
 *   running  purple  a turn is going right now; the card breathes
 *   unread   orange  she hasn't read it, or it stopped to ask — her move
 *   recent   purple  used inside the hour but idle and read — warm, still
 *   rest     grey    cold
 *
 * ONE state per card, because a card can honestly be several of these at once
 * and stacking their glows would just muddy all of them. The order is by
 * urgency: what's broken beats what's busy beats what wants her.
 *
 * `recent` is the rung that was missing. The purple button counted these and
 * the card showed them grey — so the rail said "3 active" and the roster looked
 * dead. Steady purple, not the running card's breath: breath means a turn is
 * moving RIGHT NOW, and a session that merely ran twenty minutes ago isn't
 * moving. Two truths, two treatments.
 *
 * Prompt that produced it: "make the dots on the cards that are active and
 * activated by the filter, like active within the last hour, glow purple also
 * on the cards and tied together procedurally".
 */
export type CardState = 'error' | 'running' | 'unread' | 'recent' | 'rest';

export function cardState(
  meta: SessionMeta,
  openedAt: string | undefined,
  nowMs: number = Date.now(),
): CardState {
  if (sessionIs(meta, openedAt, 'error', nowMs)) return 'error';
  if (sessionIs(meta, openedAt, 'running', nowMs)) return 'running';
  if (sessionIs(meta, openedAt, 'unread', nowMs)) return 'unread';
  // Everything the purple button counts EXCEPT the running half, which already
  // has its own louder state above.
  if (sessionIs(meta, openedAt, 'active', nowMs)) return 'recent';
  return 'rest';
}

/* WHICH PAINT EACH BUTTON MEANS — and why the buttons read this rather than the
   raw facts above.

   Her 08-21 report: "if I click the orange button it doesn't filter to only
   orange." It didn't, and by the old design it couldn't. The buttons asked
   `sessionIs` (is this session unread?) while the cards asked `cardState`
   (which ONE colour does it wear?), and those two disagree constantly — a
   running session she hasn't read is honestly unread AND painted purple,
   because running outranks unread. So the orange button returned purple cards.
   On her roster that isn't an edge case: two of five sessions were running.

   Two ways out, and they can't both be had. Either a button keeps meaning the
   raw fact and the page goes on contradicting itself, or a button means exactly
   "the cards wearing this colour". She asked for the second and it's the right
   one: the rail's text labels are screen-reader-only, so each button IS its
   colour and nothing else. A colour that hands back another colour is wrong.

   RUNNING AND ACTIVE STILL NEST, because they're the same colour. Purple is
   worn both by a card running right now (breathing) and by one merely touched
   inside the hour (steady); Active means both, Running means only the breathing
   half. That's her original ask — "only those actually active" sitting inside
   "active in the past hour" — and it costs nothing here precisely because
   neither returns a card in a colour she didn't press.

   WHAT IT GIVES UP: a session that's both recent and unread now answers to
   ORANGE only, not purple, because orange is what it wears. Nothing becomes
   unreachable — the buttons still UNION, so purple and orange together is every
   card that's alive or unwatched. */
const FILTER_PAINT: Record<StateFilter, CardState[]> = {
  running: ['running'],
  active: ['running', 'recent'],
  unread: ['unread'],
  error: ['error'],
};

/** Does this card wear a colour the pressed button means — what the rail
 * filters and counts by, so the number on a button is the number of cards she
 * can see wearing it. */
export function matchesFilter(
  meta: SessionMeta,
  openedAt: string | undefined,
  filter: StateFilter,
  nowMs: number = Date.now(),
): boolean {
  return FILTER_PAINT[filter].includes(cardState(meta, openedAt, nowMs));
}

/** The sessions the ROOMS on the roster can actually draw — and therefore the
 * only ones the rail is allowed to count.
 *
 * The payload carries more than the page shows. Two kinds of session are lifted
 * out of the rooms on purpose:
 *
 *   pinned            the Keeper, hoisted above the rooms into its own slot and
 *                     deliberately exempt from these colours — it's the door to
 *                     her day, not something she's triaging
 *   origin nightcrew  worker sessions, which belong to the Night crew section
 *                     and are reached through their run card's session door
 *
 * WHY THIS IS A FUNCTION AND NOT A LINE IN THE PAGE. It used to be a line in
 * the page — inside the room split only — while the counts were taken over the
 * whole payload. The two drifted, which is the bug this file exists to prevent:
 * on her install the rail read "32 unread" and "3 errors" over 3 sessions
 * actually on screen, and all three red ones were night-crew workers, so the
 * red button reported breakage that existed nowhere she could reach and
 * pressing it emptied both rooms. Counting a population you don't render is
 * always this bug. One list, one definition, here.
 *
 * [prompt: "why does the orange one say 32 when i don't have that many open and
 * why does the red one say 3 when i don't see any"] */
export function roomRoster(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.filter((s) => !s.pinned && s.origin !== 'nightcrew');
}

/** How many sessions sit under each button — the number on its face, and (for
 * red) whether it's drawn at all. Feed it roomRoster(), never the raw payload. */
export function filterCounts(
  sessions: SessionMeta[],
  opened: Record<string, string>,
  nowMs: number = Date.now(),
): Record<StateFilter, number> {
  const counts: Record<StateFilter, number> = { running: 0, active: 0, unread: 0, error: 0 };
  for (const s of sessions) {
    for (const key of ALL_FILTERS) {
      if (matchesFilter(s, opened[s.id], key, nowMs)) counts[key] += 1;
    }
  }
  return counts;
}

/** Narrow a roster to the buttons she has pressed. More than one can be down at
 * a time, and they UNION: purple + orange means "show me what's alive AND what
 * I haven't read", not the sliver that's both. Intersecting would make the
 * second tap subtract, which is the opposite of what pressing another colour
 * looks like it should do — and since the buckets already overlap, most pairs
 * would land on almost nothing.
 *
 * No buttons down is the identity — the page renders the same list it always
 * did, and returns the very same array so React sees no change.
 *
 * Prompt that produced it: "you can press more than one at a time". */
export function applyFilter(
  sessions: SessionMeta[],
  opened: Record<string, string>,
  filters: StateFilter[],
  nowMs: number = Date.now(),
): SessionMeta[] {
  if (filters.length === 0) return sessions;
  return sessions.filter((s) =>
    filters.some((f) => matchesFilter(s, opened[s.id], f, nowMs)),
  );
}
