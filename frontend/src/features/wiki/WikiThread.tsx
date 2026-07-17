import { Link, useNavigate } from '@tanstack/react-router';
import { useThread, useThreadsTree } from '../journal/useJournalData';
import type { ThreadsTreeResponse, ThreadSource } from '../journal/types';
import { FRONT_EMOJI, useFronts } from '../fronts/useFronts';
import { ThreadCards } from '../threads/ThreadCards';
import styles from './WikiThread.module.css';

/** A raw thread slug -> a readable fallback name, same convention
 * routes/threads.py `_cast_name` uses for an unwritten person file. */
function titleCase(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * WikiThread — the per-thread wiki article at /wiki/<slug>: the "navigable
 * by a person" payoff of the wiki. Reuses GET /api/thread (useThread — the
 * same hook/endpoint ThreadsPage and the journal's ThreadPopover already
 * call) for the thread itself, and GET /api/threads/tree (useThreadsTree)
 * purely to resolve parent/child SLUGS into NAMES for the "Related" section
 * — no new backend endpoint. The cited fact-cards reuse ThreadCards, the
 * same component ThreadsPage's expanded thread body renders, so a thread
 * reads identically whether met on /threads or walked to from /wiki.
 */
export function WikiThread({ slug }: { slug: string }) {
  const { data, isLoading, isError } = useThread(slug);
  const { data: frontsData } = useFronts();
  const treeQuery = useThreadsTree(false);
  const navigate = useNavigate();

  const fronts = frontsData ?? [];
  const tree = treeQuery.data;

  function sourceClick(s: ThreadSource) {
    if (s.kind === 'journal') {
      void navigate({ to: '/journal', search: { date: s.val } });
    }
  }

  return (
    <div className={styles.page}>
      <Link to="/wiki" className={styles.backLink}>
        &larr; Wiki
      </Link>

      {isLoading ? <div className={styles.empty}>Loading…</div> : null}
      {!isLoading && (isError || !data) ? (
        <div className={styles.empty}>Couldn't load this thread.</div>
      ) : null}

      {data ? (
        <>
          <h1 className={styles.title}>{data.name}</h1>

          {/* TODO: per-thread generated summary lands here */}

          <aside className={styles.infobox} aria-label="Facts">
            {data.fronts && data.fronts.length > 0 ? (
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Fronts</span>
                <span className={styles.chipRow}>
                  {data.fronts.map((fid) => {
                    const f = fronts.find((x) => x.id === fid);
                    return (
                      <span key={fid} className={styles.plainChip}>
                        {FRONT_EMOJI[fid] || '🏷️'} {f?.name || fid}
                      </span>
                    );
                  })}
                </span>
              </div>
            ) : null}

            {data.kind ? (
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Kind</span>
                <span className={styles.infoValue}>{data.kind}</span>
              </div>
            ) : null}

            {data.status ? (
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Status</span>
                <span className={styles.infoValue}>{data.status}</span>
              </div>
            ) : null}

            {data.people && data.people.length > 0 ? (
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Cast</span>
                <span className={styles.chipRow}>
                  {data.people.map((p) => {
                    // Default to resolved=true when the backend hasn't sent
                    // peopleResolved (defensive — it always does today) so a
                    // stale/older payload shape doesn't wrongly redlink.
                    const resolved = data.peopleResolved?.[p.slug] ?? true;
                    return (
                      <Link
                        key={p.slug}
                        to="/person/$slug"
                        params={{ slug: p.slug }}
                        className={`${styles.plainChip} ${resolved ? '' : styles.redlink}`}
                      >
                        {p.name}
                      </Link>
                    );
                  })}
                </span>
              </div>
            ) : null}

            {data.parents && data.parents.length > 0 ? (
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Parents</span>
                <span className={styles.chipRow}>
                  {data.parents.map((pslug) => (
                    <span key={pslug} className={styles.plainChip}>
                      {tree?.nodes[pslug]?.name ?? titleCase(pslug)}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
          </aside>

          <div className={styles.cards}>
            <ThreadCards cards={data.cards} onSourceClick={sourceClick} />
          </div>

          <RelatedSection slug={slug} parents={data.parents ?? []} tree={tree} />
        </>
      ) : null}
    </div>
  );
}

function RelatedSection({
  slug,
  parents,
  tree,
}: {
  slug: string;
  parents: string[];
  tree: ThreadsTreeResponse | undefined;
}) {
  const children = tree?.nodes[slug]?.children ?? [];
  if (parents.length === 0 && children.length === 0) return null;

  return (
    <section className={styles.related} aria-labelledby="wiki-thread-related">
      <h2 id="wiki-thread-related" className={styles.sectionTitle}>Related</h2>

      {parents.length > 0 ? (
        <div className={styles.relatedGroup}>
          <span className={styles.relatedGroupLabel}>Parents</span>
          <ul className={styles.relatedList}>
            {parents.map((pslug) => (
              <li key={pslug}>
                {tree?.nodes[pslug] ? (
                  <Link to="/wiki/$slug" params={{ slug: pslug }} className={styles.relatedLink}>
                    {tree.nodes[pslug].name}
                  </Link>
                ) : (
                  // Not (yet) a resolvable thread — same muted-redlink
                  // convention as an unresolved person chip.
                  <span className={`${styles.relatedLink} ${styles.redlink}`}>{titleCase(pslug)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {children.length > 0 ? (
        <div className={styles.relatedGroup}>
          <span className={styles.relatedGroupLabel}>Children</span>
          <ul className={styles.relatedList}>
            {children.map((cslug) => (
              <li key={cslug}>
                <Link to="/wiki/$slug" params={{ slug: cslug }} className={styles.relatedLink}>
                  {tree?.nodes[cslug]?.name ?? titleCase(cslug)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
