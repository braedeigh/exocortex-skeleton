import { useNavigate } from '@tanstack/react-router';
import { useAtlas } from './api';
import type { AtlasFront, AtlasSession } from './api';
import { groupAtlas } from './atlasTree';
import styles from './AtlasPage.module.css';

function ago(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * /atlas — a map, not a dashboard: every observatory session sorted into
 * its home. The exocortex front is the hero (its five domain shelves render
 * even when empty, so the architecture stays visible); the other 11 life
 * fronts render as shelves only when they hold sessions, collapsing into a
 * single muted chip row otherwise so the full vocabulary stays legible
 * without noise. Tapping a card opens that conversation via the same
 * navigation the Sessions roster uses (RosterPage.open).
 */
export function AtlasPage() {
  const { data, isLoading, isError } = useAtlas();

  const grouping = data ? groupAtlas(data.fronts, data.domains, data.sessions) : null;

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <h1 className={styles.title}>Atlas</h1>

        {isLoading ? <div className={styles.hint}>Loading…</div> : null}
        {isError ? <div className={styles.hint}>Couldn&rsquo;t load the atlas.</div> : null}

        {grouping ? (
          <>
            <section className={styles.hero}>
              <h2 className={styles.heroTitle}>{grouping.exocortexFront?.name ?? 'Exocortex'}</h2>
              <div className={styles.shelfGrid}>
                {grouping.domainShelves.map(({ domain, sessions }) => (
                  <Shelf key={domain.id} title={domain.name} description={domain.description} sessions={sessions} />
                ))}
                {grouping.otherExocortexSessions.length > 0 ? (
                  <Shelf title="Other" sessions={grouping.otherExocortexSessions} />
                ) : null}
              </div>
            </section>

            {grouping.populatedFrontShelves.map(({ front, sessions }) => (
              <section key={front.id} className={styles.frontSection}>
                <ShelfHeader title={front.name} count={sessions.length} />
                <SessionGrid sessions={sessions} />
              </section>
            ))}

            {grouping.emptyFronts.length > 0 ? <EmptyFrontsRow fronts={grouping.emptyFronts} /> : null}

            {grouping.unsorted.length > 0 ? (
              <section className={styles.frontSection}>
                <ShelfHeader title="Unsorted" count={grouping.unsorted.length} />
                <SessionGrid sessions={grouping.unsorted} />
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ShelfHeader({ title, count, description }: { title: string; count: number; description?: string }) {
  return (
    <div className={styles.shelfHeader}>
      <span className={styles.shelfTitle}>{title}</span>
      <span className={styles.shelfCount}>{count}</span>
      {description ? <span className={styles.shelfDesc}>{description}</span> : null}
    </div>
  );
}

/** One domain shelf inside the exocortex hero — renders muted with a "no
 * sessions yet" hint when empty, so the five-domain architecture is always
 * visible even before it's populated. */
function Shelf({
  title,
  description,
  sessions,
}: {
  title: string;
  description?: string;
  sessions: AtlasSession[];
}) {
  const empty = sessions.length === 0;
  return (
    <div className={[styles.shelf, empty ? styles.shelfEmpty : ''].filter(Boolean).join(' ')}>
      <ShelfHeader title={title} count={sessions.length} description={description} />
      {empty ? (
        <div className={styles.shelfEmptyHint}>No sessions yet</div>
      ) : (
        <SessionGrid sessions={sessions} />
      )}
    </div>
  );
}

function SessionGrid({ sessions }: { sessions: AtlasSession[] }) {
  return (
    <div className={styles.sessionGrid}>
      {sessions.map((s) => (
        <SessionCard key={s.id} session={s} />
      ))}
    </div>
  );
}

/** Whole card is the tap target — same navigation the Sessions roster uses
 * (RosterPage.open) to reach a conversation. */
function SessionCard({ session }: { session: AtlasSession }) {
  const navigate = useNavigate();

  const open = () => {
    void navigate({
      to: '/observatory/$botId',
      params: { botId: session.bot },
      search: { conv: session.id },
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={[styles.card, session.archived ? styles.cardArchived : ''].filter(Boolean).join(' ')}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className={styles.cardTop}>
        <span className={styles.cardTitle}>
          {session.title || session.id}
          {session.pinned ? <span className={styles.pinBadge}>pinned</span> : null}
        </span>
        <span className={styles.cardTime}>{ago(session.last_at)}</span>
      </div>
      {session.gist ? <div className={styles.cardGist}>{session.gist}</div> : null}
      {session.tags && session.tags.length > 0 ? (
        <div className={styles.tagRow}>
          {session.tags.map((tag) => (
            <span key={tag} className={styles.tagChip}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Life fronts with zero sessions collapse into one muted chip row, so the
 * full front vocabulary stays visible without a wall of empty shelves. */
function EmptyFrontsRow({ fronts }: { fronts: AtlasFront[] }) {
  return (
    <div className={styles.emptyFrontsRow}>
      {fronts.map((f, i) => (
        <span key={f.id} className={styles.emptyFrontChip}>
          {f.name}
          {i < fronts.length - 1 ? <span className={styles.emptyFrontDot}>·</span> : null}
        </span>
      ))}
    </div>
  );
}
