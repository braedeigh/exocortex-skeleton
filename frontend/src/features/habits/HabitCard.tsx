import { Checkbox } from '../../ui';
import { courseInfo, habitCadence, habitCount, habitStartLabel, isGraduated, isHabitDoneOn } from './habitMath';
import type { HabitCadenceMap, HabitMetaMap, HabitsLog, HabitStarts } from './types';
import styles from './HabitCard.module.css';

const TARGET = 60;

export interface HabitCardProps {
  label: string;
  color: string;
  sectionName: string;
  items: string[];
  todayISO: string;
  log: HabitsLog;
  cadenceMap: HabitCadenceMap;
  metaMap: HabitMetaMap;
  starts: HabitStarts;
  onToggle: (item: string, section: string) => void;
  /** Public (logged-out) visitors — checkbox goes visually inert and never
   * calls onToggle. This matters beyond "don't let them edit her habits":
   * an authed-only POST from a logged-out browser 401s, and the shared api
   * client hard-redirects to /login on 401, which would boot the visitor
   * off the public site entirely. `disabled` on the native input is what
   * actually blocks the click from ever firing onChange. */
  readOnly?: boolean;
}

/** One daily habit card — port of habitCardHTML in static/js/core.js.
 * Drag-reorder, rename, delete, and the ↗ companion-page link are edit-mode
 * affordances; deferred along with the rest of edit/reorder mode (see
 * HabitsColumn.tsx TODO). */
export function HabitCard({ label, color, sectionName, items, todayISO, log, cadenceMap, metaMap, starts, onToggle, readOnly = false }: HabitCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.title} style={{ color }}>
        {label}
      </div>
      {items.map((item) => {
        const done = isHabitDoneOn(log, sectionName, item, todayISO);
        const cad = habitCadence(cadenceMap, sectionName, item);
        const spot = isGraduated(cad);
        const ci = courseInfo(metaMap, sectionName, item, todayISO);
        const total = habitCount(log, item, sectionName);

        return (
          <div className={styles.row} key={item}>
            <Checkbox
              className={`${styles.checkbox} ${readOnly ? styles.checkboxReadOnly : ''}`}
              checked={done}
              disabled={readOnly}
              onChange={() => onToggle(item, sectionName)}
              aria-label={done ? `Mark ${item} not done` : `Mark ${item} done`}
            />
            <span className={`${styles.text} ${done ? styles.done : ''}`}>{item}</span>
            {ci ? (
              <span className={styles.badge} title={`Day ${ci.dayNum} of ${ci.days}`}>
                day {ci.dayNum}/{ci.days}
              </span>
            ) : spot && cad ? (
              <span className={styles.badge} title="A spot-check — keeping this habit honest on a light cadence">
                {cad.stage} check
              </span>
            ) : (
              <span className={styles.count}>
                {habitStartLabel(starts, item, todayISO)}
                {total}/{TARGET}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
