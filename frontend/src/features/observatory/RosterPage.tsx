/**
 * RosterPage.tsx — the Sessions page: every observatory session, in its room,
 * with the Keeper hoisted above them and the colour rail to filter by state.
 * The long note on RosterPage below is the page's design history. Touches
 * api.ts (the shared roster query and the session calls), SessionLane.tsx (the
 * cards), sessionFilters.ts (the rail), and the doors to the sub-rooms.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  LANE_LABEL,
  ROOMS,
  closeConversation,
  createSession,
  getHelpers,
  getLinearRoom,
  getResearchRoom,
  isRoom,
  toLane,
  updateConversation,
  useSessionRoster,
  type HelpersState,
  type LinearRoomState,
  type ResearchRoomState,
  type Room,
  type SessionMeta,
} from './api';
import { sessionLocation } from './sessionLocation';
import { openedMap, setConversationRead } from './readReceipts';
import { applyFilter, filterCounts, roomRoster, type StateFilter } from './sessionFilters';
import { SessionDialog, type SessionDraft } from './SessionDialog';
import { SessionLane } from './SessionLane';
import { NightCrewDoor } from './NightCrewDoor';
import { HelpersDoor } from './HelpersDoor';
import { LinearDoor } from './LinearDoor';
import { ResearchDoor } from './ResearchDoor';
import { SpinoffTreeDoor } from './SpinoffTreeDoor';
import { TokenBurnDoor } from './TokenBurnDoor';
import { SavedLane } from './SavedLane';
import { WorktreeMapDoor } from './WorktreeMapDoor';
import { SudoRequests } from '../sudo/SudoRequests';
import { MemoryMeter } from '../runqueue/MemoryMeter';
import { useTerrain } from '../terrain/api';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { ToastStack } from '../../ui';
import { ChatFinder } from './ChatFinder';
import styles from './RosterPage.module.css';

// The roster's sort order — by creation time, so cards never churn on
// activity. 'oldest' (the default) puts the earliest-made session at the top
// and the newest at the bottom; a header toggle flips it. Persisted so her
// choice survives reloads, mirroring the notes-pill sort.
type RosterSort = 'oldest' | 'newest';
const SORT_KEY = 'exo-observatory-sort';

function readStoredSort(): RosterSort {
  if (typeof localStorage === 'undefined') return 'oldest';
  return localStorage.getItem(SORT_KEY) === 'newest' ? 'newest' : 'oldest';
}

/** Everything by `started`, in the chosen direction. `started` back-fills to
 * last_at for legacy entries. Stable because it keys on a fixed timestamp —
 * the poll can't reshuffle it.
 *
 * Pinned still sorts to the front, though the Keeper is lifted clean out of
 * the rooms below and never reaches a lane. The rule stays because it's what
 * makes the hoist safe if there's ever more than one pinned session: they'd
 * arrive in the Keeper slot in a fixed order rather than whatever order the
 * roster payload happened to have. */
// Stable empties, so the memos below don't recompute while the roster loads.
const NO_SESSIONS: SessionMeta[] = [];
const NO_MODELS: string[] = [];

function sortRoster(sessions: SessionMeta[], dir: RosterSort): SessionMeta[] {
  const sign = dir === 'oldest' ? 1 : -1;
  return [...sessions].sort((a, b) => {
    const pin = (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1);
    if (pin !== 0) return pin;
    const as = a.started || a.last_at || '';
    const bs = b.started || b.last_at || '';
    return as < bs ? -sign : as > bs ? sign : 0;
  });
}

/** The floating rail, top to bottom, in her order: purple, orange, red. Each is
 * an independent toggle — any number can be down at once, and what's down is
 * unioned (see applyFilter). `onlyWhenPresent` is what makes red come and go: a
 * red button on a page with nothing broken is a permanent false alarm, so it
 * isn't drawn at all until something actually fails. */
