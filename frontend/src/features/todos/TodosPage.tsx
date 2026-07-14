import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { ToastStack } from '../../ui';
import { GraduationPrompts } from '../habits/GraduationPrompts';
import { HabitsColumn } from '../habits/HabitsColumn';
import { pickTimeSegment } from '../habits/habitMath';
import type { TimeSegment } from '../habits/habitMath';
import { AddBar } from './AddBar';
import { AddTodoSheet } from './AddTodoSheet';
import { DetailSheet } from './DetailSheet';
import { FocusChips } from './FocusChips';
import { NotesPill } from './NotesPill';
import { ReminderCard } from './ReminderCard';
import { SnoozedCard } from './SnoozedCard';
import { StreakSheet } from './StreakSheet';
import { StreaksRow } from './StreaksRow';
import { SymptomCard } from './SymptomCard';
import { TodoSection } from './TodoSection';
import { WaitingCard } from './WaitingCard';
import {
  DONE_LABEL,
  LADDER_LABELS,
  buildTodoIndex,
  collectSnoozed,
  collectWaiting,
  computeFocusCounts,
  focusMatch,
  visibleSectionItems,
  withFocusTheme,
} from './todoHelpers';
import type { AddTodoPayload } from '../../api/endpoints';
import { isFrosted } from './types';
import type { TodoItem } from './types';
import {
  useGrowthActions,
  useHabitActions,
  useStreakActions,
  useSymptomActions,
  useTodayData,
  useTodoActions,
  useReminderActions,
  useToasts,
} from './useTodayData';
import styles from './TodosPage.module.css';

const FOCUS_STORAGE_KEY = 'todoFocusTheme';
const HABITS_HIDDEN_KEY = 'todoHabitsHidden';
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

