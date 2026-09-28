/**
 * ComesFrom.tsx — where a food comes from, drawn small, for the Kitchen.
 *
 * What this file does: given the map sources one food is linked to, draws each
 * as its transparency-coloured dot and its name, the name opening that source
 * on the Food area's map (/food?source=<id>). With no linked source it says "Not
 * traced yet". Used by the organic popup (OrganicVerdict.tsx); the sources
 * come from the kitchen payload and are matched to the food by
 * ecoSourcesForFood (features/ecosystem/ecoMatch.ts) — a real link, never a
 * name guess.
 *
 * Prompt that produced it: "A grocery list row or organic chip leads to the
 * food's profile, with its source shown compactly."
 */
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ecoTx } from './ecoMatch';
import type { EcoSource } from './types';
import styles from './ComesFrom.module.css';

export function SourceDot({ source }: { source: EcoSource }) {
  return <span className={styles.dot} style={{ background: ecoTx(source).color }} title={ecoTx(source).label} />;
}

/** A source's name as a link that opens it on the map. */
export function SourceLink({ source }: { source: EcoSource }) {
  return (
    <Link to="/food" search={{ source: source.id }} className={styles.sourceLink} title="Open on the map">
      {source.name}
    </Link>
  );
}

/** The "Comes from" line: every linked source, or "Not traced yet" plus
 * whatever the caller puts after it (the request-linking button). */
export function ComesFrom({ sources, untraced }: { sources: EcoSource[]; untraced?: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>Comes from</span>
      {sources.length ? (
        sources.map((source) => (
          <span key={source.id} className={styles.source}>
            <SourceDot source={source} />
            <SourceLink source={source} />
          </span>
        ))
      ) : (
        <>
          <span className={styles.muted}>Not traced yet</span>
          {untraced}
        </>
      )}
    </div>
  );
}