const FILTERS: {
  key: StateFilter;
  /** The class carrying this button's --hue; every other rule reads from it. */
  hue: string;
  label: string;
  title: string;
  emptyNote: string;
  onlyWhenPresent?: boolean;
}[] = [
  {
    key: 'running',
    hue: 'filterHueRunning',
    label: 'Running',
    title: 'A turn is in flight right now',
    emptyNote: 'Nothing is running in this room right now.',
    onlyWhenPresent: true,
  },
  {
    key: 'active',
    hue: 'filterHueActive',
    label: 'Active',
    title: 'Running now, or used in the last hour',
    emptyNote: 'Nothing running or touched in the last hour.',
  },
  {
    key: 'unread',
    hue: 'filterHueUnread',
    label: 'Unread',
    title: 'Replies you haven’t opened, and sessions waiting on you',
    emptyNote: 'Nothing unread — you’re caught up here.',
  },
  {
    key: 'error',
    hue: 'filterHueError',
    label: 'Errors',
    title: 'Last turn failed or was aborted',
    emptyNote: 'Nothing broken in this room.',
    onlyWhenPresent: true,
  },
];

/** Each room's fuller introduction, in the page's own voice — headings come
 * from LANE_LABEL (api.ts), the shared single source, and the walk order from
 * ROOMS, so this page and the create dialog can't drift into offering
 * different sets. Keyed by Room, not Lane: a retired lane has no room to
 * introduce, and typing it this way makes TypeScript point here the moment the
 * set of rooms changes. */
const LANE_INTRO: Record<Room, string> = {
  personal:
    'You, talking, in real time — your life, not the build. Rooted where both repos meet, so it can reach everything, and it just acts, because you’re the one watching.',
  coding:
    'You, building, in real time. Rooted in the app code so it stands where the work is — and it just acts, same as Personal, because you’re still here.',
};

/**
 * /observatory — the Sessions page. A session is a SPACE, not a persona: she
 * summons whichever voices she wants inside it with slash commands (/spark,
 * /terra, /journalstart), exactly like a tmux session.
 *
 * ROOMS (her 07-27 call). The page used to render every session twice —
 * once in "My sessions" (the full roster) and again in "Orchestra" (a
 * `running || awaiting` filter over that same list). Same card, two places,
 * two visual languages, and no way to say where anything belonged. Now a
 * session is ASSIGNED to a lane and stays there; being live became a state its
 * card wears rather than a section it migrates into. One card, one home.
 *
 * TWO OF THEM (her 08-03 call — "separation of sessions that are personal
 * and those that are coding"). The old Personal room held both her life and
 * her build, which are the same in one respect (she's watching, so nothing
 * needs to stop and ask) and different in the one that matters day to day:
 * where the session STANDS. Personal is rooted at the parent of both repos
 * because a conversation about her life may need the vault; Coding is rooted
 * in the app checkout, because a build session that stands one level up can
 * drift into the vault and leave app code there. So the split is a real
 * boundary, not a label — see _lane_profile in routes/observatory.py.
 *
 * THERE WAS A THIRD (Orchestra — work running while she wasn't watching,
 * gated). She retired it 08-12: "remove the orchestra section from my
 * observatory for now." The room is gone from this page and from both pickers;
 * the LANE is untouched server-side, because it's still what night-crew workers
 * run in and still the fail-toward-ask lane the backend files anything it can't
 * place into. Everything Orchestra ever held is reachable under Past sessions,
 * and bringing the room back is adding 'orchestra' to ROOMS in api.ts.
 *
 * COLLAPSIBLE (same ask). Every room on this page shuts to its title line and
 * remembers it. The census stays on the header, so a shut room can't hide
 * something that wants her — LaneHead.tsx owns that rule.
 *
 * NIGHT CREW LEFT (her 08-21 call: "make night crew into its own separate room
 * ... i want it inside its own route inside of observatory, like you scroll
 * down and can click into it from that location"). It was the tallest section
 * here and the least like the rest: this page is for scanning what's live, and
 * night crew is finished work read once in the morning off cards with diffs,
 * screenshots and merge buttons. It's /observatory/nightcrew now, and what's
 * left in its old spot is a plain door (NightCrewDoor). This page fetches
 * nothing from /api/nightcrew — that call is slow, so it waits until she
 * actually walks through the door.
 *
 * THE KEEPER STANDS OUTSIDE ALL OF IT (her 08-03 ask). The one pinned session
 * is hoisted above the rooms into a slot of its own: no lane, no heading, no
 * chevron, and exempt from the rail's colour filters. It's the door to her
 * day, and every mechanism on this page that can make a card harder to reach —
 * being filed in a room, that room being shut, a filter narrowing it away —
 * is a mechanism that could put the door behind something. Its card wears a
 * teal ring and a 🌙 Keeper mark rather than a colour, because the colours here
 * all mean STATE and the Keeper still has to be able to say it's unread (see
 * .cardKeeper in SessionLane.module.css).
 *
 * THE COLOUR RAIL. Three buttons floating over the page's top-right, filtering
 * both rooms at once, in the colours the cards already wear: purple ACTIVE
 * (running, or used in the last hour), orange UNREAD, red ERRORS. Red isn't
 * drawn at all unless something is actually broken. Any number can be pressed
 * at once and what's pressed is unioned, so two colours widen the view rather
 * than narrowing it to their overlap. The predicates and the counts live in
 * sessionFilters.ts so the number on a button and the list behind it can't
 * disagree. Read state is hers to set either way — the dot button on each card
 * (SessionLane) writes it through readReceipts' setConversationRead.
 *
 * The order down the page is the two rooms she's PRESENT for (Personal, then
 * Coding), then the door to what ran underneath her (Night crew) — the things
 * she's doing above the things being done for her, which is the same instinct
 * as the 07-27 ordering call applied to a wider set. The ordering survived
 * night crew becoming a page: the door kept the spot the section held.
 *
 * DOCKED MODE (07-25): also the Sessions view of the desktop split's left
 * pane (shell/KeeperPane.tsx). `onOpenConversation` is the seam — opening a
 * card hands the id to the pane instead of routing the whole app.
 */
