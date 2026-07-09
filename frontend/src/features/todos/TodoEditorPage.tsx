import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { ToastStack } from '../../ui';
import { BulkActionBar } from './BulkActionBar';
import { BulkSheet } from './BulkSheet';
import type { BulkSheetMode } from './BulkSheet';
import { DetailSheet } from './DetailSheet';
import { EditorRow } from './EditorRow';
import { filterEditorTodos, flattenAllTodos } from './editorHelpers';
import {
  DONE_LABEL,
  LADDER_LABELS,
  TODO_CATEGORIES,
  TODO_STATUSES,
  TODO_THEMES,
  buildTodoIndex,
} from './todoHelpers';
import { isFrosted } from './types';
import type { TodoItem } from './types';
import { useTodayData, useTodoActions, useToasts } from './useTodayData';
import type { BulkTodoAction } from '../../api/endpoints';
import styles from './TodoEditorPage.module.css';

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

/**
 * /todos/editor — the full-page to-do manager: every to-do across every
 * section (snoozed/waiting included, badged instead of hidden) in one
 * searchable, filterable list, with a select mode for bulk snooze / tag /
 * move / delete. Per-item editing reuses DetailSheet unchanged; the list
 * shares TODAY_QUERY_KEY with /todos so edits show instantly back there.
 */
export function TodoEditorPage() {
  const isPublic = isPublicMode();

  // Hooks run unconditionally (Rules of Hooks) regardless of public mode.
  const { data, isLoading, isError, error } = useTodayData();
  const { toasts, push, dismiss } = useToasts();
  const todoActions = useTodoActions(push);

  const [search, setSearch] = useState('');
  const [sectionFilter, setSectionFilter] = useState('');
  const [themeFilter, setThemeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sheetMode, setSheetMode] = useState<BulkSheetMode | null>(null);
  const [selected, setSelected] = useState<TodoItem | null>(null);

  const frosted = data ? isFrosted(data.todos) : false;
  const serverDate = data?.server_date || '';
  const sections = useMemo(
    () => (data && !frosted && Array.isArray(data.todos) ? data.todos : []),
    [data, frosted],
  );

  const entries = useMemo(() => flattenAllTodos(sections, serverDate), [sections, serverDate]);
  const filtered = useMemo(
    () =>
      filterEditorTodos(entries, {
        section: sectionFilter,
        search,
        theme: themeFilter,
        category: categoryFilter,
        status: statusFilter,
      }),
    [entries, sectionFilter, search, themeFilter, categoryFilter, statusFilter],
  );

  const todoIndex = useMemo(() => buildTodoIndex(sections), [sections]);
  const blockerCandidates = useMemo(
    () =>
      sections
        .filter((s) => (LADDER_LABELS as readonly string[]).includes(s.name))
        .flatMap((s) => s.items)
        .filter((it) => !it.done),
    [sections],
  );

  const currentSection = useMemo(() => {
    if (!selected) return null;
    for (const s of sections) {
      if (s.items.some((it) => it.id === selected.id)) return s.name;
    }
    return null;
  }, [selected, sections]);

  // Same re-derive-from-poll effect as TodosPage: keep the open DetailSheet's
  // item fresh as the 5s poll lands, and close it if the item vanished.
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

  // Prune selection of ids that vanished from the polled data (item finished
  // or deleted elsewhere between poll and tap).
  useEffect(() => {
    setSelectedIds((cur) => {
      if (cur.size === 0) return cur;
      const next = new Set(Array.from(cur).filter((id) => todoIndex.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [todoIndex]);

  if (isPublic) {
    return (
      <div className={styles.page}>
        <div className={styles.publicStub}>The to-do editor isn&rsquo;t available here.</div>
      </div>
    );
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

  function toggleSelecting() {
    setSelecting((cur) => {
      if (cur) setSelectedIds(new Set());
      return !cur;
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // After any bulk action: clear the selection but STAY in select mode, so
  // sweeping through several batches doesn't need re-entering the mode.
  function runBulk(action: BulkTodoAction) {
    todoActions.bulk(Array.from(selectedIds), action);
    setSelectedIds(new Set());
    setSheetMode(null);
  }

  const sectionChips: Array<{ key: string; label: string }> = [
    { key: '', label: 'All' },
    ...LADDER_LABELS.map((label) => ({ key: label as string, label: label as string })),
    { key: DONE_LABEL, label: DONE_LABEL },
  ];

  return (
    <div className={`${styles.page} ${selecting ? styles.pageSelecting : ''}`}>
      <div className={styles.header}>
        <Link to="/todos" className={styles.backLink}>
          &#8249; To-dos
        </Link>
        <h1 className={styles.title}>Edit</h1>
        <span className={styles.count}>{filtered.length}</span>
        <button
          type="button"
          className={`${styles.selectToggle} ${selecting ? styles.selectToggleActive : ''}`}
          onClick={toggleSelecting}
        >
          {selecting ? 'Done' : 'Select'}
        </button>
      </div>

      <input
        className={styles.search}
        type="text"
        placeholder="Search to-dos&hellip;"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search to-dos"
      />

      <div className={styles.chips}>
        {sectionChips.map((c) => (
          <button
            key={c.key || 'all'}
            type="button"
            className={`${styles.chip} ${sectionFilter === c.key ? styles.chipActive : ''}`}
            onClick={() => setSectionFilter(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className={styles.selects}>
        <select
          className={styles.select}
          value={themeFilter}
          onChange={(e) => setThemeFilter(e.target.value)}
          aria-label="Filter by focus"
        >
          <option value="">Focus: any</option>
          {TODO_THEMES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.emoji} {t.label}
            </option>
          ))}
          <option value="__none__">&#127991;&#65039; Other</option>
        </select>
        <select
          className={styles.select}
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">Category: any</option>
          {TODO_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">Status: any</option>
          {TODO_STATUSES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No to-dos match.</div>
      ) : (
        <div className={styles.list}>
          {filtered.map((e) => (
            <EditorRow
              key={e.item.id}
              item={e.item}
              section={e.section}
              serverDate={serverDate}
              snoozed={e.snoozed}
              waiting={e.waiting}
              selecting={selecting}
              selected={selectedIds.has(e.item.id)}
              onToggleDone={todoActions.toggle}
              onToggleSelect={toggleSelected}
              onOpen={setSelected}
            />
          ))}
        </div>
      )}

      {selecting ? (
        <BulkActionBar
          count={selectedIds.size}
          onSelectAll={() => setSelectedIds(new Set(filtered.map((e) => e.item.id)))}
          onSnooze={() => setSheetMode('snooze')}
          onTag={() => setSheetMode('tag')}
          onMove={() => setSheetMode('move')}
          onDelete={() => runBulk({ action: 'remove' })}
        />
      ) : null}

      <BulkSheet
        mode={sheetMode}
        count={selectedIds.size}
        onClose={() => setSheetMode(null)}
        onApply={runBulk}
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
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
