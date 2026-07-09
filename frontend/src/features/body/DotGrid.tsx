import { useEffect, useRef, useState } from 'react';
import { GRID_GRAY, GRID_METRICS, dateShortParts, dotInfo, noseSprayStreakFlags } from './dotGridHelpers';
import type { BodyHealthDay, SymptomDefinitions } from './types';
import styles from './DotGrid.module.css';

export interface DotGridProps {
  days: BodyHealthDay[];
  definitions: SymptomDefinitions | undefined;
  /** Highlighted column's date (teal wash), or null. */
  selectedDate: string | null;
  onSelectDay: (date: string) => void;
  onToggleNoseSpray: (date: string, currentlyUsed: boolean) => void;
  /** Bump to re-run the scroll-to-right (e.g. when the card re-opens). */
  scrollNonce?: number;
}

const KEY_ROWS: Array<[string, string]> = [
  ['var(--green)', 'None / Good'],
  ['var(--yellow)', 'Mild / Low'],
  ['var(--orange)', 'Moderate'],
  ['var(--red)', 'Bad / Severe'],
  [GRID_GRAY, 'No data'],
];

const SPRAY_KEY_ROWS: Array<[string, string]> = [
  ['var(--accent)', 'Used'],
  ['var(--orange)', '3+ day streak'],
];

/**
 * The symptoms-over-time dot grid + color key — port of overview.js
 * renderDotGrid. One column per day, one row per metric; nasal-spray row
 * toggles on tap instead of opening the day editor. Auto-scrolls to the most
 * recent day (right edge) whenever the data or the hosting card's open state
 * changes.
 */
export function DotGrid({
  days,
  definitions,
  selectedDate,
  onSelectDay,
  onToggleNoseSpray,
  scrollNonce = 0,
}: DotGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hoverCol, setHoverCol] = useState<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Now and again next frame — scrollWidth isn't final until layout settles.
    el.scrollLeft = el.scrollWidth;
    const raf = requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth;
    });
    return () => cancelAnimationFrame(raf);
  }, [days.length, scrollNonce]);

  if (!days.length) {
    return <p className={styles.empty}>No health data yet.</p>;
  }

  const streaks = noseSprayStreakFlags(days);
  const selectedCol = selectedDate ? days.findIndex((d) => d.date === selectedDate) : -1;

  const cellClass = (ci: number) =>
    [
      styles.cell,
      ci === selectedCol ? styles.colHighlight : '',
      ci === hoverCol ? styles.colHover : '',
    ]
      .filter(Boolean)
      .join(' ');

  return (
    <div className={styles.wrap}>
      <div className={styles.grid} ref={scrollRef}>
        <table className={styles.table}>
          <tbody>
            <tr>
              <td className={`${styles.metricLabel} ${styles.metricLabelBlank}`} />
              {days.map((d, ci) => {
                const [month, dayNum] = dateShortParts(d);
                return (
                  <td
                    key={d.date}
                    className={`${styles.dateLabel} ${cellClass(ci)}`}
                    onMouseEnter={() => setHoverCol(ci)}
                    onMouseLeave={() => setHoverCol(null)}
                  >
                    {month}
                    <br />
                    {dayNum}
                  </td>
                );
              })}
            </tr>
            {GRID_METRICS.map((m) => (
              <tr key={m.key}>
                <td className={styles.metricLabel}>{m.name}</td>
                {days.map((d, ci) => {
                  const { color, tip } = dotInfo(m, d, streaks[ci], definitions);
                  const isToggle = m.kind === 'toggle';
                  const title = `${d.date_short || d.date}: ${tip}${isToggle ? ' — click to toggle' : ''}`;
                  return (
                    <td
                      key={d.date}
                      className={cellClass(ci)}
                      onMouseEnter={() => setHoverCol(ci)}
                      onMouseLeave={() => setHoverCol(null)}
                    >
                      <button
                        type="button"
                        className={styles.dotBtn}
                        title={title}
                        aria-label={title}
                        onClick={() =>
                          isToggle ? onToggleNoseSpray(d.date, d.nose_spray === true) : onSelectDay(d.date)
                        }
                      >
                        <span className={styles.dot} style={{ background: color }} />
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.key}>
        {KEY_ROWS.map(([color, label]) => (
          <div className={styles.keyRow} key={label}>
            <span className={styles.keyDot} style={{ background: color }} />
            {label}
          </div>
        ))}
        <div className={styles.keySpray}>
          <div className={styles.keySprayTitle}>Nasal spray</div>
          {SPRAY_KEY_ROWS.map(([color, label]) => (
            <div className={styles.keyRow} key={label}>
              <span className={styles.keyDot} style={{ background: color }} />
              {label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
