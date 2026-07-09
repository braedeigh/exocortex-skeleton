import { useMemo, useRef, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../todos/useTodayData';
import { ComposeCell } from './ComposeCell';
import { ConfirmModal } from './ConfirmModal';
import { DeitiesView } from './DeitiesView';
import { EntryCell } from './EntryCell';
import {
  MED_TYPE_LABELS,
  collectCustomTypes,
  entryTagSummary,
  medSlug,
  sortEntries,
} from './practiceHelpers';
import { TimerCard } from './TimerCard';
import type { MeditationEntry } from './types';
import { useMeditationData, usePracticeActions } from './useMeditationData';
import styles from './MeditationPage.module.css';

const VIEW_STORAGE_KEY = 'med_view'; // same key as the old setMedView()
type MedView = 'practice' | 'deities';

function readStoredView(): MedView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'deities' ? 'deities' : 'practice';
  } catch {
    return 'practice';
  }
}

function localToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

/**
 * The Meditation tab — React port of templates/index.html #tab-meditation +
 * static/js/meditation.js. Practice/Deities subnav (persisted under the old
 * 'med_view' localStorage key), a compose cell + optional timer feeding a
 * stream of dated, multi-tagged cells, and the deity-profiles sub-app.
 */
export function MeditationPage() {
  const { data, isLoading, isError, error } = useMeditationData();
  const { toasts, push, dismiss } = useToasts();
  const practice = usePracticeActions(push);

  const [view, setViewState] = useState<MedView>(readStoredView);

  // Compose state lives here (the old window._medCompose survived re-renders
  // the same way) so TimerCard's Stop can prefill tag + duration.
  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [sessionCustomTypes, setSessionCustomTypes] = useState<string[]>([]);
  const [composeDate, setComposeDate] = useState(''); // '' = default to today
  const [composeDuration, setComposeDuration] = useState('');
  const [composeNotes, setComposeNotes] = useState('');
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const [pendingRemove, setPendingRemove] = useState<MeditationEntry | null>(null);

  const entries = useMemo(() => data?.meditation_log?.entries || [], [data]);
  const profiles = data?.deity_profiles?.profiles || [];
  const sorted = useMemo(() => sortEntries(entries), [entries]);
  const customTypes = useMemo(
    () => collectCustomTypes(entries, sessionCustomTypes),
    [entries, sessionCustomTypes],
  );

  const isPublic = isPublicMode();
  const todayStr = data?.server_date || localToday();

  function setView(v: MedView) {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      // localStorage unavailable — subnav choice just won't persist
    }
  }

  function toggleType(t: string) {
    setSelectedTypes((cur) => {
      const next = new Set(cur);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function addCustomType(raw: string) {
    const slug = medSlug(raw);
    if (!slug) return;
    setSessionCustomTypes((cur) => (cur.includes(slug) ? cur : [...cur, slug]));
    setSelectedTypes((cur) => new Set(cur).add(slug));
  }

  function handleTimerStop(type: string, durationMin: number) {
    setSelectedTypes(new Set([type]));
    if (!MED_TYPE_LABELS[type]) {
      setSessionCustomTypes((cur) => (cur.includes(type) ? cur : [...cur, type]));
    }
    setComposeDuration(String(durationMin));
    // Focus after the compose cell re-renders with the prefill.
    requestAnimationFrame(() => notesRef.current?.focus());
  }

  function saveCompose() {
    const types = Array.from(selectedTypes);
    const notes = composeNotes.trim();
    if (!types.length && !notes) return; // need at least one tag or some text
    practice.add({
      types,
      date: composeDate || todayStr,
      duration_min: composeDuration ? Number(composeDuration) : null,
      notes,
    });
    // The old page cleared the whole form via re-render after a save.
    setSelectedTypes(new Set());
    setComposeNotes('');
    setComposeDuration('');
    setComposeDate('');
  }

  function clearCompose() {
    // _medClearCompose reset tags/notes/duration but left the date alone.
    setSelectedTypes(new Set());
    setComposeNotes('');
    setComposeDuration('');
  }

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading&hellip;</div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.sectionTitle}>Meditation</div>

      <div className={styles.subnav} role="tablist" aria-label="Meditation views">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'practice'}
          className={`${styles.subtab} ${view === 'practice' ? styles.subtabActive : ''}`}
          onClick={() => setView('practice')}
        >
          Practice
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'deities'}
          className={`${styles.subtab} ${view === 'deities' ? styles.subtabActive : ''}`}
          onClick={() => setView('deities')}
        >
          Deities
        </button>
      </div>

      {view === 'practice' ? (
        <>
          <div className={styles.hint}>
            A stream of dated cells. Tag each with the kind of practice, optionally log duration.
          </div>
          <TimerCard onStop={handleTimerStop} />
          <ComposeCell
            ref={notesRef}
            date={composeDate}
            todayStr={todayStr}
            duration={composeDuration}
            notes={composeNotes}
            selectedTypes={selectedTypes as Set<string>}
            customTypes={customTypes}
            onDateChange={setComposeDate}
            onDurationChange={setComposeDuration}
            onNotesChange={setComposeNotes}
            onToggleType={toggleType}
            onAddCustomType={addCustomType}
            onSave={saveCompose}
            onClear={clearCompose}
          />
          {sorted.length === 0 ? (
            <div className={styles.emptyStream}>No cells yet. Write one above, or start a timer.</div>
          ) : (
            sorted.map((e) => <EntryCell key={e.id} entry={e} onRemove={setPendingRemove} />)
          )}
        </>
      ) : (
        <DeitiesView profiles={profiles} onError={push} />
      )}

      <ConfirmModal
        open={!!pendingRemove}
        text={
          pendingRemove ? (
            <>
              Remove the <b>{entryTagSummary(pendingRemove)}</b> cell?
            </>
          ) : null
        }
        onConfirm={() => {
          if (pendingRemove) practice.remove(pendingRemove.id);
          setPendingRemove(null);
        }}
        onCancel={() => setPendingRemove(null)}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* Floating dev/idea notes pill, scoped to this tab's notes. */}
      {!isPublic ? <NotesPill tab="meditation" onError={push} /> : null}
    </div>
  );
}
