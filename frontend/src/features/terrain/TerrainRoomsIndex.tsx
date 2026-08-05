import { useEffect, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import styles from './TerrainRoomsIndex.module.css';

/**
 * TerrainRoomsIndex — the hallway of the terrain: tap the Rooms door on the
 * map and the map blurs under you while a few opaque cards rise, one per room,
 * each wearing a small drawing of what's inside. Tap a card and you GO there —
 * every room is a full page of its own (/terrain/usage, /terrain/sql), so
 * choosing one is a real departure, not a panel opening.
 *
 * It's a moment, not a place: open/closed is local state on TerrainPage, never
 * a route, so the browser's back button doesn't have to wade through it. The
 * blur is doing honest work — the map saying "I'm still here, you're choosing
 * where to go" — and the cards are fully opaque against it because they're the
 * subject now.
 *
 * Adding a room = one entry in ROOMS (name, line, address, motif). The motifs
 * are tiny inline SVGs in each room's own visual language, drawn in the
 * theme's current ink so they ride the sky palette like everything else.
 *
 * Prompt that produced it: "I'm imagining like a blurred background with the
 * current terrain map and a few opaque cards with some visuals on them
 * describing what's inside each one. I'll be building more features out too."
 */

/** Ranked bars — the attention room's own chart, in miniature. */
function AttentionMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <rect x="0" y="4" width="52" height="6" rx="3" opacity="0.9" />
        <rect x="0" y="17" width="34" height="6" rx="3" opacity="0.55" />
        <rect x="0" y="30" width="20" height="6" rx="3" opacity="0.3" />
      </g>
    </svg>
  );
}

/** A table of cells — rows and columns, the database's shape. */
function DataMotif() {
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <g fill="currentColor">
        <rect x="0" y="0" width="64" height="8" rx="2" opacity="0.9" />
        {[13, 24, 35].map((y) => (
          <g key={y} opacity={0.4}>
            <rect x="0" y={y} width="18" height="6" rx="2" />
            <rect x="23" y={y} width="18" height="6" rx="2" />
            <rect x="46" y={y} width="18" height="6" rx="2" />
          </g>
        ))}
      </g>
    </svg>
  );
}

const ROOMS: ReadonlyArray<{
  key: string;
  to: string;
  name: string;
  line: string;
  motif: () => ReactElement;
}> = [
  {
    key: 'usage',
    to: '/terrain/usage',
    name: 'Attention',
    line: 'The same system, ranked by where your time actually goes.',
    motif: AttentionMotif,
  },
  {
    key: 'sql',
    to: '/terrain/sql',
    name: 'Data',
    line: 'The database — its shape, and a way to ask it things.',
    motif: DataMotif,
  },
];

export function TerrainRoomsIndex({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // Tapping the blur — anywhere that isn't a card — steps back to the map.
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <nav className={styles.cards} aria-label="Rooms" onClick={(e) => e.stopPropagation()}>
        {ROOMS.map((room, i) => {
          const Motif = room.motif;
          return (
            <Link
              key={room.key}
              to={room.to}
              className={styles.card}
              style={{ '--card-index': i } as React.CSSProperties}
            >
              <span className={styles.motif}>
                <Motif />
              </span>
              <span className={styles.name}>{room.name}</span>
              <span className={styles.line}>{room.line}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
