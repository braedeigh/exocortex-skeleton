import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  createSession,
  getResearchRoom,
  updateConversation,
  type ResearchRoomSession,
  type ResearchRoomState,
} from './api';
import { sessionLocation } from './sessionLocation';
import { SessionDialog, type SessionDraft } from './SessionDialog';
import pageStyles from './NightCrewPage.module.css';
import rowStyles from './HelpersPage.module.css';
import styles from './ResearchPage.module.css';

/**
 * /observatory/research — the research room.
 *
 * Two kinds of session share this list, and the page tells them apart by one
 * word on the row: a DESK session she opened here to think and query her own
 * tables with, and a WORKER the run dispatcher started to answer one question
 * or distill one topic (those carry a `research_session_id`, the research.json
 * record they served). Both live in the `research` lane — rooted in the
 * research-room folder, whose CLAUDE.md teaches the read-only query door and
 * the one write door — so opening either shows the same kind of transcript.
 *
 * "+ New research session" mints a desk session in the lane through the same
 * create door the roster's per-room '+' uses (createSession, lane fixed to
 * `research`) and opens it. The lane is passed INTO the sheet, so this is the
 * one place research is offered as a room to create in — the roster's pickers
 * don't list it, because it isn't a room block there.
 *
 * Reads GET /api/research-room (routes/research_room.py). Polled only while a
 * session is live, so an idle history page costs nothing. Archived sessions
 * stay in the list, dimmer — the point of the room is to see what ran.
 */
export function ResearchPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<ResearchRoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getResearchRoom()
        .then((s) => {
          if (alive) setState(s);
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : "Couldn't load.");
        });
    void load();
    const id = window.setInterval(() => {
      if (state?.running) void load();
    }, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [state?.running]);

  // Mint a desk session in the research lane and go straight to it. An
  // explicit asks-first choice is a second call, same as the roster: creation
  // takes the lane's default and only a deliberate override gets written.
  const onCreate = (draft: SessionDraft) => {
    setCreateFailed(false);
    createSession(draft.name, draft.journal, draft.model, 'research')
      .then(({ id }) => {
        setCreating(false);
        if (draft.actGate !== null) {
          void updateConversation(id, { act_gate: draft.actGate }).catch(() => {});
        }
        void navigate(sessionLocation(id));
      })
      .catch(() => setCreateFailed(true));
  };

  const sessions = state?.sessions ?? [];

  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.inner}>
        <div className={pageStyles.header}>
          <button
            type="button"
            className={pageStyles.back}
            onClick={() => void navigate({ to: '/observatory' })}
          >
            &larr; Observatory
          </button>
          <h1 className={pageStyles.title}>Research</h1>
        </div>

        <p className={rowStyles.intro}>
          Your research desk, and the workers that answer your questions. A desk session can read
          your tables through a read-only door and write research back for you to review; a worker
          is one the dispatcher started for a single question or topic.
        </p>

        <button
          type="button"
          className={styles.newButton}
          onClick={() => setCreating(true)}
          data-track="observatory-research-new"
        >
          + New research session
        </button>
        {createFailed ? <div className={rowStyles.empty}>Couldn't start the session.</div> : null}

        {error ? <div className={rowStyles.empty}>{error}</div> : null}
        {!error && state && sessions.length === 0 ? (
          <div className={rowStyles.empty}>Nothing has run here yet.</div>
        ) : null}

        <ul className={rowStyles.list}>
          {sessions.map((s) => (
            <ResearchRow key={s.id} session={s} onOpen={() => void navigate(sessionLocation(s.id))} />
          ))}
        </ul>

        <SessionDialog
          open={creating}
          title="New research session"
          lane="research"
          modelChoices={state?.model_choices ?? []}
          onClose={() => setCreating(false)}
          onSave={onCreate}
        />
      </div>
    </div>
  );
}

function ResearchRow({ session, onOpen }: { session: ResearchRoomSession; onOpen: () => void }) {
  const status = session.running
    ? 'running'
    : session.last_error
      ? 'failed'
      : session.archived
        ? 'closed'
        : 'done';
  const kind = session.research_session_id ? 'Worker' : 'Desk';
  const cost = session.tokens?.cost_usd;
  return (
    <li>
      <button
        type="button"
        className={[rowStyles.row, rowStyles[`row_${status}`] ?? ''].filter(Boolean).join(' ')}
        onClick={onOpen}
      >
        <span className={rowStyles.rowMain}>
          <span className={rowStyles.rowTitle}>
            <span className={rowStyles.kind}>{kind}</span>
            {session.title ? <span className={rowStyles.title}>{session.title}</span> : null}
          </span>
          <span className={rowStyles.rowLine}>
            {when(session.started)}
            {' · '}
            <span className={rowStyles[`status_${status}`]}>{statusWord(status)}</span>
            {session.research_session_id ? (
              <span className={styles.sessionRef}> · session {session.research_session_id}</span>
            ) : null}
            {session.last_error ? <span className={rowStyles.err}> — {session.last_error}</span> : null}
          </span>
        </span>
        {typeof cost === 'number' ? <span className={rowStyles.cost}>${cost.toFixed(2)}</span> : null}
        <span className={rowStyles.arrow} aria-hidden="true">
          &rarr;
        </span>
      </button>
    </li>
  );
}

function statusWord(s: string) {
  return s === 'running' ? 'running' : s === 'failed' ? 'failed' : s === 'closed' ? 'closed' : 'finished';
}

/** "Aug 22, 3:14 PM" — local, short; the year only when it isn't this one. */
function when(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}
