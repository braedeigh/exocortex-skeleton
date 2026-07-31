import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  closeConversation,
  createSession,
  getSessions,
  updateConversation,
  type Lane,
  type SessionMeta,
} from './api';
import { openedMap, setConversationRead } from './openedStore';
import { applyFilter, filterCounts, type StateFilter } from './sessionFilters';
import { SessionDialog, type SessionDraft } from './SessionDialog';
import { SessionLane } from './SessionLane';
import { useTerrain } from '../terrain/api';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { ToastStack } from '../../ui';
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

/** Pinned (the Keeper) always on top; everything else by `started`, in the
 * chosen direction. `started` back-fills to last_at for legacy entries. Stable
 * because it keys on a fixed timestamp — the poll can't reshuffle it. */
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

const LANES: { lane: Lane; heading: string; blurb: string }[] = [
  {
    lane: 'personal',
    heading: 'Personal',
    blurb:
      'You, talking, in real time. Rooted where both repos meet, so it can reach everything — and it just acts, because you’re the one watching.',
  },
  {
    lane: 'orchestra',
    heading: 'Orchestra',
    blurb:
      'Work happening while you’re not. Rooted in the app code, and it stops to ask before anything irreversible.',
  },
];

/**
 * /observatory — the Sessions page. A session is a SPACE, not a persona: she
 * summons whichever voices she wants inside it with slash commands (/spark,
 * /terra, /journalstart), exactly like a tmux session.
 *
 * TWO ROOMS (her 07-27 call). The page used to render every session twice —
 * once in "My sessions" (the full roster) and again in "Orchestra" (a
 * `running || awaiting` filter over that same list). Same card, two places,
 * two visual languages, and no way to say where anything belonged. Now a
 * session is ASSIGNED to a lane and stays there; being live became a state its
 * card wears rather than a section it migrates into. One card, one home.
 *
 * THE COLOUR RAIL. Three buttons floating over the page's top-right, filtering
 * both rooms at once, in the colours the cards already wear: purple ACTIVE
 * (running, or used in the last hour), orange UNREAD, red ERRORS. Red isn't
 * drawn at all unless something is actually broken. Any number can be pressed
 * at once and what's pressed is unioned, so two colours widen the view rather
 * than narrowing it to their overlap. The predicates and the counts live in
 * sessionFilters.ts so the number on a button and the list behind it can't
 * disagree. Read state is hers to set either way — the dot button on each card
 * (SessionLane) writes it through openedStore's setConversationRead.
 *
 * Personal sits above Orchestra because it's the one she reaches for — the
 * Orchestra is what's running underneath, not the first thing in her face
 * (same instinct as the 07-27 ordering call, applied to the new split).
 *
 * DOCKED MODE (07-25): also the Sessions view of the desktop split's left
 * pane (shell/KeeperPane.tsx). `onOpenConversation` is the seam — opening a
 * card hands the id to the pane instead of routing the whole app.
 */
