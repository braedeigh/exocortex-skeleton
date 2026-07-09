import { useEffect, useMemo, useState } from 'react';
import { ToastStack } from '../../ui';
import { GraduationPrompts } from '../habits/GraduationPrompts';
import { HabitsColumn } from '../habits/HabitsColumn';
import { pickTimeSegment } from '../habits/habitMath';
import type { TimeSegment } from '../habits/habitMath';
import { AddBar } from './AddBar';
import { DetailSheet } from './DetailSheet';
import { FocusChips } from './FocusChips';
import { NotesPill } from './NotesPill';
import { ReminderCard } from './ReminderCard';
import { SnoozedCard } from './SnoozedCard';
import { StreaksRow } from './StreaksRow';
import { TodoSection } from './TodoSection';
import {
  DONE_LABEL,
  LADDER_LABELS,
  collectSnoozed,
  computeFocusCounts,
  focusMatch,
  visibleSectionItems,
} from './todoHelpers';
import { isFrosted } from './types';
import type { TodoItem } from './types';
import { useHabitActions, useTodayData, useTodoActions, useReminderActions, useToasts } from './useTodayData';
import styles from './TodosPage.module.css';

const FOCUS_STORAGE_KEY = 'todoFocusTheme';
const GREETINGS: Record<TimeSegment, string> = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
};

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

