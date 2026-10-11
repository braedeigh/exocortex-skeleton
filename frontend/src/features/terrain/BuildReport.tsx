import { useMemo, useState } from 'react';
import { useBuildReport } from './buildsApi';
import {
  clockLabel,
  dayLabel,
  groupCommitsByDay,
  isBackupCommit,
  linesLabel,
  spanLabel,
  stampLabel,
} from './buildReport';
import type { FileTouchKind, SessionFootprintFile } from './terrainGraph';
import styles from './BuildReport.module.css';

/**
 * BuildReport — the written half of a map: what was built, by which
 * sessions, when. A reading column docked down the right edge of the map,
 * the same slot the Guide uses, so the map stays whole beside it. Every map
 * has one: a build's covers that one folder, the main map's covers the
 * folders this system is made of.
 *
 * Three parts, top to bottom:
 *   1. The summary — when the work happened, and how much of it there was.
 *   2. The sessions that touched this folder. Tapping a session (its name
 *      or "Footprint") rings that session's files on the map and unfolds two
 *      things under its row: the last summary a helper wrote of it, and the
 *      list of files it touched here — each one a button that opens the file.
 *      Tapping again folds it and clears the rings. "Open" goes to its
 *      conversation. A long list (the main map's runs to hundreds) shows its
 *      most recent sessions first, with a button for the rest.
 *   3. Every commit, grouped by day, newest first — except the hourly
 *      backup's own, which wait behind a "Show hourly backups" button. A day's heading is a
 *      button: it narrows the map's date range to that day, so the dots left
 *      standing are the files that day touched. Tapping it again clears it.
 *
 * The map and this column are two readings of one build, so the column only
 * ever ASKS the page for things (ring this session, show this day) — the
 * page owns the map's state. The data comes from one fetch of the build's
 * report (buildsApi.ts `useBuildReport`) — each session arrives with its
 * summary already on it, read from the database's `session_last_summary`
 * view by routes/terrain_builds.py. The file list is NOT fetched: the page
 * hands it in, read from the same map nodes the rings are drawn on. The
 * grouping into days is buildReport.ts.
 *
 * Prompt that produced it: "I want to be able to view other folders in my
 * terrain view so I can basically see a report of what happened."
 */

/** How many sessions the list shows before she asks for the rest. */
const SESSIONS_SHOWN_FIRST = 40;

/** How a session touched a file, in the word the list prints beside it. */
const TOUCH_WORD: Record<FileTouchKind, string> = {
  created: 'created',
  modified: 'changed',
  read: 'read',
};

