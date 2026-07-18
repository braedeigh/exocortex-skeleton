import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { FRONT_EMOJI } from '../fronts/useFronts';
import { useWikiHome } from './useWikiHome';
import type { WikiFront, WikiPerson, WikiThreadSummary } from './useWikiHome';
import { filterThreadsByFront, groupThreadsByPrimaryFront } from './wikiThreadIndex';
import styles from './WikiHome.module.css';

/**
 * WikiHome — the front door of the traversable wiki about Bradie (/wiki).
 * A short landing page an LLM or a human lands on first, then follows links
 * deeper: who she is (title + infobox facts), the lead paragraph, the "how
 * this is organized" blurb, a front FILTER over a browse-by-front thread
 * index (each thread its own page at /wiki/<slug> — see WikiThread.tsx), the
 * people who matter, and a quiet note on how to read the rest of the wiki.
 * Everything here comes from one endpoint, GET /api/wiki/home
 * (routes/wiki.py), which parses `context/home.md`.
 *
 * There is no separate "Right now" list anymore — the browse-by-front index
 * below is the single primary thread UI on this page (folding what used to
 * be two redundant thread lists into one, per the front-filter design).
 */
function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

export function WikiHome() {
  const { data, isLoading, isError } = useWikiHome();
  const { toasts, push, dismiss } = useToasts();
  const [filter, setFilter] = useState<string | null>(null);
  const isPublic = isPublicMode();

  if (isLoading) return <div className={styles.page}><div className={styles.empty}>Loading…</div></div>;
  if (isError || !data) {
    return <div className={styles.page}><div className={styles.empty}>Couldn't load the wiki home page.</div></div>;
  }

  function toggleFilter(id: string) {
    setFilter((cur) => (cur === id ? null : id));
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{data.title}</h1>

      <p className={styles.lead}>{data.lead}</p>

      <aside className={styles.infobox} aria-label="Facts">
        <InfoRow label="Pronouns" value={data.pronouns} />
        <InfoRow label="Age" value={data.birthday ? `${data.age} (born ${data.birthday})` : data.age} />
        <InfoRow label="Place" value={data.place} />
      </aside>

      {data.organizedBlurb ? <p className={styles.organizedBlurb}>{data.organizedBlurb}</p> : null}

      <section className={styles.frontsRow} aria-labelledby="wiki-fronts">
        <h2 id="wiki-fronts" className={styles.sectionTitle}>Her life, by front</h2>
        {data.fronts.length === 0 ? (
          <div className={styles.emptyInline}>No fronts yet.</div>
        ) : (
          <ul className={styles.chipList}>
            {data.fronts.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className={`${styles.chip} ${styles.filterChip} ${filter === f.id ? styles.filterChipActive : ''}`}
                  aria-pressed={filter === f.id}
                  onClick={() => toggleFilter(f.id)}
                >
                  <span aria-hidden="true">{FRONT_EMOJI[f.id] || '🏷️'}</span> {f.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.threadsIndex} aria-labelledby="wiki-threads">
        <h2 id="wiki-threads" className={styles.sectionTitle}>Threads</h2>
        {data.threads.length === 0 ? (
          <div className={styles.emptyInline}>No threads yet.</div>
        ) : filter ? (
          <ThreadList threads={filterThreadsByFront(data.threads, filter)} fronts={data.fronts} />
        ) : (
          groupThreadsByPrimaryFront(data.threads, data.fronts).map((group) => (
            <div key={group.front?.id ?? '__other__'} className={styles.threadGroup}>
              <h3 className={styles.threadGroupTitle}>
                {group.front ? (
                  <>
                    <span aria-hidden="true">{FRONT_EMOJI[group.front.id] || '🏷️'}</span> {group.front.name}
                  </>
                ) : (
                  'Other'
                )}
              </h3>
              <ThreadList threads={group.threads} fronts={data.fronts} />
            </div>
          ))
        )}
      </section>

      <section className={styles.people} aria-labelledby="wiki-people">
        <h2 id="wiki-people" className={styles.sectionTitle}>People who matter</h2>
        {data.people.length === 0 ? (
          <div className={styles.emptyInline}>No one listed yet.</div>
        ) : (
          <ul className={styles.chipList}>
            {data.people.map((p) => (
              <PersonChip key={p.slug} person={p} />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.howToRead} aria-labelledby="wiki-how-to-read">
        <h2 id="wiki-how-to-read" className={styles.sectionTitleQuiet}>How to read this</h2>
        <p className={styles.howToReadText}>{data.howToRead}</p>
      </section>

      {!isPublic ? <NotesPill tab="wiki" onError={push} /> : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  );
}

function ThreadList({ threads, fronts }: { threads: WikiThreadSummary[]; fronts: WikiFront[] }) {
  if (threads.length === 0) return <div className={styles.emptyInline}>Nothing here yet.</div>;
  return (
    <ul className={styles.threadList}>
      {threads.map((t) => (
        <ThreadRow key={t.slug} thread={t} fronts={fronts} />
      ))}
    </ul>
  );
}

/** One row in the browse index: front emoji + name (+ any other fronts it
 * visits) + a summary slot, dimmed when dormant, the whole row linking to
 * its own wiki page (/wiki/<slug> — WikiThread.tsx). ~40px tap target. */
function ThreadRow({ thread, fronts }: { thread: WikiThreadSummary; fronts: WikiFront[] }) {
  const dormant = thread.status === 'dormant';
  const primaryEmoji = FRONT_EMOJI[thread.fronts[0]] || '🏷️';
  const otherFronts = thread.fronts.slice(1);

  return (
    <li>
      <Link
        to="/wiki/$slug"
        params={{ slug: thread.slug }}
        className={`${styles.threadRow} ${dormant ? styles.threadRowDormant : ''}`}
      >
        <span className={styles.threadRowMain}>
          <span className={styles.threadRowEmoji} aria-hidden="true">{primaryEmoji}</span>
          <span className={styles.threadRowText}>
            <span className={styles.threadRowName}>{thread.name}</span>
            {/* TODO: per-thread generated summary lands here */}
            {thread.summary ? <span className={styles.threadRowSummary}>{thread.summary}</span> : null}
          </span>
        </span>
        <span className={styles.threadRowFronts}>
          {otherFronts.map((fid) => {
            const f = fronts.find((x) => x.id === fid);
            return (
              <span key={fid} className={styles.threadRowFrontChip}>
                {FRONT_EMOJI[fid] || '🏷️'} {f?.name || fid}
              </span>
            );
          })}
          {dormant ? <span className={styles.threadRowBadge}>dormant</span> : null}
        </span>
      </Link>
    </li>
  );
}

function PersonChip({ person }: { person: WikiPerson }) {
  if (!person.resolved) {
    // Redlink: a wiki link to a person page that doesn't exist yet
    // (routes/person.py's entities.resolve_person found no people/<slug>.md).
    // Still a real link (the page could be written later) — just styled
    // visibly unlinked/muted so it doesn't read as a live, working link.
    return (
      <li>
        <Link to="/person/$slug" params={{ slug: person.slug }} className={`${styles.chip} ${styles.redlink}`}>
          {person.name}
        </Link>
      </li>
    );
  }
  return (
    <li>
      <Link to="/person/$slug" params={{ slug: person.slug }} className={styles.chip}>
        {person.name}
      </Link>
    </li>
  );
}
