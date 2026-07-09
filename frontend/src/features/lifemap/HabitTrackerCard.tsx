import { useState, type ReactNode } from 'react';
import {
  habitCount,
  habitKey,
  habitStartLabel,
  readyToPromote,
  promoteTarget,
  spotCheckDue,
  STAGE_NEXT_LABEL,
} from '../habits/habitMath';
import type { HabitsLog } from '../habits/types';
import { lastNDays } from './calendarMath';
import { cadenceLists, finishedCourses, gridHabits, splitHabitSections } from './habitGrid';
import { AddForm, MoveMenu, RenameText } from './trackerBits';
import type { MapData } from './types';
import { useSnapRight } from './useSnapRight';
import styles from './HabitTrackerCard.module.css';

const UNHIT_COLOR = '#2a2a4a';
const TARGET = 60;

function fmtShort(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export interface HabitTrackerActions {
  toggleDate: (habit: string, date: string, section: string) => void;
  reorder: (section: string, items: string[]) => void;
  remove: (item: string) => void;
  add: (item: string, section: string) => Promise<unknown>;
  move: (item: string, toSection: string) => void;
  rename: (oldName: string, newName: string, section: string) => void;
  setHidden: (hidden: string[]) => void;
  promote: (section: string, habit: string) => void;
  restore: (section: string, habit: string) => void;
}

export interface HabitTrackerCardProps {
  data: MapData;
  actions: HabitTrackerActions;
  onConfirm: (text: ReactNode, onConfirm: () => void) => void;
  /** Open the habit config modal (item=null → the "New habit" flow). */
  onOpenConfig: (section: string | null, item: string | null) => void;
}

/** One habit's 30 day-cells — shared by the desktop table row and the mobile
 * per-habit block (habits.js dayCellsHTML). */
function DayCells({
  habit,
  sectionName,
  accentColor,
  days,
  log,
  startDate,
  onToggle,
  onConfirmRemove,
}: {
  habit: string;
  sectionName: string;
  accentColor: string;
  days: string[];
  log: HabitsLog;
  startDate: string | null;
  onToggle: (date: string) => void;
  onConfirmRemove: (date: string) => void;
}) {
  const key = habitKey(sectionName, habit);
  return (
    <>
      {days.map((d) => {
        if (startDate && d < startDate) {
          return (
            <td key={d}>
              <div className={`${styles.dot} ${styles.dotPrestart}`} title="Before this habit started" />
            </td>
          );
        }
        const hit = !!log[d]?.[key];
        return (
          <td key={d}>
            <button
              type="button"
              className={styles.dot}
              style={{ background: hit ? accentColor : UNHIT_COLOR }}
              title={hit ? 'Click to remove' : 'Click to log'}
              onClick={() => (hit ? onConfirmRemove(d) : onToggle(d))}
            />
          </td>
        );
      })}
    </>
  );
}

function DesktopGrid({ children }: { children: ReactNode }) {
  const snapRef = useSnapRight();
  return (
    <div className={`${styles.dotGrid} ${styles.gridDesktop}`} ref={snapRef}>
      <table>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function MobileDotRow({ children }: { children: ReactNode }) {
  const snapRef = useSnapRight();
  return (
    <div className={styles.dotGrid} ref={snapRef}>
      <table>
        <tbody>
          <tr>{children}</tr>
        </tbody>
      </table>
    </div>
  );
}

export function HabitTrackerCard({ data, actions, onConfirm, onOpenConfig }: HabitTrackerCardProps) {
  const today = data.server_date;
  const log = data.habits_log || {};
  const hidden = data.habit_settings?.hidden || [];
  const [buildingEdit, setBuildingEdit] = useState(false);

  const split = splitHabitSections(data.habits);
  const { allMorning, allMidday, allNight, weeklySections, weeklyGoals, sectionNames } = split;

  if (!allMorning.length && !allMidday.length && !allNight.length) return null;

  const morningHabits = gridHabits(allMorning, sectionNames.morning, hidden, data.habit_cadence, data.habit_meta, today);
  const middayHabits = gridHabits(allMidday, sectionNames.midday, hidden, data.habit_cadence, data.habit_meta, today);
  const nightHabits = gridHabits(allNight, sectionNames.night, hidden, data.habit_cadence, data.habit_meta, today);

  const days = lastNDays(today, 30);

  function confirmRemoveDot(habit: string, date: string, section: string) {
    onConfirm(
      <>
        Remove <b>{habit}</b> on {date}?
      </>,
      () => actions.toggleDate(habit, date, section),
    );
  }

  function confirmDeleteHabit(habit: string) {
    onConfirm(
      <>
        Remove <b>{habit}</b>?
      </>,
      () => actions.remove(habit),
    );
  }

  const dateHeader = (
    <tr>
      <td className={styles.metricLabel} style={{ minWidth: 90 }} />
      {days.map((d, i) => {
        const show = i % 5 === 0 || i === days.length - 1;
        const dt = new Date(`${d}T12:00:00`);
        return (
          <td key={d} className={styles.dateLabel}>
            {show ? (
              <span className={styles.dateLabel}>
                {dt.toLocaleDateString('en-US', { month: 'short' })}
                <br />
                {dt.getDate()}
              </span>
            ) : null}
          </td>
        );
      })}
    </tr>
  );

  function countLabel(habit: string, sectionName: string): string {
    return `${habitStartLabel(data.habit_starts, habit, today)}${habitCount(log, habit, sectionName)}/${TARGET}`;
  }

  function habitRow(habit: string, accentColor: string, sectionName: string) {
    const maxLen = 30;
    const shortName = habit.length > maxLen ? `${habit.slice(0, maxLen)}...` : habit;
    return (
      <tr key={habit}>
        <td className={styles.metricLabel}>
          {shortName}
          <span className={styles.metricCount}>{countLabel(habit, sectionName)}</span>
        </td>
        <DayCells
          habit={habit}
          sectionName={sectionName}
          accentColor={accentColor}
          days={days}
          log={log}
          startDate={data.habit_starts?.[habit] || null}
          onToggle={(d) => actions.toggleDate(habit, d, sectionName)}
          onConfirmRemove={(d) => confirmRemoveDot(habit, d, sectionName)}
        />
      </tr>
    );
  }

  function mobileBlock(habit: string, accentColor: string, sectionName: string) {
    return (
      <div key={habit} className={styles.mobileBlock}>
        <div className={styles.mobileTitle}>
          {habit}
          <span className={styles.mobileCount}>{countLabel(habit, sectionName)}</span>
        </div>
        <MobileDotRow>
          <DayCells
            habit={habit}
            sectionName={sectionName}
            accentColor={accentColor}
            days={days}
            log={log}
            startDate={data.habit_starts?.[habit] || null}
            onToggle={(d) => actions.toggleDate(habit, d, sectionName)}
            onConfirmRemove={(d) => confirmRemoveDot(habit, d, sectionName)}
          />
        </MobileDotRow>
      </div>
    );
  }

  // "Log symptoms" row tacked onto Morning (view-only dots).
  const healthData = data.health_data || [];
  const symCount = healthData.filter((h) => h.energy !== null && h.energy !== undefined).length;
  const symCells = days.map((d) => {
    const dayData = healthData.find((h) => h.date === d);
    const hit = !!dayData && dayData.energy !== null && dayData.energy !== undefined;
    return (
      <td key={d}>
        <div
          className={styles.dot}
          style={{ background: hit ? 'var(--morning)' : UNHIT_COLOR, cursor: 'default' }}
          title={`Symptoms: ${hit ? 'Logged' : 'Not logged'} on ${d}`}
        />
      </td>
    );
  });
  const symRow = (
    <tr>
      <td className={styles.metricLabel}>
        Log symptoms<span className={styles.metricCount}>{symCount}/{TARGET}</span>
      </td>
      {symCells}
    </tr>
  );
  const symRowMobile = (
    <div className={styles.mobileBlock}>
      <div className={styles.mobileTitle}>
        Log symptoms<span className={styles.mobileCount}>{symCount}/{TARGET}</span>
      </div>
      <MobileDotRow>{symCells}</MobileDotRow>
    </div>
  );

  function sectionBlock(
    title: string,
    color: string,
    habits: string[],
    accentColor: string,
    sectionName: string,
    extra?: ReactNode,
    extraMobile?: ReactNode,
  ) {
    if (!habits.length && !extra) return null;
    return (
      <div key={title}>
        <div className={styles.sectionHeader} style={{ color }}>
          {title}
        </div>
        <DesktopGrid>
          {dateHeader}
          {habits.map((h) => habitRow(h, accentColor, sectionName))}
          {extra}
        </DesktopGrid>
        <div className={styles.gridMobile}>
          {habits.map((h) => mobileBlock(h, accentColor, sectionName))}
          {extraMobile}
        </div>
      </div>
    );
  }

  const { graduated, retired } = cadenceLists(data.habits, data.habit_cadence);
  const finished = finishedCourses(data.habits, data.habit_meta, today);
  const routineTargets = [sectionNames.morning, sectionNames.midday, sectionNames.night];

  return (
    <div>
      {/* Easy-add: same "New habit" flow, without leaving the Map tab. */}
      <button
        type="button"
        className={styles.addHabitBtn}
        title="Add a habit with time-of-day and an optional course length"
        onClick={() => onOpenConfig(null, null)}
      >
        + Add habit
      </button>

      {sectionBlock('Morning', 'var(--morning)', morningHabits, 'var(--morning)', sectionNames.morning, symRow, symRowMobile)}
      {middayHabits.length
        ? sectionBlock('Midday', 'var(--ongoing)', middayHabits, 'var(--ongoing)', sectionNames.midday)
        : null}
      {sectionBlock('Evening', 'var(--evening)', nightHabits, 'var(--evening)', sectionNames.night)}

      {hidden.length ? (
        <div className={styles.hiddenNote}>
          {hidden.length} habit{hidden.length !== 1 ? 's' : ''} hidden
        </div>
      ) : null}

      {/* Building next — habits she wants to build, not yet in a routine. */}
      {weeklySections.length || weeklyGoals.length ? (
        <details className={styles.subDetails} open={buildingEdit || undefined}>
          <summary className={styles.subSummary}>
            Building next ({weeklyGoals.length})
            <button
              type="button"
              className={styles.subEditBtn}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setBuildingEdit((v) => !v);
              }}
            >
              {buildingEdit ? 'Done' : 'Edit'}
            </button>
          </summary>
          <div className={styles.subBody}>
            {buildingEdit ? (
              <div className={styles.buildEditBox}>
                <div className={styles.buildHint}>
                  Habits you want to build. Add them here, then &ldquo;Add to routine&rdquo; when you&rsquo;re ready
                  to start.
                </div>
                {weeklySections.map((sec) => (
                  <div key={sec.name}>
                    {sec.items.map((h) => (
                      <div key={h} className={styles.buildRow}>
                        <RenameText
                          value={h}
                          title="Click to edit wording"
                          onRename={(next) => actions.rename(h, next, sec.name)}
                        />
                        <MoveMenu
                          label="Add to routine ▾"
                          title="Move into a daily routine"
                          current={sec.name}
                          targets={routineTargets}
                          onMove={(to) => actions.move(h, to)}
                        />
                        <button
                          type="button"
                          className={styles.xBtn}
                          title="Remove"
                          onClick={() => confirmDeleteHabit(h)}
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                    <AddForm
                      triggerLabel="+ Add a habit to build"
                      placeholder="New habit to build toward..."
                      onAdd={(text) => void actions.add(text, sec.name)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.goalChips}>
                {weeklyGoals.map((g) => (
                  <span key={g} className={styles.goalChip}>
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>
        </details>
      ) : null}

      {/* Graduated: habits on a lighter cadence, plus retired ones. */}
      {graduated.length || retired.length ? (
        <details className={styles.subDetails}>
          <summary className={styles.subSummary}>Graduated ({graduated.length + retired.length})</summary>
          <div className={styles.subBody}>
            {graduated.map(({ section, item, c }) => {
              const stageColor = c.stage === 'monthly' ? 'var(--evening)' : 'var(--ongoing)';
              const nextLabel = STAGE_NEXT_LABEL[c.stage] || '';
              const ready = readyToPromote(c, data.cadence_config);
              const due = spotCheckDue(data.habit_cadence, section, item, today, data.cadence_config);
              return (
                <div key={`${section}|${item}`} className={styles.cadRow}>
                  <span className={styles.cadName}>{item}</span>
                  <span className={styles.stageChip} style={{ color: stageColor }}>
                    {c.stage}
                  </span>
                  {ready ? (
                    <span className={styles.cadMeta} style={{ color: stageColor }}>
                      ready for {nextLabel}
                    </span>
                  ) : (
                    <span className={styles.cadMeta}>
                      {c.passes || 0}/{promoteTarget(c, data.cadence_config)} &rarr; {nextLabel}
                    </span>
                  )}
                  {due ? (
                    <span className={styles.cadMeta} style={{ color: 'var(--ongoing)' }}>
                      due today
                    </span>
                  ) : (
                    <span className={styles.cadMeta}>next {c.next_check ? fmtShort(c.next_check) : ''}</span>
                  )}
                  {ready ? (
                    <button
                      type="button"
                      className={styles.cadBtn}
                      style={{ borderColor: stageColor, color: stageColor }}
                      onClick={() => actions.promote(section, item)}
                    >
                      &#127891; {nextLabel === 'retire' ? 'Retire' : `To ${nextLabel}`}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.cadBtn}
                    title="Bring back to daily"
                    onClick={() => actions.restore(section, item)}
                  >
                    &#8634; daily
                  </button>
                </div>
              );
            })}
            {retired.map(({ section, item }) => (
              <div key={`${section}|${item}`} className={styles.cadRow}>
                <span className={styles.cadNameDone}>{item}</span>
                <span className={styles.stageChip} style={{ color: 'var(--green)' }}>
                  retired
                </span>
                <button
                  type="button"
                  className={styles.cadBtn}
                  title="Bring back to daily"
                  onClick={() => actions.restore(section, item)}
                >
                  &#8634; daily
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {/* Finished courses: expired time-limited habits, archived but kept. */}
      {finished.length ? (
        <details className={styles.subDetails}>
          <summary className={styles.subSummary}>Finished courses ({finished.length})</summary>
          <div className={styles.subBody}>
            {finished.map(({ section, item, endISO }) => (
              <div key={item} className={styles.cadRow}>
                <span className={styles.cadNameDone}>{item}</span>
                <span className={styles.cadMeta} style={{ color: 'var(--green)' }}>
                  finished {fmtShort(endISO)}
                </span>
                <button
                  type="button"
                  className={styles.cadBtn}
                  title="Edit / extend"
                  onClick={() => onOpenConfig(section, item)}
                >
                  &#9881;&#65038; edit
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
