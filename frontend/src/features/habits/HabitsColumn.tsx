import { GrowthNotes } from './GrowthNotes';
import { HabitCard } from './HabitCard';
import { dailySectionViews } from './habitMath';
import type { TimeSegment } from './habitMath';
import { TimeSelector } from './TimeSelector';
import type {
  CadenceConfig,
  GrowthNote,
  HabitCadenceMap,
  HabitMetaMap,
  HabitSection,
  HabitSettings,
  HabitsLog,
  HabitStarts,
} from './types';
import styles from './HabitsColumn.module.css';

export interface HabitsColumnProps {
  habits: HabitSection[];
  habitSettings: HabitSettings | undefined;
  cadenceMap: HabitCadenceMap | undefined;
  metaMap: HabitMetaMap | undefined;
  log: HabitsLog;
  cadenceConfig: CadenceConfig | undefined;
  starts: HabitStarts | undefined;
  /** Controlled by the page (see TodosPage) — the same segment also drives
   * the greeting text, mirroring the old single `selectedTime` global that
   * both renderHeader and renderHabits read from. */
  segment: TimeSegment;
  onSegmentChange: (segment: TimeSegment) => void;
  serverDate: string;
  onToggle: (item: string, section: string) => void;
  growthNotes: GrowthNote[] | undefined;
  onGrowthAdd: (text: string) => void;
  onGrowthRemove: (text: string) => void;
  onGrowthIncorporate: (text: string) => void;
  onGrowthReactivate: (text: string) => void;
  /** Public (logged-out) visitors see the habits column but can't edit it —
   * checkboxes go inert (HabitCard) and Growth Notes (an editing surface,
   * not a display one) doesn't render at all. The TimeSelector stays
   * interactive either way: it's pure local view state, not a write. */
  readOnly?: boolean;
  /** When set, a "Hide" button renders in the header — collapses the column
   * so To Do can span the whole pane (TodosPage owns the state). */
  onHide?: () => void;
}

/** Left column of the To Do page's two-col grid — header + time selector +
 * today's habit cards. Faithful port of the daily view in habits.js
 * (renderHabits); the tracker grid, config modal, and drag/edit-reorder mode
 * are a later phase (see TODOs below). */
export function HabitsColumn({
  habits,
  habitSettings,
  cadenceMap,
  metaMap,
  log,
  cadenceConfig,
  starts,
  segment,
  onSegmentChange,
  serverDate,
  onToggle,
  growthNotes,
  onGrowthAdd,
  onGrowthRemove,
  onGrowthIncorporate,
  onGrowthReactivate,
  readOnly = false,
  onHide,
}: HabitsColumnProps) {
  const hidden = habitSettings?.hidden || [];
  const views = dailySectionViews(habits, segment, hidden, cadenceMap, metaMap, log, cadenceConfig, serverDate);

  return (
    <div>
      <div className={styles.head}>
        <div className={styles.header}>Habits</div>
        <TimeSelector value={segment} onChange={onSegmentChange} />
        {onHide ? (
          <button type="button" className={styles.hideBtn} onClick={onHide} title="Hide habits">
            Hide &#9656;
          </button>
        ) : null}
      </div>

      {views.length === 0 ? (
        <div className={styles.empty}>Nothing scheduled for this time of day.</div>
      ) : (
        views.map((v) =>
          v.allDone ? (
            <div className={styles.allDone} key={v.sectionName} style={{ color: v.color }}>
              &#10003; {v.label} — all done
            </div>
          ) : (
            <HabitCard
              key={v.sectionName}
              label={v.label}
              color={v.color}
              sectionName={v.sectionName}
              items={v.items}
              todayISO={serverDate}
              log={log}
              cadenceMap={cadenceMap || {}}
              metaMap={metaMap || {}}
              starts={starts || {}}
              onToggle={onToggle}
              readOnly={readOnly}
            />
          ),
        )
      )}

      {/* Growth Notes is an editing surface (add/remove/incorporate an
          aspiration) — public visitors don't get it at all, not even
          read-only, since there's nothing here worth showing half-baked. */}
      {!readOnly ? (
        <GrowthNotes
          notes={growthNotes}
          onAdd={onGrowthAdd}
          onRemove={onGrowthRemove}
          onIncorporate={onGrowthIncorporate}
          onReactivate={onGrowthReactivate}
        />
      ) : null}

      {/* TODO(habits phase 2): "Show hidden prompts" expand-all toggle so an
          all-done card can be expanded back open (old core.js expandedAll). */}
      {/* TODO(habits phase 2): evening kitchen close-out quiet checklist. */}
      {/* TODO(habits phase 2): "+ Tracked habit" -> habit config modal (name,
          time-of-day sections, optional course length). */}
      {/* TODO(habits phase 2): drag/reorder + rename + delete (edit mode),
          and the ↗ companion-page link (HABIT_LINKS) on linked habits. */}
    </div>
  );
}
