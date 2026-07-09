import { useRef, useState } from 'react';
import { splitHabitSections, moveTargets } from './habitGrid';
import { AddForm, MoveMenu, RenameText } from './trackerBits';
import type { HabitTrackerActions } from './HabitTrackerCard';
import type { MapData } from './types';
import styles from './HabitEditPanel.module.css';
import gridStyles from './HabitTrackerCard.module.css';

export interface HabitEditPanelProps {
  data: MapData;
  actions: HabitTrackerActions;
  onConfirmDelete: (habit: string) => void;
  /** Open the per-habit options modal (time of day, course). */
  onOpenConfig: (section: string, item: string) => void;
}

/**
 * "Edit habits" panel body (rendered in the shared editor modal) — port of
 * renderHabitTracker's editSection blocks in habits.js: visibility
 * checkboxes, click-to-rename, drag/button reorder, move-to-section, per-
 * habit options, delete, add.
 */
export function HabitEditPanel({ data, actions, onConfirmDelete, onOpenConfig }: HabitEditPanelProps) {
  const hidden = data.habit_settings?.hidden || [];
  const split = splitHabitSections(data.habits);
  const targets = moveTargets(split);
  const dragItem = useRef<{ section: string; habit: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  function toggleVisibility(habit: string, visible: boolean) {
    const next = visible ? hidden.filter((h) => h !== habit) : [...hidden, habit];
    actions.setHidden(next);
  }

  function commitRename(habit: string, next: string, section: string) {
    actions.rename(habit, next, section);
    // Keep the hidden list in sync when a hidden habit is renamed.
    if (hidden.includes(habit)) {
      actions.setHidden(hidden.map((h) => (h === habit ? next : h)));
    }
  }

  function moveWithin(section: string, items: string[], habit: string, dir: -1 | 1) {
    const i = items.indexOf(habit);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    actions.reorder(section, next);
  }

  function handleDrop(targetSection: string, targetHabit: string, items: string[]) {
    const src = dragItem.current;
    dragItem.current = null;
    setDragOver(null);
    if (!src || (src.section === targetSection && src.habit === targetHabit)) return;
    if (src.section !== targetSection) {
      actions.move(src.habit, targetSection);
      return;
    }
    const next = [...items];
    const fromIdx = next.indexOf(src.habit);
    const toIdx = next.indexOf(targetHabit);
    if (fromIdx === -1 || toIdx === -1) return;
    next.splice(toIdx, 0, next.splice(fromIdx, 1)[0]);
    actions.reorder(targetSection, next);
  }

  function section(title: string, color: string, habits: string[], sectionName: string) {
    return (
      <div key={sectionName}>
        <div className={styles.sectionTitle} style={{ color }}>
          {title}
        </div>
        <div>
          {habits.map((h) => {
            const isHidden = hidden.includes(h);
            const rowKey = `${sectionName}|${h}`;
            return (
              <div
                key={rowKey}
                className={`${styles.row} ${dragOver === rowKey ? styles.rowDragOver : ''}`}
                draggable
                onDragStart={(e) => {
                  dragItem.current = { section: sectionName, habit: h };
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(rowKey);
                }}
                onDragLeave={() => setDragOver((cur) => (cur === rowKey ? null : cur))}
                onDragEnd={() => {
                  dragItem.current = null;
                  setDragOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(sectionName, h, habits);
                }}
              >
                <span className={styles.dragHandle} title="Drag to reorder">
                  &#8942;&#8942;
                </span>
                <input
                  type="checkbox"
                  className={styles.visCheck}
                  checked={!isHidden}
                  onChange={(e) => toggleVisibility(h, e.target.checked)}
                />
                <RenameText value={h} strike={isHidden} onRename={(next) => commitRename(h, next, sectionName)} />
                <button
                  type="button"
                  className={gridStyles.smallBtn}
                  title="Move up"
                  onClick={() => moveWithin(sectionName, habits, h, -1)}
                >
                  &#9650;
                </button>
                <button
                  type="button"
                  className={gridStyles.smallBtn}
                  title="Move down"
                  onClick={() => moveWithin(sectionName, habits, h, 1)}
                >
                  &#9660;
                </button>
                <MoveMenu
                  label="&#8596;"
                  title="Move to section"
                  current={sectionName}
                  targets={targets}
                  onMove={(to) => actions.move(h, to)}
                />
                <button
                  type="button"
                  className={gridStyles.smallBtn}
                  title="Options — time of day, course"
                  onClick={() => onOpenConfig(sectionName, h)}
                >
                  &#9881;&#65038;
                </button>
                <button type="button" className={gridStyles.xBtn} title="Remove" onClick={() => onConfirmDelete(h)}>
                  &times;
                </button>
              </div>
            );
          })}
        </div>
        <AddForm
          triggerLabel="+ Add habit"
          placeholder="New habit..."
          indent
          onAdd={(text) => void actions.add(text, sectionName)}
        />
      </div>
    );
  }

  return (
    <div>
      <div className={styles.hint}>Drag to reorder, click a name to rename.</div>
      {section('Morning', 'var(--morning)', split.allMorning, split.sectionNames.morning)}
      {section('Midday', 'var(--ongoing)', split.allMidday, split.sectionNames.midday)}
      {section('Evening', 'var(--evening)', split.allNight, split.sectionNames.night)}
    </div>
  );
}
