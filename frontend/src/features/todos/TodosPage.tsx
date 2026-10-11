import { Link, useNavigate, useSearch } from '@tanstack/react-router';
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
import { TodoFormSheet } from './TodoFormSheet';
import { TodoSection } from './TodoSection';
import { TomorrowCard } from './TomorrowCard';
import { ComingUpCard } from './ComingUpCard';
import { WaitingCard } from './WaitingCard';
import {
  LADDER_LABELS,
  focusMatchAny,
  selectedFocusCount,
  buildTodoIndex,
  collectSnoozed,
  collectTomorrow,
  collectUpNow,
  collectWaiting,
  computeFocusCounts,
  gateHides,
  visibleSectionItems,
  withFocusFront,
} from './todoHelpers';
import type { AddTodoPayload } from '../../api/endpoints';
import { openTriage } from '../../api/endpoints';
import { isFrosted } from './types';
import type { TodoItem } from './types';
import {
  useGrowthActions,
  useHabitActions,
  useStreakActions,
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

/**
 * The saved selection. It's a JSON list now that several fronts can be on at
 * once, but the key held a BARE FRONT ID for as long as the filter was
 * single-select — so anything that doesn't parse as a list is read as that one
 * front and wrapped, and whoever had a filter saved keeps it.
 */
function readStoredFocus(): string[] {
  try {
    const raw = localStorage.getItem(FOCUS_STORAGE_KEY);
    if (!raw) return [];
    if (raw.startsWith('[')) {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string' && !!f) : [];
    }
    return [raw];
  } catch {
    return [];
  }
}

function writeStoredFocus(selected: string[]) {
  try {
    localStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(selected));
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
  const isPublic = isPublicMode();

  const [focusFronts, setFocusFrontsState] = useState<string[]>(readStoredFocus);
  // Desktop breathing room: collapse the habits column so To Do spans the
  // whole pane. Never offered to public visitors — habits are their view.
  const [habitsHidden, setHabitsHiddenState] = useState(readStoredHabitsHidden);
  // Context gates off — everything shows. Deliberately NOT persisted: a
  // fresh visit always starts back in the auto (gated) view.
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<TodoItem | null>(null);
  // Sheet state holds the streak's stable id; the open streak re-derives from
  // the polled data so "Day N" stays live while it's open. Seeded from the
  // ?streak=<slug> search param (the journal's counter chip deep-link).
  const [streakId, setStreakId] = useState<string | null>(null);
  const streakParam = useSearch({ from: '/todos', select: (s: { streak?: string }) => s.streak });
  const navigate = useNavigate();
  // 🧭 Triage: one tap mints (or rejoins) the Reading Room session that
  // reorders the list by conversation, then lands on it. The server rejoins
  // by slug, so a double-tap can't open two; `triageOpening` just keeps the
  // button honest while the mint runs (~1s).
  const [triageOpening, setTriageOpening] = useState(false);
  const openTriageSession = async () => {
    setTriageOpening(true);
    try {
      const { conversation_id } = await openTriage();
      void navigate({ to: '/observatory/$botId', params: { botId: 'session' }, search: { conv: conversation_id } });
    } catch (e) {
      push(e instanceof Error ? e.message : 'Could not open Triage');
    } finally {
      setTriageOpening(false);
    }
  };
  useEffect(() => {
    const list = data?.streaks;
    if (!streakParam || !Array.isArray(list)) return;
    const hit = list.find((s) => s.slug === streakParam);
    if (hit) setStreakId(hit.id);
    // One-shot: consume the param so back/refresh don't re-open the sheet.
    void navigate({ to: '/todos', search: {}, replace: true });
  }, [streakParam, data, navigate]);
  // ?front=<id> — the Fronts overview's deep link. REPLACES the selection with
  // that one front rather than adding to it: one tile was tapped, so one front
  // is what was asked for. setFocusFronts persists it, so it survives the nav.
  // Then it consumes the param, same one-shot shape as ?streak= above, clearing
  // only `front` so it doesn't stomp a ?streak= arriving in the same URL.
  const frontParam = useSearch({ from: '/todos', select: (s: { front?: string }) => s.front });
  useEffect(() => {
    if (!frontParam) return;
    setFocusFronts([frontParam]);
    void navigate({
      to: '/todos',
      search: (prev: { streak?: string; front?: string }) => ({ ...prev, front: undefined }),
      replace: true,
    });
    // One-shot on the param itself; setFocusFronts is a stable local closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontParam, navigate]);
  // Staged prefill for the "+ add" flow — set by a section header's "+ add"
  // button or AddBar's expand-to-full-editor icon; null = the add form is
  // closed. `text`/`due_by` mirror whatever the launch point already had
  // typed/picked so it isn't lost when the form takes over.
  const [addDraft, setAddDraft] = useState<{ section: string; text?: string; due_by?: string } | null>(null);
  // Controls both the greeting text and which habit cards show — mirrors the
  // old page's single `selectedTime` global (core.js getTime()).
  const [manualSegment, setManualSegment] = useState<TimeSegment | null>(null);

  function setFocusFronts(next: string[]) {
    setFocusFrontsState(next);
    writeStoredFocus(next);
  }

  /** Flip one chip. Order is kept as tapped, so the strip's mount-scroll
   * anchors on the front she reached for first. */
  function toggleFocusFront(front: string) {
    setFocusFronts(
      focusFronts.includes(front) ? focusFronts.filter((f) => f !== front) : [...focusFronts, front],
    );
  }

  function setHabitsHidden(hidden: boolean) {
    setHabitsHiddenState(hidden);
    writeStoredHabitsHidden(hidden);
  }

  // Both add paths (quick-add bar, per-section "+ add" sheet) stamp the whole
  // active selection, so the new item stays visible under the filter — and
  // lands on several fronts when several are selected, which the item shape
  // has always allowed.
  function addTodo(payload: AddTodoPayload) {
    todoActions.add(withFocusFront(payload, focusFronts));
  }

  const frosted = data ? isFrosted(data.todos) : false;
  const serverDate = data?.server_date || '';
  const sections = useMemo(
    () => (data && !frosted && Array.isArray(data.todos) ? data.todos : []),
    [data, frosted],
  );

  const ladderSections = useMemo(() => sections.filter((s) => LADDER_LABELS.includes(s.name as (typeof LADDER_LABELS)[number])), [sections]);
  const todoIndex = useMemo(() => buildTodoIndex(sections), [sections]);
  // "Do after" blocker candidates: not-done ladder items, offered in the
  // detail/add sheets' blocker picker.
  const blockerCandidates = useMemo(
    () => ladderSections.flatMap((s) => s.items).filter((it) => !it.done),
    [ladderSections],
  );
  const snoozedAll = useMemo(() => collectSnoozed(sections, serverDate), [sections, serverDate]);
  const snoozed = useMemo(
    () => snoozedAll.filter((it) => focusMatchAny(it, focusFronts)),
    [snoozedAll, focusFronts],
  );
  const waitingAll = useMemo(() => collectWaiting(sections, serverDate), [sections, serverDate]);
  const waiting = useMemo(
    () => waitingAll.filter((w) => focusMatchAny(w.item, focusFronts)),
    [waitingAll, focusFronts],
  );
  const focusCounts = useMemo(() => computeFocusCounts(sections, serverDate), [sections, serverDate]);
  // "The selection is showing nothing", which is not the same as "the list is
  // empty" — the ladder hides behind a single line in that case (see below).
  const emptySelection =
    focusFronts.length > 0 && selectedFocusCount(sections, serverDate, focusFronts) === 0;

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
      const base = visibleSectionItems(s, serverDate, focusFronts, todoIndex, showAll);
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
  }, [ladderSections, serverDate, focusFronts, todoIndex, gateRules, hhmm, showAll]);

  const upNow = useMemo(
    () => collectUpNow(sections, serverDate).filter((it) => focusMatchAny(it, focusFronts)),
    [sections, serverDate, focusFronts],
  );

  const tomorrowItems = useMemo(
    () => collectTomorrow(sections, serverDate).filter((it) => focusMatchAny(it, focusFronts)),
    [sections, serverDate, focusFronts],
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
  // selected fronts ride along as prefilled (deselectable) chips — the same
  // set withFocusFront would stamp onto the AddBar's own quick path.
  const formCurrentSection = currentSection ?? addDraft?.section ?? null;
  const prefillFronts = focusFronts.filter((f) => f !== '__none__');
  const formPrefill = addDraft
    ? {
        text: addDraft.text,
        dueBy: addDraft.due_by,
        fronts: prefillFronts.length ? prefillFronts : undefined,
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
  const openStreak = streakId ? streaks.find((s) => s.id === streakId) || null : null;

  return (
    <div className={styles.page}>
      {/* Hidden while "Show all" is on — its items are inline in the ladder. */}
      {!showAll ? (
        <SnoozedCard items={snoozed} totalCount={snoozedAll.length} onUnsnooze={(id) => todoActions.snooze(id, 0)} />
      ) : null}

      {!isPublic ? (
        <>
          <div className={styles.greetingRow}>
            <span className={styles.greeting}>{GREETINGS[clockSegment]}</span>
            <span className={styles.greetingDot} aria-hidden="true">&middot;</span>
            <span className={styles.dateLine}>{data.date}</span>
          </div>
          {/* TODO(habits phase 2): "Show hidden prompts" expand-all toggle
              lived here (old #expand-btn next to date-text). */}
          <StreaksRow
            streaks={streaks}
            onOpen={(s) => setStreakId(s.id)}
            onAdd={Array.isArray(data.streaks) ? streakActions.add : undefined}
          />
          {/* The fronts filter sits HERE, above every to-do surface it
              governs, and sticks to the top as the page scrolls. It used to
              render inside the To Do column further down — the filtering
              already reached Up now, Tomorrow, Snoozed and Waiting, but the
              control for it sat below all of them, so using it meant scrolling
              to the bottom of the page to change what the top showed.
              Deliberately below StreaksRow: counters aren't front-tagged and
              don't respond to it.
              (Prompt: "on my dashboard, the fronts are scrollable to filter
              the entire page's to-dos including the up now page to just that
              front.") */}
          {!frosted ? (
            <FocusChips
              counts={focusCounts}
              selected={focusFronts}
              fronts={fronts}
              onToggle={toggleFocusFront}
              onClear={() => setFocusFronts([])}
            />
          ) : null}
          {/* The one attention surface: due reminders (formerly the push-
              notification banners — merged 2026-07-20, replacing ReminderCard)
              + overdue/due-today to-dos, with the Tomorrow look-ahead under
              it. Kept below the greeting per dev note 3c3a4dd3.
              NOTE: `reminders` is passed unfiltered — a ReminderDef carries no
              `fronts` field, so recurring reminders stay visible under every
              front. To-dos in this card do follow the filter. */}
          <UpNowCard
            items={upNow}
            reminders={data.reminders || []}
            activityLog={data.activity_log || []}
            serverDate={serverDate}
            timeOfDay={data.time_of_day}
            onToggle={todoActions.toggle}
            onSubtaskToggle={todoActions.subtaskToggle}
            onOpenDetail={setSelected}
            onLog={reminderActions.log}
            onUndo={reminderActions.undo}
            onSnooze={reminderActions.snooze}
            onUpdateReminder={(id, patch) => reminderActions.update(id, patch, data.reminders || [])}
          />
          <TomorrowCard
            items={tomorrowItems}
            onToggle={todoActions.toggle}
            onOpenDetail={setSelected}
          />
          {/* Dated events and topics the Keeper wakes knowing about, and the
              timed System reminders it gets sent (ComingUpCard.tsx). */}
          <ComingUpCard />
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
                    data-track="todo-habits-toggle"
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
                    data-track="todo-show-all"
                  >
                    {showAll ? '✓ Showing all' : '👁 Show all'}
                  </button>
                ) : null}
                <Link to="/todos/editor" className={styles.editorLink} data-track="todo-edit-all">
                  &#9998; Edit all
                </Link>
                <button
                  type="button"
                  className={styles.headerBtn}
                  disabled={triageOpening}
                  onClick={() => void openTriageSession()}
                  title="Talk through your day with Triage — it reorders the list as you chat"
                  data-track="todo-triage-open"
                >
                  {triageOpening ? '🧭 Opening…' : '🧭 Triage'}
                </button>
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
              <AddBar
                onAdd={addTodo}
                onExpand={(pre) => setAddDraft(pre)}
                focusFronts={focusFronts}
                fronts={fronts}
              />

              {/* The SELECTION's own count, not the page total — with the page
                  total this only ever fired when the whole list was empty, so
                  filtering to a front and clearing it rendered four empty
                  section headers instead of this line. */}
              {emptySelection ? (
                <div className={styles.emptyFocus}>Nothing here right now. 🎉</div>
              ) : null}

              {/* Hide the ladder, don't unmount it. Each section holds its own
                  open/closed state, so swapping these cards out for the line
                  above threw that state away — clearing the filter came back to
                  four collapsed sections, header counts full and no rows under
                  them. Hidden, they keep that state (and still see the filter
                  change, so they re-open when their items come back). */}
              <div style={{ display: emptySelection ? 'none' : undefined }}>
                {ladderSections.map((section, i) => (
                  <TodoSection
                    key={section.name}
                    label={section.name}
                    colorIndex={i}
                    items={gatedBySection.shown.get(section.name) || []}
                    totalCount={
                      // Everything alive in the bucket — waiting/snoozed
                      // included, so "5/7" says two exist elsewhere. Under
                      // "Show all" they return inline and the numbers meet.
                      section.items.filter((it) => !it.done).length
                    }
                    manualOrder={section.manual_order}
                    serverDate={serverDate}
                    fronts={fronts}
                    defaultOpen={section.name === 'Now'}
                    focusFronts={focusFronts}
                    onToggle={todoActions.toggle}
                    onOpenDetail={setSelected}
                    onSubtaskToggle={todoActions.subtaskToggle}
                    onReorder={todoActions.reorder}
                    onAutosort={todoActions.autosort}
                    onMove={todoActions.move}
                    onAddClick={(label) => setAddDraft({ section: label })}
                  />
                ))}
              </div>

              <NotNowCard entries={gatedBySection.notNow} fronts={fronts} onOpenDetail={setSelected} />

              {/* Waiting lives at the very bottom, below Done — it's the
                  "not actionable yet" tail of the column, not a headline
                  (used to render at the very top of the page). */}
              {/* Hidden while "Show all" is on — its items are inline above. */}
              {!showAll ? (
                <WaitingCard
                  entries={waiting}
                  totalCount={waitingAll.length}
                  onClear={(id) => todoActions.details(id, { after_date: '', after_id: '' })}
                />
              ) : null}
            </>
          )}
        </div>
      </div>

      <StreakSheet
        streak={openStreak}
        open={!!openStreak}
        onClose={() => setStreakId(null)}
        actions={streakActions}
        habits={habits}
        habitsLog={habitsLog}
        serverDate={serverDate}
        onError={push}
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
