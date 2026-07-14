import { useCallback, useMemo, useState } from 'react';
import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { ConfirmModal } from './ConfirmModal';
import { MediaCard } from './MediaCard';
import { MediaFilterBar } from './MediaFilterBar';
import { MediaForm } from './MediaForm';
import { visibleMediaItems } from './mediaHelpers';
import type { MediaFilterState, MediaItem } from './types';
import { useMediaActions, useMediaData, useMediaToasts } from './useMediaData';
import styles from './MediaPage.module.css';

/** Session-persistent UI state. The old page kept these on `window`
 * (window._mediaFilter / window._mediaCompose) so they survived re-renders
 * and tab switches within a page load; module scope is the SPA analogue —
 * survives route unmount/remount, resets on full reload. Deliberately not
 * localStorage: the old code never persisted them across reloads. */
const session: { filter: MediaFilterState; composeType: string; composing: boolean } = {
  filter: { type: 'all', sort: 'date', query: '' },
  composeType: 'book',
  // Compose form hidden until asked for — the collection is the page's
  // content; a permanently-open blank form pushed it below the fold.
  composing: false,
};

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

/**
 * MEDIA tab — a backlog of books/movies/shows recommended to her. React port
 * of templates/index.html #tab-media + static/js/media.js: compose card,
 * filter bar (search / sort / data-driven type chips), entry cards with
 * inline editing, mark-done checkbox, and confirm-then-remove (now with an
 * Undo toast).
 */
export function MediaPage() {
  const { data, isLoading, isError, error } = useMediaData();
  const { toasts, push, dismiss } = useMediaToasts();
  const onError = useCallback((message: string) => push(message), [push]);
  const actions = useMediaActions(onError);
  const isPublic = isPublicMode();

  const [filter, setFilterState] = useState<MediaFilterState>(session.filter);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<MediaItem | null>(null);
  const [composing, setComposingState] = useState(session.composing);

  function setFilter(next: MediaFilterState) {
    session.filter = next;
    setFilterState(next);
  }

  function setComposing(next: boolean) {
    session.composing = next;
    setComposingState(next);
  }

  const items = useMemo(() => data?.media?.items || [], [data]);
  const visible = useMemo(() => visibleMediaItems(items, filter), [items, filter]);

  function confirmRemove() {
    if (!pendingRemove) return;
    const item = pendingRemove;
    setPendingRemove(null);
    if (editingId === item.id) setEditingId(null);
    actions.remove(item.id);
    push({
      message: `Removed “${item.title}”`,
      tone: 'info',
      actionLabel: 'Undo',
      onAction: () =>
        actions.add({
          title: item.title,
          type: item.type,
          author: item.author || '',
          recommended_by: item.recommended_by || '',
          date: item.date || '',
          notes: item.notes || '',
          done: !!item.done,
        }),
    });
  }

  // Error page only when there's nothing to show — a failed background poll
  // must not blank a working page while cached data exists.
  if (isError && !data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading&hellip;</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <div className={styles.sectionTitle}>Media</div>
        {!isPublic ? (
          <button
            type="button"
            className={`${styles.addBtn} ${composing ? styles.addBtnActive : ''}`}
            onClick={() => setComposing(!composing)}
          >
            {composing ? 'Close' : '+ Add'}
          </button>
        ) : null}
      </div>
      <div className={styles.subtitle}>
        Books, movies, shows recommended to you. Log it, jot why, check it off when you&rsquo;ve
        read or watched it.
      </div>

      {composing ? (
        <MediaForm
          variant="compose"
          initialType={session.composeType}
          onTypeChange={(t) => {
            session.composeType = t;
          }}
          onSubmit={(fields) => {
            actions.add(fields);
            setComposing(false);
          }}
          onInvalid={onError}
        />
      ) : null}

      <MediaFilterBar items={items} filter={filter} onChange={setFilter} />

      {items.length === 0 ? (
        <div className={styles.empty}>Nothing logged yet. Tap + Add to log the first recommendation.</div>
      ) : visible.length === 0 ? (
        <div className={styles.empty}>No matches for the current filter/search.</div>
      ) : (
        visible.map((it) =>
          editingId === it.id ? (
            <MediaForm
              key={`edit-${it.id}`}
              variant="edit"
              initial={it}
              onSubmit={(fields) => {
                actions.update({ id: it.id, ...fields });
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
              onInvalid={onError}
            />
          ) : (
            <MediaCard
              key={it.id}
              item={it}
              onToggleDone={actions.toggleDone}
              onEdit={setEditingId}
              onRemove={setPendingRemove}
            />
          ),
        )
      )}

      <ConfirmModal
        open={!!pendingRemove}
        onConfirm={confirmRemove}
        onCancel={() => setPendingRemove(null)}
      >
        Remove <b>{pendingRemove?.title}</b>?
      </ConfirmModal>

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* Floating dev/idea notes pill acting on this tab's notes. */}
      {!isPublic ? <NotesPill tab="media" onError={onError} /> : null}
    </div>
  );
}
