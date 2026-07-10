import { useLayoutEffect, useRef } from 'react';
import { buildHeatmap, cellBackground } from './heatmapMath';
import type { MentionDay } from './types';
import styles from './Heatmap.module.css';

export interface HeatmapProps {
  days: MentionDay[];
  hue: number;
  /** Cell tap -> open the journal on that date. */
  onSelectDate: (date: string) => void;
}

/**
 * GitHub-contributions-style activity grid (port of person.js
 * renderHeatmap): weeks as columns, Mon-Sun rows, month labels over the
 * weeks that start a new month, intensity binned against the busiest day in
 * the person's hue. All the math lives in heatmapMath.ts; this component is
 * just the render + the pin-to-newest scroll behavior.
 */
export function Heatmap({ days, hue, onSelectDate }: HeatmapProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const model = buildHeatmap(days);

  // Pin the scroll to the newest (right) side on load, same as the old page
  // (and overview.js's dot grid) — now and again next frame, since
  // scrollWidth isn't final until layout settles.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    const raf = requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth;
    });
    return () => cancelAnimationFrame(raf);
  }, [model?.weeks.length]);

  if (!model) return <p className={styles.empty}>No activity yet.</p>;

  const { weeks, monthLabels, maxCount } = model;

  return (
    <div className={styles.scroll} ref={scrollRef}>
      <div className={styles.inner}>
        <div className={styles.months}>
          {weeks.map((_, i) => {
            const lbl = monthLabels.find((m) => m.week === i);
            return (
              <div key={i} className={styles.monthCol}>
                {lbl ? lbl.label : ''}
              </div>
            );
          })}
        </div>
        <div className={styles.grid}>
          {weeks.map((week, wi) => (
            <div key={wi} className={styles.week}>
              {week.map((cell) => (
                <button
                  key={cell.date}
                  type="button"
                  className={styles.cell}
                  style={{ background: cellBackground(cell.count, maxCount, hue) }}
                  title={`${cell.date} · ${cell.count} mentions`}
                  aria-label={`${cell.date} · ${cell.count} mentions`}
                  onClick={() => onSelectDate(cell.date)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
