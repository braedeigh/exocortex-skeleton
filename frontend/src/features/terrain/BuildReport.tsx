import { useMemo } from 'react';
import { useBuildReport } from './buildsApi';
import {
  clockLabel,
  dayLabel,
  groupCommitsByDay,
  linesLabel,
  spanLabel,
} from './buildReport';
import styles from './BuildReport.module.css';

/**
 * BuildReport — the written half of a build's map: what was built, by which
 * sessions, when. A reading column docked down the right edge of the map,
 * the same slot the Guide uses, so the map stays whole beside it.
 *
 * Three parts, top to bottom:
 *   1. The summary — when the work happened, and how much of it there was.
 *   2. The sessions that touched this folder. "Footprint" rings that
 *      session's files on the map; "Open" goes to its conversation.
 *   3. Every commit, grouped by day, newest first. A day's heading is a
 *      button: it narrows the map's date range to that day, so the dots left
 *      standing are the files that day touched. Tapping it again clears it.
 *
 * The map and this column are two readings of one build, so the column only
 * ever ASKS the page for things (ring this session, show this day) — the
 * page owns the map's state. The data comes from one fetch of the build's
 * report (buildsApi.ts `useBuildReport`); the grouping into days is
 * buildReport.ts.
 *
 * Prompt that produced it: "I want to be able to view other folders in my
 * terrain view so I can basically see a report of what happened."
 */
export function BuildReport({
  buildId,
  open,
  onClose,
  range,
  onPickRange,
  spotlighted,
  onSpotlight,
  onOpenSession,
}: {
  buildId: string;
  open: boolean;
  onClose: () => void;
  /** The map's date range while she has one set, so the matching day reads as on. */
  range: { from: number; to: number } | null;
  /** Narrow the map to a span, or null to clear it. */
  onPickRange: (range: { from: number; to: number } | null) => void;
  /** The session whose footprint is ringed on the map right now. */
  spotlighted: string | null;
  onSpotlight: (sessionId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { data, isLoading, isError } = useBuildReport(open ? buildId : null);
  const days = useMemo(() => groupCommitsByDay(data?.commits ?? []), [data]);

  if (!open) return null;
  const summary = data?.summary ?? null;

  return (
    <aside className={styles.panel} aria-label="Build report">
      <header className={styles.header}>
        <h2 className={styles.title}>{data?.build.name ?? 'Report'}</h2>
        <button type="button" className={styles.close} aria-label="Close the report" onClick={onClose}>
          ×
        </button>
      </header>

      <div className={styles.body}>
        {isLoading ? <p className={styles.note}>Loading the report…</p> : null}
        {isError ? <p className={styles.note}>Couldn&rsquo;t load the report.</p> : null}

        {data ? (
          <>
            {/* 1. The summary. */}
            {summary && summary.commits > 0 ? (
              <dl className={styles.summary}>
                <div>
                  <dt>When</dt>
                  <dd>{spanLabel(summary.first, summary.last)}</dd>
                </div>
                <div>
                  <dt>Days worked</dt>
                  <dd>{summary.days.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt>Commits</dt>
                  <dd>{summary.commits.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt>Files</dt>
                  <dd>{summary.files.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt>Lines</dt>
                  <dd>{linesLabel(summary.added, summary.removed)}</dd>
                </div>
              </dl>
            ) : (
              <p className={styles.note}>No commits indexed for this build yet.</p>
            )}
            <p className={styles.where}>{data.build.source ?? data.build.root}</p>

            {/* 2. The sessions that touched it. */}
            <h3 className={styles.heading}>Sessions</h3>
            {data.sessions.length === 0 ? (
              <p className={styles.note}>
                No agent session on this machine touched this folder. A repo cloned from GitHub
                has its history, not its builders.
              </p>
            ) : (
              <ul className={styles.list}>
                {data.sessions.map((session) => (
                  <li key={session.id} className={styles.session}>
                    <div className={styles.sessionText}>
                      <span className={styles.sessionTitle}>
                        {session.running ? <span className={styles.running} aria-label="running" /> : null}
                        {session.title}
                      </span>
                      <span className={styles.meta}>
                        {session.files} {session.files === 1 ? 'file' : 'files'}
                        {' · '}
                        {session.writes} {session.writes === 1 ? 'write' : 'writes'}
                        {session.reads > 0 ? ` · ${session.reads} ${session.reads === 1 ? 'read' : 'reads'}` : ''}
                      </span>
                    </div>
                    <div className={styles.sessionActions}>
                      <button
                        type="button"
                        className={[styles.action, spotlighted === session.id ? styles.actionOn : '']
                          .filter(Boolean)
                          .join(' ')}
                        aria-pressed={spotlighted === session.id}
                        title="Ring this session's files on the map"
                        onClick={() => onSpotlight(spotlighted === session.id ? null : session.id)}
                      >
                        Footprint
                      </button>
                      <button type="button" className={styles.action} onClick={() => onOpenSession(session.id)}>
                        Open
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* 3. Every commit, by day. */}
            <h3 className={styles.heading}>Commits</h3>
            {data.commits_total > data.commits.length ? (
              <p className={styles.note}>
                Showing the newest {data.commits.length.toLocaleString('en-US')} of{' '}
                {data.commits_total.toLocaleString('en-US')}.
              </p>
            ) : null}
            {days.map((day) => {
              const on = range !== null && range.from === day.from && range.to === day.to;
              return (
                <section key={day.day} className={styles.day}>
                  <button
                    type="button"
                    className={[styles.dayHead, on ? styles.dayHeadOn : ''].filter(Boolean).join(' ')}
                    aria-pressed={on}
                    title={on ? 'Show every day on the map again' : 'Show only this day on the map'}
                    onClick={() => onPickRange(on ? null : { from: day.from, to: day.to })}
                  >
                    <span className={styles.dayName}>{dayLabel(day.day)}</span>
                    <span className={styles.meta}>
                      {day.commits.length} {day.commits.length === 1 ? 'commit' : 'commits'}
                      {' · '}
                      {linesLabel(day.added, day.removed)}
                    </span>
                  </button>
                  <ul className={styles.list}>
                    {day.commits.map((commit) => (
                      <li key={commit.sha} className={styles.commit}>
                        <span className={styles.time}>{clockLabel(commit.ts)}</span>
                        <span className={styles.commitText}>
                          <span className={styles.subject}>{commit.subject || '(no message)'}</span>
                          <span className={styles.meta}>
                            {commit.files} {commit.files === 1 ? 'file' : 'files'}
                            {' · '}
                            {linesLabel(commit.added, commit.removed)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        ) : null}
      </div>
    </aside>
  );
}
