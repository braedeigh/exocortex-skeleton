/**
 * Pills.tsx — the deep-research and distill fire buttons, which render as a
 * live session pill (pulsing dot while running, static muted dot while
 * queued on the dispatcher) instead of a button whenever a session for the
 * same target is already in flight, so neither can be double-fired.
 */

import { activeDeepSession, activeDistillSession } from './helpers';
import { useResearchCtx } from './ResearchContext';
import type { Entry, Topic } from './types';
import styles from './ResearchPage.module.css';

export function DeepButton({ entry }: { entry: Entry }) {
  const { state, actions } = useResearchCtx();
  const active = activeDeepSession(state.sessions, entry.id);
  if (active) {
    const queued = active.status === 'queued';
    return (
      <span className={queued ? styles.modePillQueued : styles.modePillOrange}>
        <span className={queued ? styles.dotMuted : styles.dotOrange} />
        &#128300; {queued ? 'queued' : 'researching'}&hellip;
      </span>
    );
  }
  return (
    <button type="button" className={styles.outlineAccentBtn} onClick={() => actions.deepResearch(entry.id)}>
      &#128300; Deep research
    </button>
  );
}

export function DistillButton({ topic }: { topic: Topic }) {
  const { state, mutations } = useResearchCtx();
  const active = activeDistillSession(state.sessions, topic.id);
  if (active) {
    const queued = active.status === 'queued';
    return (
      <span className={queued ? styles.modePillQueued : styles.modePillPurple}>
        <span className={queued ? styles.dotMuted : styles.dotPurple} />
        &#10024; {queued ? 'queued' : 'distilling'}&hellip;
      </span>
    );
  }
  return (
    <button type="button" className={styles.outlinePurpleBtn} onClick={() => mutations.distill.mutate(topic.id)}>
      &#10024; Distill
    </button>
  );
}
