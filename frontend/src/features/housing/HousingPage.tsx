import { useEffect, useMemo, useRef, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { AddPlaceForm } from './AddPlaceForm';
import { HousingNotes } from './HousingNotes';
import { PlaceCard } from './PlaceCard';
import { sortEntriesForDisplay } from './statusLadder';
import type { HousingEntry } from './types';
import { useHousingActions, useHousingData, useToasts } from './useHousingData';
import styles from './HousingPage.module.css';

const UNDO_DELETE_MS = 5000;

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

/**
 * Housing tab — apartment-search tracker. Port of templates/index.html
 * #tab-housing + static/js/housing.js: criteria/plan notes box, collapsed
 * add-a-place form, and place cards sorted by the status ladder.
 *
 * Deletes are two-step on the card ("Sure?"), then the card hides
 * immediately behind a "Removed · Undo" toast; the server call only fires
 * once the undo window lapses (journal's pattern — the old page used the
 * global confirm modal instead).
 */
export function HousingPage() {
  const { data, isLoading, isError, error } = useHousingData();
  const { toasts, push, dismiss } = useToasts();
  const actions = useHousingActions(push);
  const isPublic = isPublicMode();

  // Cards mid "Removed · Undo" toast — hidden from the list immediately but
  // not deleted server-side until the toast's timer fires (or the page
  // unmounts). Undo just clears the pending id.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const deleteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  function requestDelete(entry: HousingEntry) {
    setPendingDeleteIds((cur) => new Set(cur).add(entry.id));
    deleteTimers.current[entry.id] = setTimeout(() => finalizeDelete(entry.id), UNDO_DELETE_MS);
    push(`Removed "${entry.name}"`, {
      tone: 'info',
      actionLabel: 'Undo',
      onAction: () => cancelPendingDelete(entry.id),
      duration: UNDO_DELETE_MS,
    });
  }

  function finalizeDelete(id: string) {
    delete deleteTimers.current[id];
    setPendingDeleteIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    actionsRef.current.remove(id);
  }

  function cancelPendingDelete(id: string) {
    const timer = deleteTimers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete deleteTimers.current[id];
    }
    setPendingDeleteIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  }

  // Navigating away — commit any still-pending deletes rather than silently
  // dropping them; the undo window only makes sense while the toast shows.
  useEffect(() => {
    return () => {
      for (const id of Object.keys(deleteTimers.current)) finalizeDelete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const housing = data?.housing;
  const entries = useMemo(
    () => sortEntriesForDisplay(housing?.entries ?? []).filter((e) => !pendingDeleteIds.has(e.id)),
    [housing?.entries, pendingDeleteIds],
  );

  return (
    <div className={styles.page}>
      <div className={styles.sectionTitle}>Housing</div>
      <div className={styles.subtitle}>
        Apartment search &mdash; places, status, and what matters. Move target: late July.
      </div>

      {isLoading ? (
        <div className={styles.loading}>Loading&hellip;</div>
      ) : isError ? (
        <div className={styles.error}>
          Couldn&rsquo;t load housing data{error instanceof Error ? ` — ${error.message}` : ''}.
        </div>
      ) : (
        <>
          <HousingNotes notes={housing?.notes ?? ''} />
          <AddPlaceForm onAdd={actions.add} />
          {entries.length === 0 ? (
            <div className={styles.empty}>No places yet &mdash; tap &ldquo;Add a place&rdquo; above.</div>
          ) : (
            entries.map((e) => (
              <PlaceCard
                key={e.id}
                entry={e}
                onSetStatus={actions.setStatus}
                onSaveEdit={actions.saveEdit}
                onDelete={requestDelete}
              />
            ))
          )}
        </>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
      {!isPublic ? <NotesPill onError={push} tab="housing" /> : null}
    </div>
  );
}
