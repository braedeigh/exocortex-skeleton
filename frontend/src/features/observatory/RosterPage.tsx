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
import { openedMap } from './openedStore';
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
  // Which lane the '+' was tapped in — null when the create sheet is closed.
  const [newInLane, setNewInLane] = useState<Lane | null>(null);
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
  // The lane is server-resolved (it derives one for every session that predates
  // the field), so this is a straight split, not a guess. An unknown value
  // falls to Orchestra — the gated room, same fail-toward-ask as the backend.
  const byLane = (lane: Lane) =>
    ordered.filter((s) => (s.lane === 'personal' ? 'personal' : 'orchestra') === lane);

  const toggleSort = () => {
    setSortDir((cur) => {
      const next: RosterSort = cur === 'oldest' ? 'newest' : 'oldest';
      if (typeof localStorage !== 'undefined') localStorage.setItem(SORT_KEY, next);
      return next;
    });
  };
  const opened = openedMap();

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
        setNewInLane(null);
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
        <div className={styles.header}>
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
        {failed ? <div className={styles.pageError}>Couldn&rsquo;t load sessions.</div> : null}

        {LANES.map(({ lane, heading, blurb }) => (
          <SessionLane
            key={lane}
            lane={lane}
            heading={heading}
            blurb={blurb}
            sessions={byLane(lane)}
            terrain={terrain}
            opened={opened}
            onOpen={open}
            onNew={setNewInLane}
            onRename={setEditTarget}
            onChanged={refresh}
            onClose={onCloseSession}
          />
        ))}

        <div className={styles.laterNote}>
          System agents (triage, research, crons) —{' '}
          <span className={styles.laterEm}>coming later</span>
        </div>

        <SessionDialog
          open={newInLane !== null}
          title={newInLane === 'personal' ? 'New personal session' : 'New orchestra session'}
          lane={newInLane ?? 'orchestra'}
          modelChoices={modelChoices}
          onClose={() => setNewInLane(null)}
          onSave={onCreate}
        />
        <SessionDialog
          open={editTarget !== null}
          title={editTarget ? `Edit ${editTarget.title || editTarget.id}` : 'Edit session'}
          initial={editTarget?.title ?? ''}
          initialJournal={editTarget?.journal === true}
          initialModel={editTarget?.model ?? ''}
          lane={editTarget?.lane === 'personal' ? 'personal' : 'orchestra'}
          editable
          initialActGate={editTarget?.act_gate ?? null}
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