function readStoredHabitsHidden(): boolean {
  try {
    return localStorage.getItem(HABITS_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredHabitsHidden(hidden: boolean) {
  try {
    localStorage.setItem(HABITS_HIDDEN_KEY, hidden ? '1' : '');
  } catch {
    // localStorage unavailable — the choice just won't persist across visits
  }
}

export function TodosPage() {
  const { data, isLoading, isError, error } = useTodayData();
  const { toasts, push, dismiss } = useToasts();
  const todoActions = useTodoActions(push);
  const reminderActions = useReminderActions(push);
  const habitActions = useHabitActions(push);
  const growthActions = useGrowthActions(push);
  const streakActions = useStreakActions(push);
  const symptomActions = useSymptomActions(push);
  const isPublic = isPublicMode();

  const [focusTheme, setFocusThemeState] = useState(readStoredFocus);
  // Desktop breathing room: collapse the habits column so To Do spans the
  // whole pane. Never offered to public visitors — habits are their view.
  const [habitsHidden, setHabitsHiddenState] = useState(readStoredHabitsHidden);
  const [selected, setSelected] = useState<TodoItem | null>(null);
  // Streaks are keyed by label+since (no id) — the sheet re-derives its
  // streak from the polled data so "Day N" stays live while it's open.
  const [streakKey, setStreakKey] = useState<{ label: string; since: string } | null>(null);
  // Which section's "+ add" opened the add sheet; null = closed.
  const [addSection, setAddSection] = useState<string | null>(null);
  // Controls both the greeting text and which habit cards show — mirrors the
  // old page's single `selectedTime` global (core.js getTime()).
  const [manualSegment, setManualSegment] = useState<TimeSegment | null>(null);

  function setFocusTheme(theme: string) {
    setFocusThemeState(theme);
    writeStoredFocus(theme);
  }

  function setHabitsHidden(hidden: boolean) {
    setHabitsHiddenState(hidden);
    writeStoredHabitsHidden(hidden);
  }

  // Both add paths (quick-add bar, per-section "+ add" sheet) stamp the
  // active focus theme so the new item stays visible under the filter.
  function addTodo(payload: AddTodoPayload) {
    todoActions.add(withFocusTheme(payload, focusTheme));
  }

  const frosted = data ? isFrosted(data.todos) : false;
  const serverDate = data?.server_date || '';
  const sections = useMemo(
    () => (data && !frosted && Array.isArray(data.todos) ? data.todos : []),
    [data, frosted],
  );

  const ladderSections = useMemo(() => sections.filter((s) => LADDER_LABELS.includes(s.name as (typeof LADDER_LABELS)[number])), [sections]);
  const doneSection = useMemo(() => sections.find((s) => s.name === DONE_LABEL), [sections]);
  const todoIndex = useMemo(() => buildTodoIndex(sections), [sections]);
  // "Do after" blocker candidates: not-done ladder items, offered in the
  // detail/add sheets' blocker picker.
  const blockerCandidates = useMemo(
    () => ladderSections.flatMap((s) => s.items).filter((it) => !it.done),
    [ladderSections],
  );
  const snoozed = useMemo(
    () => collectSnoozed(sections, serverDate).filter((it) => focusMatch(it, focusTheme)),
    [sections, serverDate, focusTheme],
  );
  const waiting = useMemo(
    () => collectWaiting(sections, serverDate).filter((w) => focusMatch(w.item, focusTheme)),
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

  // The greeting always follows the server clock; the Morning/Midday/Evening
  // selector only changes which habit cards show, not the greeting.
  const clockSegment = pickTimeSegment(data.server_hour);
  const segment = manualSegment ?? clockSegment;
  const habits = data.habits || [];
  const habitsLog = data.habits_log || {};
  const streaks = Array.isArray(data.streaks) ? data.streaks : [];
  const openStreak = streakKey
    ? streaks.find((s) => s.label === streakKey.label && s.since === streakKey.since) || null
    : null;

  return (
    <div className={styles.page}>
      <SnoozedCard items={snoozed} onUnsnooze={(id) => todoActions.snooze(id, 0)} />
      <WaitingCard entries={waiting} onClear={(id) => todoActions.details(id, { after_date: '', after_id: '' })} />

      {!isPublic ? (
        <>
          <div className={styles.greetingRow}>
            <span className={styles.greeting}>{GREETINGS[clockSegment]}</span>
            <span className={styles.greetingDot} aria-hidden="true">&middot;</span>
            <span className={styles.dateLine}>{data.date}</span>
          </div>
          {/* TODO(habits phase 2): "Show hidden prompts" expand-all toggle
              lived here (old #expand-btn next to date-text). */}
          <StreaksRow streaks={streaks} onOpen={(s) => setStreakKey({ label: s.label, since: s.since })} />
          {/* Push notifications (sheets, estradiol, etc.) — moved down here
              with the day trackers, below the greeting (dev note 3c3a4dd3;
              used to render above the greeting at the very top of the page). */}
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
          <SymptomCard healthData={data.health_data} serverDate={serverDate} onLog={symptomActions.log} />
        </>
      ) : null}

      {/* The grid now always renders once data is loaded — for public
          visitors the habits column shows read-only (see HabitsColumn's
          `readOnly` prop) while the To Do column stays frosted below. This
          replaces the old "frosted -> whole grid replaced by placeholder"
          branch, which hid the habits she wants public visitors to see. */}
      <div className={`${styles.twoCol} ${habitsHidden && !isPublic ? styles.oneCol : ''}`}>
        {habitsHidden && !isPublic ? null : (
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
          // growth_notes arrives "frosted" (a {_frosted:true} placeholder
          // object, not an array) for public visitors — guard with
          // Array.isArray rather than trusting the declared type, since
          // that's a server-side redaction the TS types don't encode.
          growthNotes={Array.isArray(data.growth_notes) ? data.growth_notes : undefined}
          onGrowthAdd={growthActions.add}
          onGrowthRemove={growthActions.remove}
          onGrowthIncorporate={growthActions.incorporate}
          onGrowthReactivate={growthActions.reactivate}
          readOnly={isPublic}
          onHide={!isPublic ? () => setHabitsHidden(true) : undefined}
        />
        )}

        <div>
          <div className={styles.colHeaderRow}>
            <div className={styles.colHeader}>To Do</div>
            {!isPublic ? (
              <div className={styles.colHeaderActions}>
                {habitsHidden ? (
                  <button
                    type="button"
                    className={styles.headerBtn}
                    onClick={() => setHabitsHidden(false)}
                  >
                    &#9666; Show habits
                  </button>
                ) : null}
                <Link to="/todos/editor" className={styles.editorLink}>
                  &#9998; Edit all
                </Link>
              </div>
            ) : null}
          </div>

          {frosted ? (
            <>
              <div className={styles.frostedNote}>The to-do list itself is private.</div>
              <div className={styles.frosted}>
                {Array.from({ length: 5 }).map((_, i) => (
                  <div className={styles.frostedRow} key={i} />
                ))}
              </div>
            </>
          ) : (
            <>
              <FocusChips counts={focusCounts} active={focusTheme} onChange={setFocusTheme} />
              <AddBar onAdd={addTodo} focusTheme={focusTheme} />

              {focusTheme && focusCounts.total === 0 ? (
                <div className={styles.emptyFocus}>Nothing here right now. 🎉</div>
              ) : (
                ladderSections.map((section, i) => (
                  <TodoSection
                    key={section.name}
                    label={section.name}
                    colorIndex={i}
                    items={visibleSectionItems(section, serverDate, focusTheme, todoIndex)}
                    manualOrder={section.manual_order}
                    serverDate={serverDate}
                    defaultOpen={section.name === 'Now'}
                    focusTheme={focusTheme}
                    onToggle={todoActions.toggle}
                    onOpenDetail={setSelected}
                    onSubtaskToggle={todoActions.subtaskToggle}
                    onReorder={todoActions.reorder}
                    onAutosort={todoActions.autosort}
                    onMove={todoActions.move}
                    onAddClick={setAddSection}
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
                  onSubtaskToggle={todoActions.subtaskToggle}
                  onReorder={todoActions.reorder}
                  onAutosort={todoActions.autosort}
                  onMove={todoActions.move}
                />
              ) : null}
            </>
          )}
        </div>
      </div>

      <AddTodoSheet
        section={addSection}
        candidates={blockerCandidates}
        onClose={() => setAddSection(null)}
        onAdd={addTodo}
      />

      <StreakSheet
        streak={openStreak}
        open={!!openStreak}
        onClose={() => setStreakKey(null)}
        onSaveNotes={streakActions.saveNotes}
        onRemove={streakActions.remove}
      />

      <DetailSheet
        item={selected}
        open={!!selected}
        currentSection={currentSection}
        serverDate={serverDate}
        todoIndex={todoIndex}
        candidates={blockerCandidates}
        onClose={() => setSelected(null)}
        onSave={(id, patch, newText) => {
          if (selected && newText !== selected.text) todoActions.rename(id, newText);
          todoActions.details(id, patch);
        }}
        onMove={(id, toLabel) => todoActions.move(id, toLabel)}
        onSnooze={(id, days) => todoActions.snooze(id, days)}
        onRemove={(id) => todoActions.remove(id)}
        onSubtaskAdd={(id, text) => todoActions.subtaskAdd(id, text)}
        onSubtaskToggle={(id, subId) => todoActions.subtaskToggle(id, subId)}
        onSubtaskRemove={(id, subId) => todoActions.subtaskRemove(id, subId)}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* Legacy iframe tabs still get this from static/js/notes-pill.js;
          the native /todos page needs its own mount. Public mode never
          reaches this page, but the guard is cheap insurance. */}
      {!isPublic ? <NotesPill onError={push} /> : null}
    </div>
  );
}