export function BuildReport({
  buildId,
  open,
  onClose,
  range,
  onPickRange,
  spotlighted,
  onSpotlight,
  onOpenSession,
  files,
  onOpenFile,
}: {
  /** Which build's report; null is the main map's. */
  buildId: string | null;
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
  /** The ringed session's files on the map as it is drawn now, newest touch
   * first. Empty while no session is ringed. */
  files: SessionFootprintFile[];
  onOpenFile: (file: SessionFootprintFile) => void;
}) {
  const { data, isLoading, isError } = useBuildReport(buildId, open);
  // The commits she reads: the hourly backup's own are left out until she
  // asks for them, so the days list is the work and not the clock.
  const [showBackups, setShowBackups] = useState(false);
  const backupCount = useMemo(() => (data?.commits ?? []).filter(isBackupCommit).length, [data]);
  const days = useMemo(
    () => groupCommitsByDay((data?.commits ?? []).filter((commit) => showBackups || !isBackupCommit(commit))),
    [data, showBackups],
  );
  // The session list, cut to the most recent few until she asks for all of
  // them. The ringed session is always kept in, so a session she spotlit
  // from the map itself still unfolds here.
  const [allSessions, setAllSessions] = useState(false);
  const sessions = useMemo(() => {
    const every = data?.sessions ?? [];
    if (allSessions || every.length <= SESSIONS_SHOWN_FIRST) return every;
    return every.filter((session, at) => at < SESSIONS_SHOWN_FIRST || session.id === spotlighted);
  }, [data, allSessions, spotlighted]);

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
              <p className={styles.note}>No commits indexed yet.</p>
            )}
            <p className={styles.where}>{data.build.source ?? data.build.root}</p>

            {/* 2. The sessions that touched it. */}
            <h3 className={styles.heading}>Sessions</h3>
            {data.sessions.length === 0 ? (
              <p className={styles.note}>
                No agent session on this machine touched {buildId === null ? 'these folders' : 'this folder'}.
                {buildId === null ? '' : ' A repo cloned from GitHub has its history, not its builders.'}
              </p>
            ) : (
              <ul className={styles.list}>
                {sessions.map((session) => {
                  const on = spotlighted === session.id;
                  const toggle = () => onSpotlight(on ? null : session.id);
                  return (
                    <li key={session.id} className={styles.session}>
                      <div className={styles.sessionRow}>
                        {/* The session's name is a button too: tapping it does
                            what Footprint does. */}
                        <button
                          type="button"
                          className={styles.sessionText}
                          aria-expanded={on}
                          title="Ring this session's files on the map and show its summary"
                          onClick={toggle}
                        >
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
                        </button>
                        <div className={styles.sessionActions}>
                          <button
                            type="button"
                            className={[styles.action, on ? styles.actionOn : ''].filter(Boolean).join(' ')}
                            aria-pressed={on}
                            title="Ring this session's files on the map and show its summary"
                            onClick={toggle}
                          >
                            Footprint
                          </button>
                          <button type="button" className={styles.action} onClick={() => onOpenSession(session.id)}>
                            Open
                          </button>
                        </div>
                      </div>

                      {/* Unfolded under the ringed session: its last summary,
                          then its files. The summary is whatever a helper last
                          wrote — said plainly when none ever did. The files
                          are the ones lit on the map right now, so a date
                          range or a hidden file type shortens this list too. */}
                      {on ? (
                        <div className={styles.detail}>
                          <h4 className={styles.detailHead}>Last summary</h4>
                          {session.summary ? (
                            <>
                              <p className={styles.summaryText}>{session.summary}</p>
                              <p className={styles.meta}>
                                {[
                                  session.summary_source ? `Written by the ${session.summary_source}` : '',
                                  stampLabel(session.summary_at),
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </p>
                            </>
                          ) : (
                            <p className={styles.note}>
                              No summary was ever generated for this session. Open it to read the
                              conversation.
                            </p>
                          )}

                          <h4 className={styles.detailHead}>
                            Files touched{files.length > 0 ? ` · ${files.length.toLocaleString('en-US')}` : ''}
                          </h4>
                          {files.length === 0 ? (
                            <p className={styles.note}>None of its files are on the map as it&rsquo;s drawn now.</p>
                          ) : (
                            <ul className={styles.list}>
                              {files.map((file) => (
                                <li key={file.id}>
                                  <button type="button" className={styles.file} onClick={() => onOpenFile(file)}>
                                    <span className={styles.filePath}>{file.path}</span>
                                    <span className={styles.meta}>{TOUCH_WORD[file.kind]}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {data.sessions.length > sessions.length ? (
              <button type="button" className={styles.action} onClick={() => setAllSessions(true)}>
                Show all {data.sessions.length.toLocaleString('en-US')} sessions
              </button>
            ) : null}

            {/* 3. Every commit, by day. */}
            <h3 className={styles.heading}>Commits</h3>
            {data.commits_total > data.commits.length ? (
              <p className={styles.note}>
                Showing the newest {data.commits.length.toLocaleString('en-US')} of{' '}
                {data.commits_total.toLocaleString('en-US')}.
              </p>
            ) : null}
            {backupCount > 0 ? (
              <button
                type="button"
                className={[styles.action, styles.backups].join(' ')}
                aria-pressed={showBackups}
                onClick={() => setShowBackups(!showBackups)}
              >
                {showBackups
                  ? 'Hide the hourly backups'
                  : `Show ${backupCount.toLocaleString('en-US')} hourly ${backupCount === 1 ? 'backup' : 'backups'}`}
              </button>
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
