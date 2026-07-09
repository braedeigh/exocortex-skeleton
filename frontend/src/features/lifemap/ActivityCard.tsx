import { useState, type ReactNode } from 'react';
import {
  activityTypeMap,
  buildActivityDateMap,
  daysSinceLastOfType,
  daysSinceLastTrip,
  monthGrid,
  privateActTypes,
  runsThisWeek,
} from './calendarMath';
import type { ActivityTypeInfo, DotShape } from './calendarMath';
import type { MapData } from './types';
import styles from './ActivityCard.module.css';

const SHAPE_CLASS: Record<DotShape, string> = {
  circle: '',
  square: styles.shapeSquare,
  diamond: styles.shapeDiamond,
  triangle: styles.shapeTriangle,
  ring: styles.shapeRing,
};

function shapeClass(info: ActivityTypeInfo | undefined): string {
  return SHAPE_CLASS[info?.shape || 'circle'];
}

function fmtDayLabel(dateISO: string): string {
  return new Date(`${dateISO}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export interface ActivityCardProps {
  data: MapData;
  isPublic: boolean;
  onLogActivity: (date: string, type: string) => void;
  onLogTrip: (date: string) => void;
  onLogRun: (date: string, minutes: number | null, notes: string) => void;
  /** Two-step confirm flows (dot / run removal) — page-level modal. */
  onConfirm: (text: ReactNode, onConfirm: () => void) => void;
  onRemoveActivity: (date: string, type: string) => void;
  onRemoveTrip: (date: string) => void;
  onRemoveRun: (date: string) => void;
}

/**
 * Activity calendar + run tracker — port of static/js/activity.js
 * renderActivityCalendar (month grid with paging, typed dots, legend, stats
 * row, quick-log chips generated from the reminder registry, run form,
 * recent runs).
 */
export function ActivityCard({
  data,
  isPublic,
  onLogActivity,
  onLogTrip,
  onLogRun,
  onConfirm,
  onRemoveActivity,
  onRemoveTrip,
  onRemoveRun,
}: ActivityCardProps) {
  const today = data.server_date;
  // 0 = current month, -1 = last month… (never navigates into the future).
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [runFormOpen, setRunFormOpen] = useState(false);
  const [runDate, setRunDate] = useState(today);
  const [runMinutes, setRunMinutes] = useState('');
  const [runNotes, setRunNotes] = useState('');

  const privList = privateActTypes(data.private_act_types);
  const hiddenTypes = isPublic ? privList : [];
  const typeMap = activityTypeMap(data.reminders);
  const runs = data.runs?.runs || [];
  const trips = data.kitchen_trips || [];
  const dateMap = buildActivityDateMap(runs, trips, data.activity_log, hiddenTypes);
  const grid = monthGrid(today, monthOffset);

  const selDate = selectedDate || today;
  const selLabel = selDate === today ? 'Today' : fmtDayLabel(selDate);

  function selectDate(dateStr: string) {
    setSelectedDate(dateStr === selectedDate || dateStr === today ? null : dateStr);
  }

  function confirmRemoveDot(date: string, type: string) {
    if (type === 'run') {
      onConfirm('Remove this run?', () => onRemoveRun(date));
      return;
    }
    if (type === 'kitchen') {
      onConfirm(`Remove kitchen trip on ${date}?`, () => onRemoveTrip(date));
      return;
    }
    const info = typeMap[type] || { label: type };
    onConfirm(
      <>
        Remove <b>{info.label}</b> on {date}?
      </>,
      () => onRemoveActivity(date, type),
    );
  }

  function saveRun() {
    onLogRun(runDate, parseInt(runMinutes, 10) || null, runNotes.trim());
    setRunFormOpen(false);
    setRunMinutes('');
    setRunNotes('');
  }

  // Calendar rows: leading blanks + day cells, chunked by 7.
  const cells: ReactNode[] = [];
  for (let i = 0; i < grid.startDow; i++) {
    cells.push(<td key={`lead-${i}`} className={styles.emptyCell} />);
  }
  grid.dates.forEach((dateStr, idx) => {
    const day = idx + 1;
    const isToday = dateStr === today;
    const isFuture = dateStr > today;
    const isPast = dateStr < today;
    const entries = dateMap[dateStr] || [];
    const isSelected = selectedDate ? dateStr === selectedDate : isToday;
    const cls = [
      isToday ? styles.cellToday : '',
      isSelected ? styles.cellSelected : '',
      isFuture ? styles.cellFuture : styles.cellClickable,
      isPast ? styles.cellPast : '',
    ]
      .filter(Boolean)
      .join(' ');
    cells.push(
      <td key={dateStr} className={cls} onClick={isFuture ? undefined : () => selectDate(dateStr)}>
        <div className={styles.calDay}>{day}</div>
        {entries.length ? (
          <div className={styles.calDots}>
            {entries.map((type) => {
              const info = typeMap[type] || { label: type, color: '#999', shape: 'circle' as DotShape };
              return (
                <button
                  key={type}
                  type="button"
                  className={`${styles.dot} ${shapeClass(info)}`}
                  style={{ '--dot-color': info.color } as React.CSSProperties}
                  title={`${info.label} — ${dateStr}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmRemoveDot(dateStr, type);
                  }}
                />
              );
            })}
          </div>
        ) : null}
      </td>,
    );
  });
  const trailing = (grid.startDow + grid.daysInMonth) % 7;
  if (trailing > 0) {
    for (let i = trailing; i < 7; i++) cells.push(<td key={`trail-${i}`} className={styles.emptyCell} />);
  }
  const rows: ReactNode[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(<tr key={i}>{cells.slice(i, i + 7)}</tr>);
  }

  // Stats
  const runTarget = data.runs?.target_per_week || 3;
  const thisWeekRuns = runsThisWeek(runs, today);
  const tripDaysAgo = daysSinceLastTrip(trips, today);
  const sheetsDaysAgo = daysSinceLastOfType(data.activity_log, 'laundry-sheets', today);

  const recent = [...runs].reverse().slice(0, 10);

  return (
    <div>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.navBtn}
          title="Previous month"
          onClick={() => setMonthOffset((o) => o - 1)}
        >
          &#8249;
        </button>
        <span>{grid.monthLabel}</span>
        <button
          type="button"
          className={`${styles.navBtn} ${monthOffset >= 0 ? styles.navHidden : ''}`}
          title="Next month"
          onClick={() => setMonthOffset((o) => Math.min(0, o + 1))}
        >
          &#8250;
        </button>
      </div>

      <div className={styles.cal}>
        <table>
          <thead>
            <tr>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <th key={d}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>

      <div className={styles.legend}>
        {Object.entries(typeMap).map(([key, info]) =>
          isPublic && privList.includes(key) ? null : (
            <span key={key}>
              <span
                className={`${styles.ldot} ${shapeClass(info)}`}
                style={{ '--dot-color': info.color } as React.CSSProperties}
              />
              {info.label}
            </span>
          ),
        )}
      </div>

      <div className={styles.stats}>
        <div>
          <span className={styles.statVal} style={{ '--act-color': 'var(--green)' } as React.CSSProperties}>
            {thisWeekRuns}
          </span>
          <span className={styles.statMuted}>/{runTarget} runs this week</span>
        </div>
        {tripDaysAgo !== null ? (
          <div>
            <span className={styles.statVal} style={{ '--act-color': '#4A90D9' } as React.CSSProperties}>
              {tripDaysAgo === 0 ? 'today' : `${tripDaysAgo}d`}
            </span>{' '}
            <span className={styles.statMuted}>since groceries</span>
          </div>
        ) : null}
        {sheetsDaysAgo !== null ? (
          <div>
            <span className={styles.statVal} style={{ '--act-color': '#E06060' } as React.CSSProperties}>
              {sheetsDaysAgo === 0 ? 'today' : `${sheetsDaysAgo}d`}
            </span>{' '}
            <span className={styles.statMuted}>since sheets</span>
          </div>
        ) : null}
      </div>

      {!isPublic ? (
        <>
          <div className={styles.logForRow}>
            <span className={`${styles.logForLabel} ${selDate !== today ? styles.logForBackdated : ''}`}>
              Log for: {selLabel}
            </span>
            {selDate !== today ? (
              <button type="button" className={styles.backBtn} onClick={() => setSelectedDate(null)}>
                Back to today
              </button>
            ) : null}
          </div>

          {/* Run + Grocery keep their special subsystems; the rest are
              generated from the reminder registry. */}
          <div className={styles.btns}>
            <button
              type="button"
              className={styles.chip}
              style={{ '--act-color': 'var(--green)' } as React.CSSProperties}
              onClick={() => setRunFormOpen((v) => !v)}
            >
              + Run
            </button>
            <button
              type="button"
              className={styles.chip}
              style={{ '--act-color': '#4A90D9' } as React.CSSProperties}
              onClick={() => onLogTrip(selDate)}
            >
              + Grocery
            </button>
            {(data.reminders || []).map((r) => (
              <button
                key={r.id || r.type}
                type="button"
                className={styles.chip}
                style={{ '--act-color': r.color || '#9AA0B5' } as React.CSSProperties}
                onClick={() => onLogActivity(selDate, r.type)}
              >
                + {r.emoji ? `${r.emoji} ` : ''}
                {r.label}
              </button>
            ))}
          </div>

          {runFormOpen ? (
            <div className={styles.runForm}>
              <div className={styles.runFormRow}>
                <div className={styles.runField}>
                  <label htmlFor="lifemap-run-date">Date</label>
                  <input id="lifemap-run-date" type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} />
                </div>
                <div className={styles.runField}>
                  <label htmlFor="lifemap-run-minutes">Minutes</label>
                  <input
                    id="lifemap-run-minutes"
                    type="number"
                    placeholder="30"
                    className={styles.runMinutes}
                    value={runMinutes}
                    onChange={(e) => setRunMinutes(e.target.value)}
                  />
                </div>
                <div className={styles.runField}>
                  <label htmlFor="lifemap-run-notes">Notes</label>
                  <input
                    id="lifemap-run-notes"
                    type="text"
                    placeholder="Easy pace, felt good..."
                    className={styles.runNotes}
                    value={runNotes}
                    onChange={(e) => setRunNotes(e.target.value)}
                  />
                </div>
                <button type="button" className={styles.runSave} onClick={saveRun}>
                  Save
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {recent.length ? (
        <details className={styles.recentRuns}>
          <summary className={styles.recentSummary}>Recent runs</summary>
          <div style={{ marginTop: 8 }}>
            {recent.map((r) => (
              <div key={r.date} className={styles.runItem}>
                <span className={styles.runDate}>{fmtDayLabel(r.date)}</span>
                {r.minutes ? <span>{r.minutes} min</span> : null}
                {r.notes ? <span className={styles.runNotesText}>{r.notes}</span> : null}
                {!isPublic ? (
                  <button
                    type="button"
                    className={styles.runDelete}
                    title="Remove"
                    onClick={() => onConfirm('Remove this run?', () => onRemoveRun(r.date))}
                  >
                    &times;
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
