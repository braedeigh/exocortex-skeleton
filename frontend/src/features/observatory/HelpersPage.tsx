import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getHelpers, type HelperRun, type HelpersState } from './api';
import { sessionLocation } from './sessionLocation';
import pageStyles from './NightCrewPage.module.css';
import styles from './HelpersPage.module.css';

/**
 * /observatory/helpers — what the button-fired Claude jobs have run.
 *
 * A READING surface, like the night crew's page: nothing here is a
 * conversation she's mid-way through. Each row is one run — what kind of job,
 * what it was about, when, whether it's still going or failed, what it cost —
 * and tapping it opens the session so she can read what happened. Archived
 * runs stay in the list (that's the point: "see what has run in the past");
 * they're just dimmer.
 *
 * Reads GET /api/helpers (routes/helpers.py). Polled only while a run is
 * live, so an idle history page costs nothing.
 */
export function HelpersPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<HelpersState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getHelpers()
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

  const runs = state?.runs ?? [];

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
          <h1 className={pageStyles.title}>Helpers</h1>
        </div>

        <p className={styles.intro}>
          The small jobs a button fires — 🧭 Triage, recipe and receipt parses, person
          impressions. Every run lands here so you can see what happened, even after it's closed.
        </p>

        {error ? <div className={styles.empty}>{error}</div> : null}
        {!error && state && runs.length === 0 ? (
          <div className={styles.empty}>Nothing has run yet.</div>
        ) : null}

        <ul className={styles.list}>
          {runs.map((r) => (
            <HelperRow key={r.id} run={r} onOpen={() => void navigate(sessionLocation(r.id))} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function HelperRow({ run, onOpen }: { run: HelperRun; onOpen: () => void }) {
  const status = run.running ? 'running' : run.last_error ? 'failed' : run.archived ? 'closed' : 'done';
  const cost = run.tokens?.cost_usd;
  return (
    <li>
      <button
        type="button"
        className={[styles.row, styles[`row_${status}`] ?? ''].filter(Boolean).join(' ')}
        onClick={onOpen}
      >
        <span className={styles.rowMain}>
          <span className={styles.rowTitle}>
            <span className={styles.kind}>{run.label}</span>
            {run.title ? <span className={styles.title}>{run.title}</span> : null}
          </span>
          <span className={styles.rowLine}>
            {when(run.started)}
            {' · '}
            <span className={styles[`status_${status}`]}>{statusWord(status)}</span>
            {run.last_error ? <span className={styles.err}> — {run.last_error}</span> : null}
          </span>
        </span>
        {typeof cost === 'number' ? <span className={styles.cost}>${cost.toFixed(2)}</span> : null}
        <span className={styles.arrow} aria-hidden="true">
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
