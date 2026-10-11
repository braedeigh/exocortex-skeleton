import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  assignLinearIssue,
  captureLinearIssue,
  commentOnLinearIssue,
  forgetLinearKey,
  getLinearBoard,
  saveLinearKey,
  setLinearIssueState,
  workOnLinearIssue,
  type LinearBoardState,
  type LinearColumn,
  type LinearIssue,
} from './api';
import { sessionLocation } from './sessionLocation';
import styles from './LinearBoard.module.css';

/**
 * LinearBoard — Linear itself, live, at the top of the Linear room's page.
 *
 * What it shows, top to bottom: a quick-capture box (a line becomes a new
 * issue in the team's Triage, or Backlog when the team has none), "Waiting on
 * you" (open issues assigned to her), then every status that has issues, in
 * board order. Finished statuses start shut. Tap an issue to act on it: change
 * its status, assign it, comment, open it in Linear, or "Work on this", which
 * starts a Linear session briefed with the issue and opens it.
 *
 * With no API key it's a setup card instead: where to make one, and a box to
 * paste it into. The key goes straight to the server (routes/linear_room.py),
 * which checks it with Linear and keeps it in a file. It's never shown back.
 *
 * Reads GET /api/linear-room/board. Nothing is polled: it loads once, reloads
 * after each change she makes here, and has a Refresh button for changes made
 * in Linear. Anything that closes an issue (Canceled, Duplicate) asks first.
 *
 * Prompt that produced it: "i want the linear room to reflect linear and the
 * MCP … i want to be able to interact with linear from that room."
 */
