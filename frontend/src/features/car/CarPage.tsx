import { useEffect, useMemo, useRef, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { useToasts } from '../journal/useJournalData';
import { removeCarEntry } from './api';
import { localTodayISO } from './carMath';
import { CarAddForm } from './CarAddForm';
import { CarLogTable } from './CarLogTable';
import { CarNotesCard } from './CarNotesCard';
import type { CarEntry } from './types';
import { useCarActions, useCarData } from './useCarData';
import styles from './CarPage.module.css';

/**
 * /car — native port of the legacy Car Maintenance tab (templates/index.html
 * #tab-car + static/js/car.js): notepad card, "Log maintenance" add form
 * (with custom types), and the due-soon-sorted log table. Deletes follow the
 * React-port convention: two-step "Sure?" on the row, then the row hides
 * behind a 5s "Entry removed · Undo" toast before the API call fires
 * (JournalPage's pending-delete pattern).
 *
 * Not ported (known gaps, same as other native pages): the "To-dos for this
 * page" strip (part of the todos-feature gap in MIGRATION_NOTES.md) and the
 * pending-approvals modal (skipped deliberately — no React approvals UI yet).
 */

const UNDO_DELETE_MS = 5000;

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

export function CarPage() {
  const { data, isLoading, isError, error } = useCarData();
  const { toasts, push, dismiss } = useToasts();
  const actions = useCarActions(push);
  const isPublic = isPublicMode();

  const [pendingDeleteIds, setPendingDeleteIds] = useState<ReadonlySet<string>>(() => new Set());
  const deleteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // If the page unmounts mid-undo-window, commit the deletes right away —
  // she asked for them, and losing the timer must not resurrect the rows.
  useEffect(() => {
    const timers = deleteTimers.current;
    return () => {
      for (const [id, timer] of Object.entries(timers)) {
        clearTimeout(timer);
        void removeCarEntry(id);
      }
    };
  }, []);

  function finalizeDelete(id: string) {
    delete deleteTimers.current[id];
    setPendingDeleteIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    actions.remove(id);
  }

  function cancelPendingDelete(id: string) {
    const timer = deleteTimers.current[id];
    if (timer) clearTimeout(timer);
    delete deleteTimers.current[id];
    setPendingDeleteIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  }

  function requestDelete(id: string) {
    setPendingDeleteIds((cur) => new Set(cur).add(id));
    deleteTimers.current[id] = setTimeout(() => finalizeDelete(id), UNDO_DELETE_MS);
    push('Entry removed', {
      tone: 'info',
      actionLabel: 'Undo',
      onAction: () => cancelPendingDelete(id),
      duration: UNDO_DELETE_MS,
    });
  }

  const allEntries: CarEntry[] = useMemo(
    () => (Array.isArray(data?.car_maintenance?.entries) ? data.car_maintenance.entries : []),
    [data],
  );
  const entries = useMemo(
    () => allEntries.filter((e) => !pendingDeleteIds.has(e.id)),
    [allEntries, pendingDeleteIds],
  );

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

  const serverText = typeof data.car_notes?.text === 'string' ? data.car_notes.text : '';
  const today = data.server_date || localTodayISO();

  return (
    <div className={styles.page}>
      <div className={styles.sectionTitle}>Car Maintenance</div>
      <div className={styles.subtitle}>Log oil changes, brakes, registration, anything.</div>

      <CarNotesCard serverText={serverText} />
      <CarAddForm today={today} onAdd={actions.add} />
      <CarLogTable entries={entries} today={localTodayISO()} onRemove={requestDelete} />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* Floating dev/idea notes pill, capturing onto the 'car' tab — same
          mount every native page carries (legacy iframes get notes-pill.js). */}
      {!isPublic ? <NotesPill tab="car" onError={push} /> : null}
    </div>
  );
}
