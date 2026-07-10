/**
 * SendStrip.tsx — "send queued to Claude", only rendered when something is
 * queued. Main view: sends everything flagged (ids = null) and shows the
 * unreviewed-output pill so the orange never hides silently. Thread view:
 * sends just the thread's flagged ids. The list under the button names
 * exactly what's queued so "send" is never a surprise.
 */

import { truncate, unreviewedCount } from './helpers';
import { useResearchCtx } from './ResearchContext';
import type { Entry } from './types';
import styles from './ResearchPage.module.css';

export function SendStrip({ flagged, scope }: { flagged: Entry[]; scope: 'all' | 'thread' }) {
  const { state, mutations } = useResearchCtx();
  if (!flagged.length) return null;

  const unreviewed = scope === 'all' ? unreviewedCount(state.entries) : 0;
  const label =
    scope === 'all' ? `➤ Send ${flagged.length} queued to Claude` : `➤ Send ${flagged.length} queued in this thread`;

  return (
    <div className={styles.strip}>
      <div className={styles.stripRow}>
        <button
          type="button"
          className={styles.stripBtn}
          disabled={mutations.send.isPending}
          onClick={() => mutations.send.mutate(scope === 'all' ? null : flagged.map((e) => e.id))}
        >
          {label}
        </button>
        {unreviewed ? <span className={styles.stripPill}>{unreviewed} unreviewed</span> : null}
      </div>
      {flagged.map((e) => (
        <div key={e.id} className={styles.stripItem}>
          &#9873; {truncate(e.text, 100)}
        </div>
      ))}
    </div>
  );
}