export function LinearBoard() {
  const navigate = useNavigate();
  const [board, setBoard] = useState<LinearBoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Load the board. `fresh` skips the server's half-minute cache.
  const load = useCallback((fresh = false) => {
    setRefreshing(true);
    return getLinearBoard(fresh)
      .then((b) => {
        setBoard(b);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't reach Linear."))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Open a session on an issue: the server mints it (or hands back the one
  // already on it) and the chat fires the brief on open.
  const workOn = (issue: LinearIssue) =>
    workOnLinearIssue(issue.id).then(({ id }) => void navigate(sessionLocation(id)));

  if (!board) {
    return (
      <section className={styles.board}>
        <div className={styles.quiet}>{error ?? 'Reading Linear…'}</div>
      </section>
    );
  }

  if (!board.configured) {
    return (
      <section className={styles.board}>
        <KeySetup
          refused={board.refused}
          help={board.key_help}
          fromEnv={board.key_from_env}
          onSaved={() => void load(true)}
        />
      </section>
    );
  }

  const shown = board.columns.filter((c) => c.issues.length > 0);
  const actions: IssueActions = {
    board,
    reload: () => load(true),
    workOn,
  };

  return (
    <section className={styles.board}>
      <div className={styles.head}>
        <h2 className={styles.heading}>
          {board.team.name} <span className={styles.muted}>· {board.issue_count} issues</span>
        </h2>
        <button
          type="button"
          className={styles.smallButton}
          onClick={() => void load(true)}
          disabled={refreshing}
          data-track="observatory-linear-refresh"
        >
          {refreshing ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {error ? <div className={styles.error}>{error}</div> : null}

      <Capture into={board.capture_into?.name ?? null} onCaptured={() => void load(true)} />

      {board.waiting_on_you.length > 0 ? (
        <div className={styles.waiting}>
          <h3 className={styles.subheading}>Waiting on you</h3>
          <ul className={styles.list}>
            {board.waiting_on_you.map((issue) => (
              <IssueRow key={issue.id} issue={issue} actions={actions} />
            ))}
          </ul>
        </div>
      ) : null}

      {board.issue_count === 0 ? (
        <div className={styles.quiet}>
          There are no issues in {board.team.name} yet. Capture one above, or start a Linear session below to plan with.
        </div>
      ) : (
        shown.map((column) => <Column key={column.id} column={column} actions={actions} />)
      )}

      <button
        type="button"
        className={styles.linkButton}
        onClick={() => {
          if (window.confirm('Forget the Linear API key on this server? The board goes back to the setup box.')) {
            void forgetLinearKey().then(() => load(true));
          }
        }}
      >
        Forget the API key
      </button>
    </section>
  );
}

/** What an issue row needs from the board: the team's statuses and people,
 * a reload after a change, and the "Work on this" door. */
interface IssueActions {
  board: Extract<LinearBoardState, { configured: true }>;
  reload: () => Promise<void>;
  workOn: (issue: LinearIssue) => Promise<void>;
}

// The statuses whose sections start shut: the work there is over.
const SHUT_TYPES = ['completed', 'canceled', 'duplicate'];
// Where each status section's open/shut choice is remembered.
const OPEN_KEY = 'linear-board-open';

function readOpenChoices(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** One status and its issues: a collapsible section that remembers whether
 * she left it open. */
function Column({ column, actions }: { column: LinearColumn; actions: IssueActions }) {
  const [open, setOpen] = useState(() => readOpenChoices()[column.id] ?? !SHUT_TYPES.includes(column.type));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpenChoices(), [column.id]: next }));
  };
  return (
    <div className={styles.column}>
      <button type="button" className={styles.columnHead} onClick={toggle} aria-expanded={open}>
        <span className={styles.chevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className={styles.dot} style={{ background: column.color ?? 'var(--text-muted)' }} aria-hidden="true" />
        <span className={styles.columnName}>{column.name}</span>
        <span className={styles.muted}>{column.issues.length}</span>
      </button>
      {open ? (
        <ul className={styles.list}>
          {column.issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} actions={actions} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One issue: a row that opens into what she can do to it. */
function IssueRow({ issue, actions }: { issue: LinearIssue; actions: IssueActions }) {
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { board } = actions;
  const status = board.columns.find((c) => c.id === issue.state_id);

  // Run one change against Linear, then reload so the board shows it.
  const act = (change: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    return change()
      .then(() => actions.reload())
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : 'Linear said no.'))
      .finally(() => setBusy(false));
  };

  // Move it to another status, asking first when that would close it.
  const onStatus = (stateId: string) => {
    const target = board.columns.find((c) => c.id === stateId);
    if (target && (target.type === 'canceled' || target.type === 'duplicate')) {
      if (!window.confirm(`Mark ${issue.identifier} as ${target.name}? That closes it in Linear.`)) return;
    }
    void act(() => setLinearIssueState(issue.id, stateId));
  };

  const details = [issue.project, issue.milestone, issue.assignee ? issue.assignee.name : 'Unassigned'].filter(
    Boolean,
  );

  return (
    <li className={[styles.issue, issue.blocked ? styles.issueBlocked : ''].filter(Boolean).join(' ')}>
      <button type="button" className={styles.issueRow} onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <span className={styles.issueMain}>
          <span className={styles.issueTitle}>
            <span className={styles.ident}>{issue.identifier}</span> {issue.title}
          </span>
          <span className={styles.issueLine}>
            {status && issue.mine ? `${status.name} · ` : ''}
            {details.join(' · ')}
            {issue.blocked ? (
              <span className={styles.blocked}>
                {' '}
                · Blocked by {issue.blocked_by.map((b) => b.identifier).join(', ')}
              </span>
            ) : null}
          </span>
        </span>
        <span className={styles.chevron} aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded ? (
        <div className={styles.actions}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Status</span>
            <select
              className={styles.select}
              value={issue.state_id}
              disabled={busy}
              onChange={(e) => onStatus(e.target.value)}
            >
              {board.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Assigned to</span>
            <select
              className={styles.select}
              value={issue.assignee?.id ?? ''}
              disabled={busy}
              onChange={(e) => void act(() => assignLinearIssue(issue.id, e.target.value || null))}
            >
              <option value="">Nobody</option>
              {board.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.me ? `You (${m.name})` : m.name}
                </option>
              ))}
            </select>
          </label>

          <textarea
            className={styles.textarea}
            placeholder="Add a comment (your collaborator reads these)"
            value={comment}
            rows={2}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.smallButton}
              disabled={busy || comment.trim() === ''}
              onClick={() => void act(() => commentOnLinearIssue(issue.id, comment.trim())).then(() => setComment(''))}
            >
              Comment
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                actions
                  .workOn(issue)
                  .catch((e: unknown) => setProblem(e instanceof Error ? e.message : "Couldn't start it."))
                  .finally(() => setBusy(false));
              }}
              data-track="observatory-linear-work"
            >
              Work on this
            </button>
            <a className={styles.smallButton} href={issue.url} target="_blank" rel="noreferrer">
              Open in Linear ↗
            </a>
          </div>
          {issue.blocked_by.length > 0 ? (
            <div className={styles.issueLine}>
              Blocked by: {issue.blocked_by.map((b) => `${b.identifier} ${b.title}`).join('; ')}
            </div>
          ) : null}
          {issue.blocks.length > 0 ? <div className={styles.issueLine}>Blocks: {issue.blocks.join(', ')}</div> : null}
          {problem ? <div className={styles.error}>{problem}</div> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Quick capture: a line she types becomes a new issue where the team sorts
 * new things. The first line is the title; anything after it, the description. */
function Capture({ into, onCaptured }: { into: string | null; onCaptured: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!into) return null;
  const submit = () => {
    setBusy(true);
    setNote(null);
    captureLinearIssue(text.trim())
      .then((made) => {
        setText('');
        setNote(`Filed ${made.identifier} in ${made.status}.`);
        onCaptured();
      })
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : "Couldn't file it."))
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.capture}>
      <textarea
        className={styles.textarea}
        placeholder={`Capture an issue into ${into}: "that's a bug in …" (your collaborator can read it)`}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
      />
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || text.trim() === ''}
          onClick={submit}
          data-track="observatory-linear-capture"
        >
          {busy ? 'Filing…' : `Add to ${into}`}
        </button>
        {note ? <span className={styles.muted}>{note}</span> : null}
      </div>
    </div>
  );
}

/** No key yet (or a refused one): where to make it, and a box to paste it in. */
function KeySetup({
  refused,
  help,
  fromEnv,
  onSaved,
}: {
  refused: boolean;
  help: string;
  fromEnv: boolean;
  onSaved: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = () => {
    setBusy(true);
    setProblem(null);
    saveLinearKey(key.trim())
      .then(() => {
        setKey('');
        onSaved();
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : "Couldn't save it."))
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.setup}>
      <h2 className={styles.heading}>Connect this page to Linear</h2>
      <p className={styles.setupText}>
        {refused
          ? 'Linear refused the key this server has. It may have been revoked. Make a new one and paste it here.'
          : 'Your sessions reach Linear through their own sign-in, but this page needs a key of its own to show the board and change it.'}
      </p>
      <p className={styles.setupText}>{help}</p>
      {fromEnv ? (
        <p className={styles.setupText}>
          This install sets the key in the EXOCORTEX_LINEAR_API_KEY environment variable, and that one wins over the box.
        </p>
      ) : null}
      <input
        className={styles.input}
        type="password"
        autoComplete="off"
        placeholder="lin_api_…"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || key.trim() === ''}
          onClick={save}
          data-track="observatory-linear-key"
        >
          {busy ? 'Checking with Linear…' : 'Save key'}
        </button>
      </div>
      {problem ? <div className={styles.error}>{problem}</div> : null}
    </div>
  );
}