export function RosterPage({ onOpenConversation }: { onOpenConversation?: (convId: string) => void } = {}) {
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  // Model aliases the server will accept — it stays the authority on the
  // list; an empty one just hides the picker.
  const [modelChoices, setModelChoices] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  const [sortDir, setSortDir] = useState<RosterSort>(readStoredSort);
  // Which colours of the floating rail are pressed. Any number at once, empty
  // for the whole roster. Deliberately NOT persisted: a filter that survived a
  // reload would hide sessions she'd forgotten she'd hidden.
  const [filters, setFilters] = useState<StateFilter[]>([]);
  // Bumped when she flips a card's read dot, so the render that reads
  // localStorage runs again immediately instead of waiting for the 5.5s poll.
  const [, bumpOpened] = useState(0);
  // The create sheet, open or shut. It used to hold WHICH lane's '+' she
  // tapped; with one floating '+' for both rooms, the room is a field in the
  // sheet instead (SessionDialog), so this is just a boolean now.
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<SessionMeta | null>(null);

  const refresh = () => {
    getSessions()
      .then(({ sessions: list, model_choices }) => {
        setSessions(list);
        if (model_choices) setModelChoices(model_choices);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };

  useEffect(() => {
    refresh();
    // Gentle poll so a busy dot flips to ready on its own — a turn runs
    // detached from any one HTTP connection, so nothing else here would
    // notice it finishing.
    const id = setInterval(refresh, 5500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ONE terrain poll for the whole page, passed down to both lanes — two
  // sections must not mean two pollers on the same endpoint. Live only while
  // something is actually running; an idle page needs no file ticking.
  const anyRunning = sessions.some((s) => s.running);
  const { data: terrain } = useTerrain(anyRunning, 350);

  const ordered = useMemo(() => sortRoster(sessions, sortDir), [sessions, sortDir]);
  const opened = openedMap();
  // Counts for the rail, over the WHOLE roster — the buttons stand above both
  // rooms, so their numbers have to mean the same thing wherever a session
  // lives. Recomputed every render, which is what keeps the hour window and
  // the unread comparison honest as the poll ticks.
  const counts = filterCounts(ordered, opened);
  const shown = applyFilter(ordered, opened, filters);

  // Red vanishes the moment nothing is broken — so if it was pressed, it has to
  // let go too, or she'd be left narrowed to a colour with no button left to
  // switch off.
  useEffect(() => {
    if (counts.error === 0) {
      setFilters((cur) => (cur.includes('error') ? cur.filter((f) => f !== 'error') : cur));
    }
  }, [counts.error]);

  // The lane is server-resolved (it derives one for every session that predates
  // the field), so this is a straight split, not a guess. An unknown value
  // falls to Orchestra — the gated room, same fail-toward-ask as the backend.
  const byLane = (lane: Lane) =>
    shown.filter((s) => (s.lane === 'personal' ? 'personal' : 'orchestra') === lane);

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

  // The room page's route still carries a `$botId` URL segment (bots-
  // surface-design's file layout, un-nested via observatory_.$botId.tsx) —
  // but with the persona concept dissolved server-side there's no real bot
  // id to put there anymore. Minimal routing change: keep the route, fill
  // that segment with a fixed placeholder; the conversation id (the only
  // identity that still means anything) travels in `?conv=`.
  const open = (convId: string) => {
    if (onOpenConversation) {
      onOpenConversation(convId);
      return;
    }
    void navigate({ to: '/observatory/$botId', params: { botId: 'session' }, search: { conv: convId } });
  };

  const onCreate = (draft: SessionDraft) => {
    createSession(draft.name, draft.journal, draft.model, draft.lane)
      .then(({ id }) => {
        setCreating(false);
        // An explicit asks-first choice is a second call: creation takes the
        // lane's default, and only a deliberate override gets written.
        if (draft.actGate !== null) {
          void updateConversation(id, { act_gate: draft.actGate }).catch(() => {});
        }
        open(id);
      })
      .catch(() => setFailed(true));
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
      .catch(() => setFailed(true));
  };

  const onCloseSession = (convId: string) => {
    closeConversation(convId)
      .then(refresh)
      .catch(() => setFailed(true));
  };

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        {/* The colour rail, FLOATING over the page rather than parked in the
            header: it's sticky inside a zero-height row, so it takes no space
            in the flow and rides down the right edge as she scrolls — the
            counts stay reachable from anywhere in a long roster.

            Stacked, not spread: the order down the column IS the ranking —
            purple is what's alive, orange is what wants her, red is what's
            broken and only ever appears when it's true. Any number can be down
            at once; what's down is unioned. A button with nothing behind it
            goes grey and unclickable rather than vanishing, so the rail doesn't
            reshuffle under her thumb.
            [prompt: "i want them floating on the page rather than fixed at the
            top ... you can press more than one at a time"] */}
        <div className={styles.rail}>
          {/* New session — round, not a pill, and colourless: the three below it
              are STATES and this is an ACTION, so it can't be mistaken for a
              fourth colour. It floats here because the per-lane '+' used to sit
              in this exact column and the rail landed on top of it. One button
              for both rooms means the room is now a field in the sheet rather
              than something the button silently decided.
              [prompt: "they are also overlaid onto the + button as well. i need
              the + button to also float with them, maybe on the top"] */}
          <button
            type="button"
            className={styles.railNew}
            onClick={() => setCreating(true)}
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
        </div>

        <div className={styles.header}>
          <div className={styles.headLeft}>
            <h1 className={styles.title}>Observatory</h1>
            <button
              type="button"
              className={styles.sortBtn}
              onClick={toggleSort}
              title={
                sortDir === 'oldest'
                  ? 'Oldest first — tap for newest first'
                  : 'Newest first — tap for oldest first'
              }
              aria-label="Change session sort order"
            >
              {sortDir === 'oldest' ? 'Oldest first ↓' : 'Newest first ↑'}
            </button>
          </div>
        </div>
        {failed ? <div className={styles.pageError}>Couldn&rsquo;t load sessions.</div> : null}

        {LANES.map(({ lane, heading, blurb }) => (
          <SessionLane
            key={lane}
            heading={heading}
            blurb={blurb}
            sessions={byLane(lane)}
            terrain={terrain}
            opened={opened}
            emptyNote={emptyNote}
            onOpen={open}
            onSetRead={setRead}
            onRename={setEditTarget}
            onChanged={refresh}
            onClose={onCloseSession}
          />
        ))}

        <div className={styles.laterNote}>
          System agents (triage, research, crons) —{' '}
          <span className={styles.laterEm}>coming later</span>
        </div>

        {/* Seeded to Orchestra — the gated room, the same fail-toward-ask the
            backend uses for anything it can't place. A session made by accident
            should be one that stops and asks. */}
        <SessionDialog
          open={creating}
          title="New session"
          lane="orchestra"
          modelChoices={modelChoices}
          onClose={() => setCreating(false)}
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
          lane={editTarget?.lane === 'personal' ? 'personal' : 'orchestra'}
          editable
          initialActGate={editTarget?.act_gate_set ?? null}
          modelChoices={modelChoices}
          onClose={() => setEditTarget(null)}
          onSave={onEdit}
        />
      </div>

      {/* Same floating dev-notes / ideas pill as every other page — only on
          the full Observatory route, not the desktop split's docked pane. */}
      {!onOpenConversation ? (
        <>
          <ToastStack toasts={toasts} onDismiss={dismiss} />
          <NotesPill tab="observatory" onError={push} />
        </>
      ) : null}
    </div>
  );
}
