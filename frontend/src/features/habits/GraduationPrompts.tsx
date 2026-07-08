import { useRef, useState } from 'react';
import { habitKey, habitsReadyToGraduate, isGradSnoozed } from './habitMath';
import { readGradSnoozeMap, snoozeGraduation } from './habitStorage';
import type { CadenceConfig, HabitCadenceMap, HabitMetaMap, HabitSection, HabitsLog } from './types';
import styles from './GraduationPrompts.module.css';

export interface GraduationPromptsProps {
  habits: HabitSection[];
  hidden: string[];
  cadenceMap: HabitCadenceMap | undefined;
  metaMap: HabitMetaMap | undefined;
  log: HabitsLog;
  cadenceConfig: CadenceConfig | undefined;
  serverDate: string;
  onPromote: (section: string, item: string) => void;
  onRestore: (section: string, item: string) => void;
}

/** To-Do page nudge for proven daily habits ready to graduate to a weekly
 * spot-check — port of renderGraduationPrompts in habits.js. Rendered
 * page-level (not inside the Habits column) so it reads like the other
 * reminder-style bars above the two-col grid. */
export function GraduationPrompts({
  habits,
  hidden,
  cadenceMap,
  metaMap,
  log,
  cadenceConfig,
  serverDate,
  onPromote,
  onRestore,
}: GraduationPromptsProps) {
  // "just graduated" confirmation bars — transient local state (mirrors the
  // old window._gradRecent), not a cache mutation: the real cadence entry
  // (next_check, stage) is computed server-side and picked up on refetch.
  const [recent, setRecent] = useState<Record<string, { section: string; item: string }>>({});
  const [snoozeTick, setSnoozeTick] = useState(0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const candidates = habitsReadyToGraduate(habits, hidden, cadenceMap, metaMap, log, cadenceConfig, serverDate);
  const snoozeMap = readGradSnoozeMap();
  void snoozeTick; // read to force this closure to recompute snoozeMap after a "Not now" tap

  function graduate(section: string, item: string) {
    onPromote(section, item);
    const key = habitKey(section, item);
    setRecent((cur) => ({ ...cur, [key]: { section, item } }));
    if (timers.current[key]) clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      setRecent((cur) => {
        const next = { ...cur };
        delete next[key];
        return next;
      });
    }, 6000);
  }

  function undo(section: string, item: string) {
    const key = habitKey(section, item);
    setRecent((cur) => {
      const next = { ...cur };
      delete next[key];
      return next;
    });
    onRestore(section, item);
  }

  function snooze(section: string, item: string) {
    snoozeGraduation(section, item, serverDate);
    setSnoozeTick((n) => n + 1);
  }

  const recentRows = Object.entries(recent);
  const candidateRows = candidates.filter(
    ({ section, item }) => !recent[habitKey(section, item)] && !isGradSnoozed(snoozeMap, section, item, serverDate),
  );

  if (!recentRows.length && !candidateRows.length) return null;

  return (
    <div className={styles.wrap}>
      {recentRows.map(([key, { section, item }]) => (
        <div key={key} className={`${styles.bar} ${styles.done}`}>
          <div className={styles.headline}>&#10003; &#127891; {item} graduated &rarr; weekly</div>
          <button type="button" className={styles.actionBtn} onClick={() => undo(section, item)}>
            Undo
          </button>
        </div>
      ))}
      {candidateRows.map(({ section, item }) => (
        <div key={habitKey(section, item)} className={`${styles.bar} ${styles.pending}`}>
          <div>
            <div className={styles.headline}>&#127891; Graduate: {item}</div>
            <div className={styles.sub}>Automatic now — move it to a weekly spot-check</div>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.actionBtn} onClick={() => snooze(section, item)} title="Not yet">
              Not now
            </button>
            <button type="button" className={styles.actionBtn} onClick={() => graduate(section, item)}>
              &#127891; Graduate
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
