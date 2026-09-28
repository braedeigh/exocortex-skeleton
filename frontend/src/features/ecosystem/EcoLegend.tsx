/**
 * EcoLegend.tsx — the transparency legend + shape explainer under the map
 * (port of _ecoLegend).
 */
import { ECO_TX, ECO_TX_ORDER } from './axes';
import styles from './EcoLegend.module.css';

export function EcoLegend() {
  return (
    <>
      <div className={styles.row}>
        <span className={styles.rowTitle}>Transparency:</span>
        {ECO_TX_ORDER.map((k) => (
          <span key={k} className={styles.item}>
            <span className={styles.dot} style={{ background: ECO_TX[k].color }} />
            {ECO_TX[k].label}
          </span>
        ))}
      </div>
      <div className={styles.blurb}>
        Crisp dot = exact spot &middot; shaded shape = a region (real county, state or province
        outlines where known; a soft circle when only roughly known) &middot; dashed = the
        machine&rsquo;s proposal, not yours; faint grey dashes failed its check.
      </div>
    </>
  );
}
