import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { ToastStack } from '../../ui';
import { GraduationPrompts } from '../habits/GraduationPrompts';
import { HabitsColumn } from '../habits/HabitsColumn';
import { pickTimeSegment } from '../habits/habitMath';
import type { TimeSegment } from '../habits/habitMath';
import { AddBar } from './AddBar';
import { FocusChips } from './FocusChips';
import { useFronts } from '../fronts/useFronts';
import { NotNowCard } from './NotNowCard';
import type { NotNowEntry } from './NotNowCard';
import { NotesPill } from './NotesPill';
import { UpNowCard } from './UpNowCard';
import { SnoozedCard } from './SnoozedCard';
import { StreakSheet } from './StreakSheet';
import { StreaksRow } from './StreaksRow';
import { SymptomCard } from './SymptomCard';
import { TodoFormSheet } from './TodoFormSheet';
import { TodoSection } from './TodoSection';
import { TomorrowCard } from './TomorrowCard';
import { WaitingCard } from './WaitingCard';
import {
  DONE_LABEL,
  LADDER_LABELS,
  buildTodoIndex,
  collectSnoozed,
  collectTomorrow,
  collectUpNow,
  collectWaiting,
  computeFocusCounts,
  focusMatch,
  gateHides,
  visibleSectionItems,
  withFocusFront,
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

// Key name predates the fronts vocabulary — kept so the persisted filter
// (already a front id) survives the rename.
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

function writeStoredFocus(front: string) {
  try {
    localStorage.setItem(FOCUS_STORAGE_KEY, front);
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
  const frontsQuery = useFronts();
  const fronts = frontsQuery.data ?? [];
  const reminderActions = useReminderActions(push);
  const habitActions = useHabitActions(push);
  const growthActions = useGrowthActions(push);
  const streakActions = useStreakActions(push);
  const symptomActions = useSymptomActions(push);
  const isPublic = isPublicMode();

  const [focusFront, setFocusFrontState] = useState(readStoredFocus);
  // Desktop breathing room: collapse the habits column so To Do spans the
  // whole pane. Never offered to public visitors — habits are their view.
  const [habitsHidden, setHabitsHiddenState] = useState(readStoredHabitsHidden);
  // Context gates off — everything shows. Deliberately NOT persisted: a
  // fresh visit always starts back in the auto (gated) view.
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<TodoItem | null>(null);
  // Streaks are keyed by label+since (no id) — the sheet re-derives its
  // streak from the polled data so "Day N" stays live while it's open.
  const [streakKey, setStreakKey] = useState<{ label: string; since: string } | null>(null);
  // Staged prefill for the "+ add" flow — set by a section header's "+ add"
  // button or AddBar's expand-to-full-editor icon; null = the add form is
  // closed. `text`/`due_by` mirror whatever the launch point already had
  // typed/picked so it isn't lost when the form takes over.
  const [addDraft, setAddDraft] = useState<{ section: string; text?: string; due_by?: string } | null>(null);
  // Controls both the greeting text and which habit cards show — mirrors the
  // old page's single `selectedTime` global (core.js getTime()).
  const [manualSegment, setManualSegment] = useState<TimeSegment | null>(null);

  function setFocusFront(front: string) {
    setFocusFrontState(front);
    writeStoredFocus(front);
  }

  function setHabitsHidden(hidden: boolean) {
    setHabitsHiddenState(hidden);
    writeStoredHabitsHidden(hidden);
  }

  // Both add paths (quick-add bar, per-section "+ add" sheet) stamp the
  // active focus front so the new item stays visible under the filter.
  function addTodo(payload: AddTodoPayload) {
    todoActions.add(withFocusFront(payload, focusFront));
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
    () => collectSnoozed(sections, serverDate).filter((it) => focusMatch(it, focusFront)),
    [sections, serverDate, focusFront],
  );
  const waiting = useMemo(
    () => collectWaiting(sections, serverDate).filter((w) => focusMatch(w.item, focusFront)),
    [sections, serverDate, focusFront],
  );
  const focusCounts = useMemo(() => computeFocusCounts(sections, serverDate), [sections, serverDate]);

  // Context gating (todo_view_rules): compare the client clock against each
  // front's visibility window. The page re-renders at least every 5s (the
  // today poll), so the clock stays fresh without its own timer. Gates are
  // off entirely for public visitors and while "Show all" is on.
  const hhmm = new Date().toTimeString().slice(0, 5);
  const gateRules = !isPublic && !showAll ? data?.todo_view_rules : undefined;
  const hasGateRules = !isPublic && !!data?.todo_view_rules?.windows;
  const gatedBySection = useMemo(() => {
    const shown = new Map<string, TodoItem[]>();
    const notNow: NotNowEntry[] = [];
    for (const s of ladderSections) {
      const base = visibleSectionItems(s, serverDate, focusFront, todoIndex);
      if (!gateRules) {
        shown.set(s.name, base);
        continue;
      }
      const keep: TodoItem[] = [];
      for (const item of base) {
        if (gateHides(item, s.name, gateRules, hhmm, serverDate)) notNow.push({ item, section: s.name });
        else keep.push(item);
      }
      shown.set(s.name, keep);
    }
    return { shown, notNow };
  }, [ladderSections, serverDate, focusFront, todoIndex, gateRules, hhmm]);

  const upNow = useMemo(
    () => collectUpNow(sections, serverDate).filter((it) => focusMatch(it, focusFront)),
    [sections, serverDate, focusFront],
  );

  const tomorrowItems = useMemo(
    () => collectTomorrow(sections, serverDate).filter((it) => focusMatch(it, focusFront)),
    [sections, serverDate, focusFront],
  );

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

  // TodoFormSheet's `currentSection`/`prefill` for whichever flow is active
  // (edit wins when both happen to be set, matching `mode` below). The
  // active focus front rides along as a prefilled (deselectable) chip, the
  // same set withFocusFront would stamp onto the AddBar's own quick path.
  const formCurrentSection = currentSection ?? addDraft?.section ?? null;
  const formPrefill = addDraft
    ? {
        text: addDraft.text,
        dueBy: addDraft.due_by,
        fronts: focusFront && focusFront !== '__none__' ? [focusFront] : undefined,
      }
    : undefined;

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
          {/* The one attention surface: due reminders (formerly the push-
              notification banners — merged 2026-07-20, replacing ReminderCard)
              + overdue/due-today to-dos, with the Tomorrow look-ahead under
              it. Kept below the greeting per dev note 3c3a4dd3. */}
          <UpNowCard
            items={upNow}
            reminders={data.reminders || []}
            activityLog={data.activity_log || []}
            serverDate={serverDate}
            timeOfDay={data.time_of_day}
            onToggle={todoActions.toggle}
            onOpenDetail={setSelected}
            onLog={reminderActions.log}
            onUndo={reminderActions.undo}
            onSnooze={reminderActions.snooze}
          />
          <TomorrowCard
            items={tomorrowItems}
            onToggle={todoActions.toggle}
            onOpenDetail={setSelected}
          />
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
                {hasGateRules ? (
                  <button
                    type="button"
                    className={`${styles.headerBtn} ${showAll ? styles.headerBtnActive : ''}`}
                    onClick={() => setShowAll((v) => !v)}
                    title={showAll ? 'Back to the auto view' : 'Show everything, gates off'}
                  >
                    {showAll ? '✓ Showing all' : '👁 Show all'}
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
              <FocusChips counts={focusCounts} active={focusFront} fronts={fronts} onChange={setFocusFront} />
              <AddBar
                onAdd={addTodo}
                onExpand={(pre) => setAddDraft(pre)}
                focusFront={focusFront}
                fronts={fronts}
              />

              {focusFront && focusCounts.total === 0 ? (
                <div className={styles.emptyFocus}>Nothing here right now. 🎉</div>
              ) : (
                ladderSections.map((section, i) => (
                  <TodoSection
                    key={section.name}
                    label={section.name}
                    colorIndex={i}
                    items={gatedBySection.shown.get(section.name) || []}
                    manualOrder={section.manual_order}
                    serverDate={serverDate}
                    fronts={fronts}
                    defaultOpen={section.name === 'Now'}
                    focusFront={focusFront}
                    onToggle={todoActions.toggle}
                    onOpenDetail={setSelected}
                    onSubtaskToggle={todoActions.subtaskToggle}
                    onReorder={todoActions.reorder}
                    onAutosort={todoActions.autosort}
                    onMove={todoActions.move}
                    onAddClick={(label) => setAddDraft({ section: label })}
                  />
                ))
              )}

              <NotNowCard entries={gatedBySection.notNow} fronts={fronts} onOpenDetail={setSelected} />

              {doneSection ? (
                <TodoSection
                  label={DONE_LABEL}
                  colorIndex={3}
                  items={doneSection.items}
                  manualOrder={false}
                  serverDate={serverDate}
                  fronts={fronts}
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

              {/* Waiting lives at the very bottom, below Done — it's the
                  "not actionable yet" tail of the column, not a headline
                  (used to render at the very top of the page). */}
              <WaitingCard
                entries={waiting}
                onClear={(id) => todoActions.details(id, { after_date: '', after_id: '' })}
              />
            </>
          )}
        </div>
      </div>

      <StreakSheet
        streak={openStreak}
        open={!!openStreak}
        onClose={() => setStreakKey(null)}
        onSaveNotes={streakActions.saveNotes}
        onRemove={streakActions.remove}
      />

      <TodoFormSheet
        mode={selected ? 'edit' : 'add'}
        open={!!selected || !!addDraft}
        item={selected}
        currentSection={formCurrentSection}
        prefill={formPrefill}
        serverDate={serverDate}
        todoIndex={todoIndex}
        candidates={blockerCandidates}
        fronts={fronts}
        actions={todoActions}
        onClose={() => {
          setSelected(null);
          setAddDraft(null);
        }}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* Legacy iframe tabs still get this from static/js/notes-pill.js;
          the native /todos page needs its own mount. Public mode never
          reaches this page, but the guard is cheap insurance. */}
      {!isPublic ? <NotesPill onError={push} /> : null}
    </div>
  );
}