export function RosterPage({ onOpenConversation }: { onOpenConversation?: (convId: string) => void } = {}) {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  // The roster itself: the shared roster query (api.ts useSessionRoster), live
  // so a busy dot flips to ready on its own — a turn runs detached from any
  // one HTTP connection, so nothing else here would notice it finishing. The
  // tab bars ride the same query, so this page adds no second poller, and
  // React Query stops polling while the tab is hidden.
  const roster = useSessionRoster(true);
  const sessions = roster.data?.sessions ?? NO_SESSIONS;
  // Model aliases the server will accept — it stays the authority on the
  // list; an empty one just hides the picker.
  const modelChoices = roster.data?.model_choices ?? NO_MODELS;
  // A create/edit/close that failed shows the same banner as a failed load,
  // until the next successful read clears it.
  const [actionFailed, setActionFailed] = useState(false);
  useEffect(() => setActionFailed(false), [roster.dataUpdatedAt]);
  const failed = roster.isError || actionFailed;

  const [sortDir, setSortDir] = useState<RosterSort>(readStoredSort);
  // Which colours of the floating rail are pressed. Any number at once, empty
  // for the whole roster. Deliberately NOT persisted: a filter that survived a
  // reload would hide sessions she'd forgotten she'd hidden.
  const [filters, setFilters] = useState<StateFilter[]>([]);
  // Bumped when she flips a card's read dot, so the render that reads
  // localStorage runs again immediately instead of waiting for the 5.5s poll.
  const [, bumpOpened] = useState(0);
  // The create sheet: shut (null), or open holding which room it's making into.
  // Three states because there are two kinds of '+' on this page. A room's own
  // '+' has already answered "which room" with her thumb, so it passes its room
  // and the sheet opens agreeing with her. The rail's '+' floats beside the
  // whole roster and genuinely can't know, so it opens 'unset' — and the sheet
  // makes her pick rather than seeding one, because the room fixes where the
  // session RUNS, permanently. Her call, 08-21: no guessing on that field.
  const [creating, setCreating] = useState<Room | 'unset' | null>(null);
  const [editTarget, setEditTarget] = useState<SessionMeta | null>(null);

  // Re-read the roster now, after she changes something on it.
  const refresh = () => void roster.refetch();


  // The Helpers door's census — one fetch on mount, never polled; the page
  // behind the door owns the list.
  const [helpersState, setHelpersState] = useState<HelpersState | null>(null);
  const [researchState, setResearchState] = useState<ResearchRoomState | null>(null);
  const [linearState, setLinearState] = useState<LinearRoomState | null>(null);
  useEffect(() => {
    void getHelpers().then(setHelpersState).catch(() => setHelpersState(null));
    void getResearchRoom().then(setResearchState).catch(() => setResearchState(null));
    void getLinearRoom().then(setLinearState).catch(() => setLinearState(null));
  }, []);

  // ONE terrain poll for the whole page, passed down to both lanes — two
  // sections must not mean two pollers on the same endpoint. Live only while
  // something is actually running; an idle page needs no file ticking.
  const anyRunning = sessions.some((s) => s.running);
  const { data: terrain } = useTerrain(anyRunning, 350);

  const ordered = useMemo(() => sortRoster(sessions, sortDir), [sessions, sortDir]);
  const opened = openedMap();

  // Everything below — the rail's numbers AND the rooms' contents — comes off
  // ONE list, so a count can't describe a population the page doesn't draw.
  // roomRoster (sessionFilters.ts) owns what's eligible and why; it's a function
  // there rather than a line here precisely because the two used to disagree.
  const roomable = roomRoster(ordered, opened);

  // Recomputed every render, which is what keeps the hour window and the unread
  // comparison honest as the poll ticks.
  const counts = filterCounts(roomable, opened);
  const shown = applyFilter(roomable, opened, filters);

  // The come-and-go buttons (Running, Errors) vanish the moment their count
  // hits zero — so a pressed one has to let go too, or she'd be left narrowed
  // to a colour with no button left on screen to switch off. Driven off
  // `onlyWhenPresent` rather than naming a filter, so this can't be forgotten
  // the next time a button joins them.
  const vanished = FILTERS.filter((f) => f.onlyWhenPresent && counts[f.key] === 0)
    .map((f) => f.key)
    .join(',');
  useEffect(() => {
    if (!vanished) return;
    const gone = vanished.split(',') as StateFilter[];
    setFilters((cur) => (cur.some((f) => gone.includes(f)) ? cur.filter((f) => !gone.includes(f)) : cur));
  }, [vanished]);

  // The Keeper stands OUTSIDE the rooms (her 08-03 ask): one pinned session at
  // the top of the page, in no lane, with no chevron over it. It's the door to
  // her day — it shouldn't be something she can shut by accident, or something
  // she has to remember which room she filed it in.
  //
  // Read off `ordered`, not `shown`: the rail's colours narrow the ROSTER, the
  // work she's triaging, and the Keeper isn't that. Filtering to Unread and
  // watching the door to her day disappear would break the "always at the top"
  // promise the moment she used a filter.
  const keeper = ordered.filter((s) => s.pinned);
  // Sessions she saved for later: out of the rooms (roomRoster drops them) and
  // into their own shut section under them. Read off `ordered` like the Keeper,
  // so the rail's colours never narrow them away or count them.
  const saved = ordered.filter((s) => s.saved_at && !s.pinned);
  // The lane is server-resolved (it derives one for every session that predates
  // the field), so this is a straight split, not a guess. What's eligible at all
  // was already decided upstream by `roomable` — the Keeper isn't drawn twice
  // and night-crew workers stay in the Night crew section ("they showed up in
  // orchestra rather than in night crew"). Deciding it in one place is what
  // keeps the rail's numbers and these rooms describing the same set.
  //
  // NOTHING FALLS THROUGH THE FLOOR. Orchestra was retired as a room (her 08-12
  // ask) but survives as a lane: the server still files anything it can't place
  // there, and a session she'd made in it before would otherwise be on the
  // roster payload with no section to land in — invisible, unreachable, still
  // burning. So a session in a lane with no room shows up in Coding, which
  // stands on the same ground (the app checkout). What it DOES is unaffected:
  // the gate is resolved server-side from its own lane, so an Orchestra session
  // drawn here still stops and asks.
  const byLane = (room: Room) =>
    shown.filter((s) => {
      const lane = toLane(s.lane);
      return lane === room || (room === 'coding' && !isRoom(lane));
    });

  // What an empty lane says while the rail is narrowing it — "tap + to start
  // one" would be a lie there, and she'd make a session to fill a room that
  // isn't actually empty. One colour gets its own sentence; several get the
  // generic one, since spelling out every combination reads worse than not.
  const emptyNote =
    filters.length === 0
      ? undefined
      : filters.length === 1
        ? FILTERS.find((f) => f.key === filters[0])?.emptyNote
        : 'Nothing in this room is any of those right now.';

  // Her hand on the read flag, from the card's dot. The store is the truth;
  // this just makes the screen agree with it on the same tap.
  const setRead = (convId: string, read: boolean) => {
    setConversationRead(convId, read);
    bumpOpened((n) => n + 1);
  };

  const toggleSort = () => {
    setSortDir((cur) => {
      const next: RosterSort = cur === 'oldest' ? 'newest' : 'oldest';
      if (typeof localStorage !== 'undefined') localStorage.setItem(SORT_KEY, next);
      return next;
    });
  };

  const open = (convId: string) => {
    if (onOpenConversation) {
      onOpenConversation(convId);
      return;
    }
    void navigate(sessionLocation(convId));
  };

  const onCreate = (draft: SessionDraft) => {
    return createSession(draft.name, draft.journal, draft.model, draft.lane)
      .then(({ id }) => {
        setCreating(null);
        // An explicit asks-first choice is a second call: creation takes the
        // lane's default, and only a deliberate override gets written.
        if (draft.actGate !== null) {
          void updateConversation(id, { act_gate: draft.actGate }).catch(() => {});
        }
        open(id);
      })
      .catch(() => setActionFailed(true));
  };

  const onEdit = (draft: SessionDraft) => {
    if (!editTarget) return;
    // '' is meaningful for model (clear the pin), so it's always sent.
    updateConversation(editTarget.id, {
      title: draft.name,
      journal: draft.journal,
      model: draft.model,
      lane: draft.lane,
      act_gate: draft.actGate,
    })
      .then(() => {
        setEditTarget(null);
        refresh();
      })
      .catch(() => setActionFailed(true));
  };

  const onCloseSession = (convId: string) => {
    closeConversation(convId)
      .then(refresh)
      .catch(() => setActionFailed(true));
  };

  return (
    <div className={styles.page}>
      {/* Two columns: the roster, and a lane of its own on the right for the
          rail. .layoutRoomy widens that lane into the empty margin a full-width
          screen has either side of the 640px roster — it's off in the desktop
          split's docked pane, where the roster fills the pane and every pixel
          the lane took would come off the cards. */}
      <div
        className={[styles.layout, onOpenConversation ? '' : styles.layoutRoomy]
          .filter(Boolean)
          .join(' ')}
      >
        <div className={styles.inner}>
          {/* Just the title now — sort moved into the rail, so every control
              that acts on the roster lives in one column instead of two. */}
          {/* The title, and under it a hairline saying how full the box is.
              It sits in the HEADER rather than among the cards on purpose: it's
              the state of the room you just walked into, said once at the
              threshold, not a widget competing with her sessions. Quiet teal
              while there's room; it only speaks when things tighten. */}
          <div className={styles.header}>
            <h1 className={styles.title}>Observatory</h1>
            <MemoryMeter />
          </div>
          {/* Find a chat again: search every session, and under the empty box
              the ones she opened last. First thing under the title, so it's in
              reach before any scrolling. */}
          <ChatFinder onOpen={open} />
          {/* Agents waiting on her sudo password — orange, first thing in the room. */}
          <SudoRequests />
          {failed ? <div className={styles.pageError}>Couldn&rsquo;t load sessions.</div> : null}

          {keeper.length > 0 ? (
            <SessionLane
              keeper
              laneKey="keeper"
              heading="Keeper"
              blurb=""
              sessions={keeper}
              terrain={terrain}
              opened={opened}
              onOpen={open}
              onSetRead={setRead}
              onRename={setEditTarget}
              onChanged={refresh}
              onClose={onCloseSession}
            />
          ) : null}

          {/* Which agents are working in which copy of the code — at the top,
              just under the Keeper, so it's the first thing seen above the rooms. */}
          <WorktreeMapDoor />

          {ROOMS.map((lane) => (
            <SessionLane
              key={lane}
              laneKey={lane}
              heading={LANE_LABEL[lane]}
              blurb={LANE_INTRO[lane]}
              sessions={byLane(lane)}
              roster={ordered}
              terrain={terrain}
              opened={opened}
              emptyNote={emptyNote}
              onOpen={open}
              onNew={() => setCreating(lane)}
              onSetRead={setRead}
              onRename={setEditTarget}
              onChanged={refresh}
              onClose={onCloseSession}
            />
          ))}

          {/* Parked sessions, shut by default, right under the rooms they
              came from (SavedLane.tsx). */}
          <SavedLane sessions={saved} onOpen={open} onChanged={refresh} />

          {/* Night crew is a PAGE now, and this is the way in — left exactly
              where its section used to sit, because that's where she already
              scrolls to look for it. It carries no census: that call is slow, so
              the crew loads only once she clicks through. */}
          <NightCrewDoor />

          {/* The button-fired jobs (triage, recipe/receipt parses, person
              impressions) — a door like the night crew's, but carrying a census,
              where the "System agents — coming later" note used to sit. */}
          <HelpersDoor state={helpersState} />

          {/* The research room — her desk sessions and the dispatched research
              workers, which left tmux for this lane. A door like the two
              above; the sessions themselves stay out of the rooms
              (sessionFilters.roomRoster). */}
          <ResearchDoor state={researchState} />

          {/* The Linear room — sessions that work in Linear with her. A door
              like Research's, and its sessions stay out of the rooms too. */}
          <LinearDoor state={linearState} />

          {/* The spinoff family tree — which session came from which. */}
          <SpinoffTreeDoor />

          {/* What the agents spend — tokens by model, session, room and kind,
              and when. A plain door: the numbers load once she walks in. */}
          <TokenBurnDoor />

          {/* Seeded from the '+' she actually pressed, and NOT seeded at all
              from the rail's — that one gets a null lane, which makes the sheet
              open on "Choose a room…" with its button dead until she picks.
              No default there on purpose: the room fixes where the session runs
              for good, and a sheet that pre-answers the one irreversible field
              is making that choice for her. The heading follows suit — it only
              names a room when there's a room to name. */}
          <SessionDialog
            open={creating !== null}
            title={
              creating && creating !== 'unset'
                ? `New session in ${LANE_LABEL[creating]}`
                : 'New session'
            }
            lane={creating === 'unset' ? null : creating}
            modelChoices={modelChoices}
            onClose={() => setCreating(null)}
            onSave={onCreate}
          />
          {/* The ✎ sheet seeds "Asks first" from `act_gate_set` — her PIN — not
              from the resolved `act_gate`. Resolved is what the session
              currently DOES, which for an un-pinned Orchestra session is "asks"
              by inheritance; seeding from it made the picker read "Always ask",
              and saving wrote that back as a deliberate choice, so moving a
              session Orchestra → Personal carried every gate along with it. */}
          <SessionDialog
            open={editTarget !== null}
            title={editTarget ? `Edit ${editTarget.title || editTarget.id}` : 'Edit session'}
            initial={editTarget?.title ?? ''}
            initialJournal={editTarget?.journal === true}
            initialModel={editTarget?.model ?? ''}
            lane={toLane(editTarget?.lane)}
            editable
            initialActGate={editTarget?.act_gate_set ?? null}
            modelChoices={modelChoices}
            onClose={() => setEditTarget(null)}
            onSave={onEdit}
          />
        </div>

        {/* The rail, in its own lane and sticky so it floats alongside as the
            roster scrolls under it. Stacked, and the order down the column IS
            the ranking: the '+' to make something, then purple for what's
            alive, orange for what wants her, red for what's broken — and red
            only when it's true. Any number of the three can be down at once;
            what's down is unioned. A button with nothing behind it goes grey
            and unclickable rather than vanishing, so the rail never reshuffles
            under her thumb.
            [prompt: "stacked and put on the side floating next to the cards so
            that they don't overlap but are to the right"] */}
        <div className={styles.rail}>
          {/* New session — round, not a pill, and colourless: the three below
              it are STATES and this is an ACTION, so it can't be mistaken for a
              fourth colour. This one is the ROOMLESS '+': it floats beside the
              whole roster and follows her down the page, so it can't know which
              room she means — and it doesn't pretend to. It opens the sheet
              with the room blank and makes her say. The per-room '+' on each
              title line is the one that carries an answer with it. */}
          <button
            type="button"
            className={styles.railNew}
            onClick={() => setCreating('unset')}
            title="New session"
            aria-label="New session"
          >
            +
          </button>

          <div className={styles.filters} role="group" aria-label="Filter sessions by state">
            {FILTERS.map(({ key, hue, label, title, onlyWhenPresent }) => {
              const n = counts[key];
              if (onlyWhenPresent && n === 0) return null;
              const on = filters.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  className={[
                    styles.filterBtn,
                    styles[hue],
                    on ? styles.filterOn : '',
                    n === 0 ? styles.filterEmpty : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={on}
                  disabled={n === 0}
                  title={n === 0 ? `${title} — none right now` : title}
                  onClick={() =>
                    setFilters((cur) =>
                      cur.includes(key) ? cur.filter((f) => f !== key) : [...cur, key],
                    )
                  }
                >
                  <span className={styles.filterDot} aria-hidden="true" />
                  <span className={styles.filterCount}>{n}</span>
                  <span className={styles.filterLabel}>{label}</span>
                </button>
              );
            })}
          </div>

          {/* Utilities, under the colours and set apart from them. Ink, not
              hue: colour in this rail means STATE, so an action that isn't a
              state doesn't get to borrow one. Read state stays a per-card
              thing (the dot on each card) — there's no bulk clear. */}
          <div className={styles.railUtils}>
            <button
              type="button"
              className={styles.railUtil}
              onClick={toggleSort}
              title={
                sortDir === 'oldest'
                  ? 'Oldest first — tap for newest first'
                  : 'Newest first — tap for oldest first'
              }
              aria-label="Change session sort order"
            >
              <span className={styles.railUtilIcon} aria-hidden="true">
                {sortDir === 'oldest' ? '↓' : '↑'}
              </span>
              <span className={styles.railUtilLabel}>
                {sortDir === 'oldest' ? 'Oldest' : 'Newest'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* The same floating dev-notes / ideas pill every other page has — now
          in the docked pane too, since that's where this page is most often
          read and the notes are about the page in front of her.
          Docked, it tucks into the PANE's bottom-right corner rather than the
          viewport's — that one already holds the other pane's pill, and a
          second there would land on top of it.
          It files under 'terminal' — the same list the 📝 button on every
          session shows (shell/TermNotesPanel) — so the Observatory has one set
          of notes whichever button she reaches for.
          [prompt: "i also want the dev notes button on this page too"; "put the
          dev notes on the right corner and the other buttons on the left";
          "make the notes button on both every session and the roster page
          contain the same notes"] */}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <NotesPill
        tab="terminal"
        onError={push}
        anchor={onOpenConversation ? 'splitPane' : 'viewport'}
      />
    </div>
  );
}