function readStoredFocus(): string {
  try {
    return localStorage.getItem(FOCUS_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredFocus(theme: string) {
  try {
    localStorage.setItem(FOCUS_STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable — focus just won't persist across visits
  }
}

export function TodosPage() {
  const { data, isLoading, isError, error } = useTodayData();
  const { toasts, push, dismiss } = useToasts();
  const todoActions = useTodoActions(push);
  const reminderActions = useReminderActions(push);
  const habitActions = useHabitActions(push);
  const isPublic = isPublicMode();

  const [focusTheme, setFocusThemeState] = useState(readStoredFocus);
  const [selected, setSelected] = useState<TodoItem | null>(null);
  // Controls both the greeting text and which habit cards show — mirrors the
  // old page's single `selectedTime` global (core.js getTime()).
  const [manualSegment, setManualSegment] = useState<TimeSegment | null>(null);

  function setFocusTheme(theme: string) {
    setFocusThemeState(theme);
    writeStoredFocus(theme);
  }

  const frosted = data ? isFrosted(data.todos) : false;
  const serverDate = data?.server_date || '';
  const sections = useMemo(
    () => (data && !frosted && Array.isArray(data.todos) ? data.todos : []),
    [data, frosted],
  );

  const ladderSections = useMemo(() => sections.filter((s) => LADDER_LABELS.includes(s.name as (typeof LADDER_LABELS)[number])), [sections]);
  const doneSection = useMemo(() => sections.find((s) => s.name === DONE_LABEL), [sections]);
  const snoozed = useMemo(
    () => collectSnoozed(sections, serverDate).filter((it) => focusMatch(it, focusTheme)),
    [sections, serverDate, focusTheme],
  );
  const focusCounts = useMemo(() => computeFocusCounts(sections, serverDate), [sections, serverDate]);

  const currentSection = useMemo(() => {
    if (!selected) return null;
    for (const s of sections) {
      if (s.items.some((it) => it.id === selected.id)) return s.name;
    }
    return null;
  }, [selected, sections]);

  useEffect(() => {
    if (!selected) return;
    for (const s of sections) {
      const found = s.items.find((it) => it.id === selected.id);
      if (found) {
        if (found !== selected) setSelected(found);
        return;
      }
    }
    setSelected(null);
  }, [sections, selected]);

  if (isLoading) {
    return <div className={styles.page}><div className={styles.loading}>Loading&hellip;</div></div>;
  }

  if (isError || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>Failed to load: {error instanceof Error ? error.message : 'unknown error'}</div>
      </div>
    );
  }

  const segment = manualSegment ?? pickTimeSegment(data.server_hour);
  const habits = data.habits || [];
  const habitsLog = data.habits_log || {};
  const streaks = Array.isArray(data.streaks) ? data.streaks : [];

  return (
    <div className={styles.page}>
      {data.reminders ? (
        <ReminderCard
          reminders={data.reminders}
          activityLog={data.activity_log}
          serverDate={data.server_date}
          timeOfDay={data.time_of_day}
          onLog={reminderActions.log}
          onUndo={reminderActions.undo}
          onSnooze={reminderActions.snooze}
        />
      ) : null}

      <SnoozedCard items={snoozed} onUnsnooze={(id) => todoActions.snooze(id, 0)} />

      {!isPublic ? (
        <>
          <div className={styles.greeting}>{GREETINGS[segment]}</div>
          <div className={styles.dateLine}>{data.date}</div>
          {/* TODO(habits phase 2): "Show hidden prompts" expand-all toggle
              lived here (old #expand-btn next to date-text). */}
          <StreaksRow streaks={streaks} />
          <GraduationPrompts
            habits={habits}
            hidden={data.habit_settings?.hidden || []}
            cadenceMap={data.habit_cadence}
            metaMap={data.habit_meta}
            log={habitsLog}
            cadenceConfig={data.cadence_config}
            serverDate={serverDate}
            onPromote={habitActions.promote}
            onRestore={habitActions.restore}
          />
        </>
      ) : null}

      {frosted ? (
        <div className={styles.frosted}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div className={styles.frostedRow} key={i} />
          ))}
        </div>
      ) : (
        <div className={styles.twoCol}>
          {!isPublic ? (
            <HabitsColumn
              habits={habits}
              habitSettings={data.habit_settings}
              cadenceMap={data.habit_cadence}
              metaMap={data.habit_meta}
              log={habitsLog}
              cadenceConfig={data.cadence_config}
              starts={data.habit_starts}
              segment={segment}
              onSegmentChange={setManualSegment}
              serverDate={serverDate}
              onToggle={(item, section) => habitActions.toggle(item, section, serverDate)}
            />
          ) : null}

          <div>
            <div className={styles.colHeader}>To Do</div>
            <FocusChips counts={focusCounts} active={focusTheme} onChange={setFocusTheme} />
            <AddBar onAdd={todoActions.add} />

            {focusTheme && focusCounts.total === 0 ? (
              <div className={styles.emptyFocus}>Nothing here right now. 🎉</div>
            ) : (
              ladderSections.map((section, i) => (
                <TodoSection
                  key={section.name}
                  label={section.name}
                  colorIndex={i}
                  items={visibleSectionItems(section, serverDate, focusTheme)}
                  manualOrder={section.manual_order}
                  serverDate={serverDate}
                  defaultOpen={section.name === 'Now'}
                  onToggle={todoActions.toggle}
                  onOpenDetail={setSelected}
                  onReorder={todoActions.reorder}
                  onAutosort={todoActions.autosort}
                  onMove={todoActions.move}
                />
              ))
            )}

            {doneSection ? (
              <TodoSection
                label={DONE_LABEL}
                colorIndex={3}
                items={doneSection.items}
                manualOrder={false}
                serverDate={serverDate}
                defaultOpen={false}
                countMode="total"
                onToggle={todoActions.toggle}
                onOpenDetail={setSelected}
                onReorder={todoActions.reorder}
                onAutosort={todoActions.autosort}
                onMove={todoActions.move}
              />
            ) : null}
          </div>
        </div>
      )}

      <DetailSheet
        item={selected}
        open={!!selected}
        currentSection={currentSection}
        onClose={() => setSelected(null)}
        onSave={(id, patch, newText) => {
          if (selected && newText !== selected.text) todoActions.rename(id, newText);
          todoActions.details(id, patch);
        }}
        onMove={(id, toLabel) => todoActions.move(id, toLabel)}
        onSnooze={(id, days) => todoActions.snooze(id, days)}
        onRemove={(id) => todoActions.remove(id)}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* Legacy iframe tabs still get this from static/js/notes-pill.js;
          the native /todos page needs its own mount. Public mode never
          reaches this page, but the guard is cheap insurance. */}
      {!isPublic ? <NotesPill onError={push} /> : null}
    </div>
  );
}
