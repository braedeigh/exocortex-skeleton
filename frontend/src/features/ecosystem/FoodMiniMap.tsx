/**
 * FoodMiniMap.tsx — the small map on a food's page: the places this food (or
 * a product of it) comes from, drawn by the same EcoMap the big map uses.
 * It pans and zooms in place; the "Open the big map" button goes to /food
 * showing only this food's sources.
 *
 * Read-only: no adding, editing or deleting here — that's the big map's job.
 * Lazy-loaded by FoodPage.tsx so Leaflet stays out of the main bundle.
 *
 * Touches: ./EcoMap.tsx, ./FoodArea.module.css.
 *
 * Prompt that produced it: the mini-map on a food's page should "pan and zoom";
 * tapping through opens the big map.
 */
import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { EcoMap, type EcoMapHandle } from './EcoMap';
import type { EcoSource } from './types';
import styles from './FoodArea.module.css';

const doNothing = () => {};

export default function FoodMiniMap({ sources, foodId }: { sources: EcoSource[]; foodId: number }) {
  const mapRef = useRef<EcoMapHandle>(null);

  // Frame every source once, after the map has laid out.
  useEffect(() => {
    const timer = setTimeout(() => mapRef.current?.fitVisible(), 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={styles.miniMap}>
      <EcoMap
        ref={mapRef}
        sources={sources}
        visibleIds={null}
        draft={null}
        canEdit={false}
        onMapClick={doNothing}
        onDraftMove={doNothing}
        onEditSource={doNothing}
        onDeleteSource={doNothing}
      />
      <Link to="/food" search={{ food: foodId }} className={styles.miniMapOpen}>
        Open the big map ↗
      </Link>
    </div>
  );
}
