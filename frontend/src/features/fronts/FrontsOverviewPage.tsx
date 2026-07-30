/**
 * FrontsOverviewPage.tsx — every front on one surface, each drawn at the size
 * of its actual weight. Reads /api/fronts/overview (routes/fronts.py) via
 * frontsOverview.ts, which counts live things per front across to-dos,
 * threads, the buy list and research topics.
 *
 * This is meant to be a picture, not a menu: the tile that dominates the
 * screen is the part of life currently taking the most room, and it re-composes
 * itself as the counts move. Tapping a front hands off to the to-do page
 * filtered to it (/todos?front=<id>), which is where the existing chip filter
 * already lives.
 *
 * Prompt that produced it: "a front overview — all twelve fronts on one
 * surface, each sized by its real weight ... not a menu. a picture of where
 * things currently are."
 */
import { useNavigate } from '@tanstack/react-router';
import { FRONT_EMOJI } from './useFronts';
import {
  SOURCE_LABELS,
  maxTotal,
  tierFor,
  useFrontsOverview,
  type FrontOverviewEntry,
  type FrontTier,
} from './frontsOverview';
import styles from './FrontsOverviewPage.module.css';

/** Tiers with room for the per-surface breakdown without going under 12px. */
const BREAKDOWN_TIERS: FrontTier[] = ['lg', 'xl'];

function Tile({
  front,
  tier,
  isLeader,
  delayMs,
  onOpen,
}: {
  front: FrontOverviewEntry;
  tier: FrontTier;
  isLeader: boolean;
  delayMs: number;
  onOpen: (id: string) => void;
}) {
  const empty = front.total === 0;
  const parts = Object.entries(front.sources).filter(([, n]) => n > 0);

  return (
    <button
      type="button"
      className={[
        styles.tile,
        styles[tier],
        isLeader ? styles.leader : '',
        empty ? styles.empty : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // The tile IS the grid item (the span classes live on it), so the
      // stagger delay rides here rather than on a wrapper element.
      style={{ animationDelay: `${delayMs}ms` }}
      onClick={() => onOpen(front.id)}
      data-track="front-tile"
      aria-label={`${front.name}, ${front.total} item${front.total === 1 ? '' : 's'}`}
    >
      <span className={styles.tileTop}>
        <span className={styles.emoji} aria-hidden="true">
          {FRONT_EMOJI[front.id] || '🏷️'}
        </span>
        <span className={styles.name}>{front.name}</span>
      </span>

      <span className={styles.tileBottom}>
        <span className={styles.count}>{front.total}</span>
        {BREAKDOWN_TIERS.includes(tier) && parts.length > 0 && (
          <span className={styles.breakdown}>
            {parts.map(([source, n]) => (
              <span key={source} className={styles.breakdownItem}>
                <span className={styles.breakdownNum}>{n}</span>{' '}
                {SOURCE_LABELS[source] || source}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

export function FrontsOverviewPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useFrontsOverview();

  if (isLoading) return <div className={styles.state}>Reading the fronts…</div>;
  if (isError || !data) return <div className={styles.state}>Couldn’t load the fronts.</div>;

  // Heaviest first — the field reads top-left to bottom-right as a ranking,
  // and dense grid flow lets the small tiles backfill around the big ones.
  const fronts = [...data.fronts].sort((a, b) => b.total - a.total);
  const max = maxTotal(fronts);
  const leaderId = max > 0 ? fronts[0]?.id : undefined;

  const counted = Object.values(data.totals).reduce((a, b) => a + b, 0);
  const untagged = Object.values(data.untagged).reduce((a, b) => a + b, 0);
  const orphanIds = Object.keys(data.orphans);

  // Tiles open the front's ROOM, not the filtered to-do list: the overview is
  // the hallway and the room is where the work is. /todos?front= still works
  // as a deep link, it's just no longer what a tile does.
  function openFront(id: string) {
    navigate({ to: '/fronts/$frontId', params: { frontId: id } });
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Fronts</h1>
        <p className={styles.subtitle}>
          {counted} live thing{counted === 1 ? '' : 's'} across{' '}
          {data.sources.map((s) => SOURCE_LABELS[s] || s).join(', ')} — each front drawn at
          the size of what it’s actually carrying.
        </p>
      </header>

      <div className={styles.field}>
        {fronts.map((front, i) => (
          <Tile
            key={front.id}
            front={front}
            tier={tierFor(front.total, max)}
            isLeader={front.id === leaderId}
            delayMs={Math.min(i, 11) * 28}
            onOpen={openFront}
          />
        ))}
      </div>

      <div className={styles.notes}>
        {untagged > 0 && (
          <p className={styles.note}>
            {untagged} thing{untagged === 1 ? '' : 's'} carry no front yet.
          </p>
        )}
        {orphanIds.length > 0 && (
          <p className={`${styles.note} ${styles.warn}`}>
            Tagged with {orphanIds.length === 1 ? 'a front' : 'fronts'} that no longer
            exist: {orphanIds.map((id) => `${id} (${data.orphans[id]})`).join(', ')}. These
            are invisible to the to-do filter until they’re remapped.
          </p>
        )}
      </div>
    </div>
  );
}
