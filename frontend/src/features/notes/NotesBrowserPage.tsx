import { useEffect, useMemo, useRef, useState } from 'react';
import { ToastStack } from '../../ui';
import { TAB_META, VALID_TABS, isValidTab } from '../../shell/tabs';
import { useToasts } from '../todos/useTodayData';
import { NotesPill } from '../todos/NotesPill';
import { formatNoteAge, isLongNote, readStoredSort, sortNotesByCreated, writeStoredSort, type SortDir } from '../todos/noteHelpers';
import { flattenNotes, useAllNotes, useNotesBrowserMutations, type FlatNote, type NotesBrowserKind } from './useNotesBrowser';
import styles from './NotesBrowserPage.module.css';

type KindFilter = NotesBrowserKind | 'both';

const KIND_OPTIONS: ReadonlyArray<{ key: KindFilter; label: string }> = [
  { key: 'dev', label: '📝 Dev' },
  { key: 'idea', label: '💡 Ideas' },
  { key: 'both', label: 'Both' },
];

const KIND_ICON: Record<NotesBrowserKind, string> = { dev: '📝', idea: '💡' };

function isPublicMode(): boolean {
  return typeof window !== 'undefined' && window.VIEW_MODE === 'public';
}

function tabLabel(tab: string): string {
  if (isValidTab(tab)) return TAB_META[tab].label;
  return tab.length ? tab.charAt(0).toUpperCase() + tab.slice(1) : tab;
}

/** Known dashboard tabs first (in their usual order), then any other tab
 * name (e.g. 'journal') alphabetically after. */
