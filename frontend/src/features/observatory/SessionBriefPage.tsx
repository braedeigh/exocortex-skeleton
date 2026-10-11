/**
 * SessionBriefPage.tsx — what one spun-off session was asked to do, and what
 * it was handed.
 *
 * What this is, in plain English: a session started by /spinoff, a helper, a
 * button or a continuation begins from a BRIEF. Briefs are kept in the app's
 * database (briefstore.py), not as files, so this page is where she reads
 * one. It shows, top to bottom:
 *   - the brief itself, whole, tagged with the job's name and the date it was
 *     written, who wrote it, and which session it continues;
 *   - the files that were pasted into the session's hidden instructions when
 *     it started, the ones too big to paste, and those instructions whole;
 *   - any handoff: the one this session was started from, and the one it
 *     wrote when it filled its context and handed its work on.
 * Nothing here is edited: a brief is a record once its session has started.
 *
 * Touches: api.ts (useSessionBrief), routes/spinoff.py (`session_brief`, GET
 * /api/spinoff/brief/<conv>), routes/observatory_.brief.$convId.tsx (the
 * route), sessionLocation.ts, SessionBriefPage.module.css,
 * SwarmPage.module.css (the sections), NightCrewPage.module.css (the page
 * chrome). Reached from the "brief" button in a spun-off session's chat.
 *
 * Prompt that produced it: "Let's put it in the database" — with the room
 * helper's note that she reads a brief "on the session's own page in the
 * Observatory. The first message already shows it; handoffs and what was
 * preloaded should be readable there too."
 */
import { useNavigate } from '@tanstack/react-router';
import { useSessionBrief, type NamedSession } from './api';
import pageStyles from './NightCrewPage.module.css';
import styles from './SessionBriefPage.module.css';
import { sessionLocation } from './sessionLocation';
import swarmStyles from './SwarmPage.module.css';

/** "2026-10-02T22:43:36" as "2026-10-02 22:43". */
function when(stamp: string | null): string {
  return stamp ? stamp.slice(0, 16).replace('T', ' ') : '';
}

export function SessionBriefPage({ convId }: { convId: string }) {
  const navigate = useNavigate();
  const { data, error } = useSessionBrief(convId);

  // A link to another session's chat, by its title.
  const sessionLink = (session: NamedSession) => (
    <button type="button" className={styles.link} onClick={() => void navigate(sessionLocation(session.id))}>
      {session.title}
    </button>
  );

  const brief = data?.brief ?? null;
  return (
    <div className={pageStyles.page}>
      <div className={pageStyles.inner}>
        <div className={pageStyles.header}>
          <button type="button" className={pageStyles.back} onClick={() => void navigate(sessionLocation(convId))}>
            &larr; Its chat
          </button>
          <h1 className={pageStyles.title}>{data ? data.title : 'Brief'}</h1>
        </div>

        {error && !data ? <p className={swarmStyles.empty}>This session has no brief.</p> : null}

        {/* The brief: its tags, then its text exactly as the session got it. */}
        {brief ? (
          <section className={swarmStyles.section}>
            <h2 className={swarmStyles.h2}>The brief</h2>
            <div className={styles.tags}>
              <span className={styles.slug}>{brief.slug}</span>
              <span className={swarmStyles.note}>written {when(brief.written_at)}</span>
              {brief.opened_at ? <span className={swarmStyles.note}>· started {when(brief.opened_at)}</span> : null}
            </div>
            {brief.written_by ? (
              <p className={swarmStyles.note}>Written by {sessionLink(brief.written_by)}</p>
            ) : (
              <p className={swarmStyles.note}>Written by the app itself, or from a terminal.</p>
            )}
            {brief.continues ? (
              <p className={swarmStyles.note}>Carries on the work of {sessionLink(brief.continues)}</p>
            ) : null}
            {data?.continued_by ? (
              <p className={swarmStyles.note}>Its work was carried on by {sessionLink(data.continued_by)}</p>
            ) : null}
            <p className={swarmStyles.note}>This text was the session&rsquo;s first message.</p>
            <pre className={`${swarmStyles.pre} ${styles.body}`}>{brief.body}</pre>
          </section>
        ) : null}

        {/* What was preloaded: the file names, then the whole text, folded. */}
        {brief ? (
          <section className={swarmStyles.section}>
            <h2 className={swarmStyles.h2}>What it was handed</h2>
            {brief.preloaded.length > 0 ? (
              <>
                <p className={swarmStyles.note}>
                  {brief.preloaded.length} file{brief.preloaded.length === 1 ? ' was' : 's were'} pasted into its
                  hidden instructions, as {brief.preloaded.length === 1 ? 'it was' : 'they were'} when it started:
                </p>
                <ul className={swarmStyles.list}>
                  {brief.preloaded.map((path) => (
                    <li key={path} className={styles.path}>
                      {path}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className={swarmStyles.muted}>No files were pasted into its instructions.</p>
            )}
            {brief.too_big.length > 0 ? (
              <>
                <p className={swarmStyles.note}>Too big to paste; it was told to read these itself:</p>
                <ul className={swarmStyles.list}>
                  {brief.too_big.map((path) => (
                    <li key={path} className={styles.path}>
                      {path}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {data?.context ? (
              <details className={swarmStyles.run}>
                <summary className={swarmStyles.runHead}>
                  <span className={styles.partTitle}>Its hidden instructions, whole</span>
                  <span className={styles.partSize}>{data.context.length.toLocaleString()} characters</span>
                </summary>
                <pre className={`${swarmStyles.pre} ${styles.body}`}>{data.context}</pre>
              </details>
            ) : (
              <p className={swarmStyles.muted}>
                It has no hidden instructions from its brief: the brief carried its own Protocol and listed no files.
              </p>
            )}
          </section>
        ) : null}

        {/* Handoffs: the one it started from, the one it wrote. */}
        {data && data.handoffs.length > 0 ? (
          <section className={swarmStyles.section}>
            <h2 className={swarmStyles.h2}>Handoffs</h2>
            {data.handoffs.map((handoff) => (
              <details key={handoff.id} className={swarmStyles.run} open={data.handoffs.length === 1}>
                <summary className={swarmStyles.runHead}>
                  <span className={styles.partTitle}>
                    {handoff.written_here ? 'Written by this session' : 'What this session was started from'}
                  </span>
                  <span className={styles.partSize}>{when(handoff.at)}</span>
                </summary>
                {handoff.written_here && handoff.to ? (
                  <p className={swarmStyles.note}>Taken over by {sessionLink(handoff.to)}</p>
                ) : null}
                {!handoff.written_here && handoff.from ? (
                  <p className={swarmStyles.note}>Written by {sessionLink(handoff.from)}</p>
                ) : null}
                <pre className={`${swarmStyles.pre} ${styles.body}`}>{handoff.body}</pre>
              </details>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
