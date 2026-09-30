import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  createSession,
  getLinearRoom,
  updateConversation,
  type LinearRoomSession,
  type LinearRoomState,
} from './api';
import { sessionLocation } from './sessionLocation';
import { SessionDialog, type SessionDraft } from './SessionDialog';
import { LinearBoard } from './LinearBoard';
import pageStyles from './NightCrewPage.module.css';
import rowStyles from './HelpersPage.module.css';
import styles from './ResearchPage.module.css';

/**
 * /observatory/linear — the Linear room.
 *
 * Every session here works in Linear, the outside issue tracker, with her,
 * through the `linear` MCP server. They all stand in the linear-room folder,
 * whose CLAUDE.md (kept in her vault) says which team and which plan, and
 * what must never be written to an outside service.
 *
 * "+ New Linear session" creates a session in the lane through the same door
 * the roster's per-room '+' uses (createSession, with the lane fixed to
 * `linear`), then opens it. The roster's pickers don't offer this lane,
 * because it has no room block there.
 *
 * Above the sessions sits LinearBoard: Linear itself, live (the team's
 * issues by status, what's waiting on her, quick capture, and a "Work on
 * this" per issue that starts a session briefed with it).
 *
 * Reads GET /api/linear-room (routes/linear_room.py). The page polls only
 * while a session is running, so an idle page costs nothing. Archived
 * sessions stay in the list, dimmer. The layout reuses the Research page's
 * styles.
 */
export function LinearPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<LinearRoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getLinearRoom()
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

  // Mint a desk session in the Linear lane and go straight to it. An
  // explicit asks-first choice is a second call, same as the roster: creation
  // takes the lane's default and only a deliberate override gets written.
  const onCreate = (draft: SessionDraft) => {
    setCreateFailed(false);
    createSession(draft.name, draft.journal, draft.model, 'linear')
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
          <h1 className={pageStyles.title}>Linear</h1>
        </div>

        <p className={rowStyles.intro}>
          Work in Linear together. The board below is Linear itself, live. A session here can read and
          change your Linear workspace (issues, projects, milestones, documents) and knows the plan it's
          working from.
        </p>

        <LinearBoard />

        <h2 className={styles.sectionHeading}>Sessions</h2>

        <button
          type="button"
          className={styles.newButton}
          onClick={() => setCreating(true)}
          data-track="observatory-linear-new"
        >
          + New Linear session
        </button>
        {createFailed ? <div className={rowStyles.empty}>Couldn't start the session.</div> : null}

        {error ? <div className={rowStyles.empty}>{error}</div> : null}
        {!error && state && sessions.length === 0 ? (
          <div className={rowStyles.empty}>Nothing has run here yet.</div>
        ) : null}

        <ul className={rowStyles.list}>
          {sessions.map((s) => (
            <LinearRow key={s.id} session={s} onOpen={() => void navigate(sessionLocation(s.id))} />
          ))}
        </ul>

        <SessionDialog
          open={creating}
          title="New Linear session"
          lane="linear"
          modelChoices={state?.model_choices ?? []}
          onClose={() => setCreating(false)}
          onSave={onCreate}
        />
      </div>
    </div>
  );
}

function LinearRow({ session, onOpen }: { session: LinearRoomSession; onOpen: () => void }) {
  const status = session.running
    ? 'running'
    : session.last_error
      ? 'failed'
      : session.archived
        ? 'closed'
        : 'done';
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
            {session.title ? <span className={rowStyles.title}>{session.title}</span> : null}
          </span>
          <span className={rowStyles.rowLine}>
            {when(session.started)}
            {' · '}
            <span className={rowStyles[`status_${status}`]}>{statusWord(status)}</span>
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