function sortTabs(tabs: readonly string[]): string[] {
  return tabs.slice().sort((a, b) => {
    const ia = (VALID_TABS as readonly string[]).indexOf(a);
    const ib = (VALID_TABS as readonly string[]).indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function noteKey(n: FlatNote): string {
  return `${n.kind}:${n.tab}:${n.id}`;
}

/**
 * /notes — every dev note and idea across every tab, in one scrollable
 * review page. The floating pill (NotesPill) is still where capture
 * happens; this is a browse/edit/cleanup surface, reached from the pill's
 * "All ↗" link or TopTabs' More menu.
 */
export function NotesBrowserPage() {
  const isPublic = isPublicMode();

  // Hooks run unconditionally (Rules of Hooks) regardless of public mode —
  // `enabled` on the queries is what actually stops network/render work.
  const devQuery = useAllNotes('dev', !isPublic);
  const ideaQuery = useAllNotes('idea', !isPublic);
  const { toasts, push, dismiss } = useToasts();
  const { edit, remove } = useNotesBrowserMutations(push);

  const [kindFilter, setKindFilter] = useState<KindFilter>('both');
  const [tabFilter, setTabFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortDir>(readStoredSort);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const flat = useMemo(
    () => [...flattenNotes(devQuery.data?.tabs, 'dev'), ...flattenNotes(ideaQuery.data?.tabs, 'idea')],
    [devQuery.data, ideaQuery.data],
  );

  const tabsForChips = useMemo(() => {
    const base = kindFilter === 'both' ? flat : flat.filter((n) => n.kind === kindFilter);
    return sortTabs(Array.from(new Set(base.map((n) => n.tab))));
  }, [flat, kindFilter]);

  // If switching kind filters makes the active tab chip disappear, drop it
  // rather than leave an invisible filter silently emptying the list.
  useEffect(() => {
    if (tabFilter && !tabsForChips.includes(tabFilter)) setTabFilter(null);
  }, [tabFilter, tabsForChips]);

  const filtered = useMemo(() => {
    let list = flat;
    if (kindFilter !== 'both') list = list.filter((n) => n.kind === kindFilter);
    if (tabFilter) list = list.filter((n) => n.tab === tabFilter);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((n) => n.text.toLowerCase().includes(q));
    return sortNotesByCreated(list, sort);
  }, [flat, kindFilter, tabFilter, search, sort]);

  function toggleSort() {
    setSort((cur) => {
      const next: SortDir = cur === 'newest' ? 'oldest' : 'newest';
      writeStoredSort(next);
      return next;
    });
  }

  function toggleExpanded(key: string) {
    setExpandedKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function startEdit(n: FlatNote) {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmDeleteKey(null);
    setEditingKey(noteKey(n));
    setEditDraft(n.text);
  }

  function saveEdit(n: FlatNote) {
    const text = editDraft.trim();
    if (!text) return;
    edit(n.kind, n.tab, n.id, text);
    setEditingKey(null);
  }

  function requestDelete(n: FlatNote) {
    const key = noteKey(n);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmDeleteKey === key) {
      setConfirmDeleteKey(null);
      remove(n.kind, n.tab, n.id);
      return;
    }
    setConfirmDeleteKey(key);
    confirmTimer.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
  }

  if (isPublic) {
    return (
      <div className={styles.page}>
        <div className={styles.publicStub}>Notes aren&rsquo;t available here.</div>
      </div>
    );
  }

  const isLoading = devQuery.isLoading || ideaQuery.isLoading;
  const isError = devQuery.isError || ideaQuery.isError;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Notes</h1>
        <span className={styles.count}>{filtered.length}</span>
      </div>

      <div className={styles.controls}>
        <div className={styles.kindToggle} role="group" aria-label="Note kind">
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`${styles.kindBtn} ${kindFilter === opt.key ? styles.kindBtnActive : ''}`}
              onClick={() => setKindFilter(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.sortBtn} onClick={toggleSort}>
          {/* ︎ = text variation selector: stops iOS rendering the arrow as emoji */}
          {sort === 'newest' ? '\u2193\uFE0E Newest' : '\u2191\uFE0E Oldest'}
        </button>
      </div>

      <input
        className={styles.search}
        type="text"
        placeholder="Search notes…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search notes"
      />

      {tabsForChips.length > 0 ? (
        <div className={styles.chips}>
          <button
            type="button"
            className={`${styles.chip} ${tabFilter === null ? styles.chipActive : ''}`}
            onClick={() => setTabFilter(null)}
          >
            All tabs
          </button>
          {tabsForChips.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`${styles.chip} ${tabFilter === tab ? styles.chipActive : ''}`}
              onClick={() => setTabFilter((cur) => (cur === tab ? null : tab))}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <div className={styles.empty}>Loading&hellip;</div>
      ) : isError ? (
        <div className={styles.empty}>Failed to load notes.</div>
      ) : filtered.length === 0 ? (
        <div className={styles.empty}>No notes match.</div>
      ) : (
        <div className={styles.list}>
          {filtered.map((n) => {
            const key = noteKey(n);
            if (key === editingKey) {
              return (
                <div key={key} className={`${styles.card} ${styles.cardEditing}`}>
                  <textarea
                    className={styles.editArea}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onInput={(e) => {
                      const el = e.currentTarget;
                      el.style.height = 'auto';
                      el.style.height = `${el.scrollHeight}px`;
                    }}
                    autoFocus
                  />
                  <div className={styles.editBtns}>
                    <button type="button" className={styles.cancelBtn} onClick={() => setEditingKey(null)}>
                      Cancel
                    </button>
                    <button type="button" className={styles.saveBtn} onClick={() => saveEdit(n)}>
                      Save
                    </button>
                  </div>
                </div>
              );
            }

            const long = isLongNote(n.text);
            const isExpanded = expandedKeys.has(key);

            return (
              <div key={key} className={styles.card}>
                <div className={styles.cardMeta}>
                  <span className={styles.kindTag}>{KIND_ICON[n.kind]}</span>
                  <span className={styles.tabTag}>{tabLabel(n.tab)}</span>
                  {n.created ? <span className={styles.age}>{formatNoteAge(n.created)}</span> : null}
                </div>

                {long ? (
                  <div
                    className={styles.textWrap}
                    onClick={() => toggleExpanded(key)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpanded(key);
                      }
                    }}
                  >
                    <div className={`${styles.text} ${isExpanded ? '' : styles.textClamped}`}>{n.text}</div>
                    <span className={styles.moreHint}>{isExpanded ? '▲ less' : '▼ more'}</span>
                  </div>
                ) : (
                  <div className={styles.text}>{n.text}</div>
                )}

                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.act}
                    title="Edit"
                    aria-label="Edit note"
                    onClick={() => startEdit(n)}
                  >
                    &#9998;
                  </button>
                  <button
                    type="button"
                    className={`${styles.act} ${styles.actX} ${confirmDeleteKey === key ? styles.actSure : ''}`}
                    title="Delete"
                    aria-label={confirmDeleteKey === key ? 'Confirm delete note' : 'Delete note'}
                    onClick={() => requestDelete(n)}
                  >
                    {confirmDeleteKey === key ? 'Sure?' : <>&times;</>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Notes about the notes page land on their own 'notes' tab. */}
      <NotesPill tab="notes" showAllLink={false} onError={push} />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
