import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ApiError } from '../../api/client';
import { ToastStack } from '../../ui';
import type { ToastItem } from '../../ui';
import { deleteKeeperFile, restoreKeeperFile } from './api';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { FileTree } from './FileTree';
import { FileView } from './FileView';
import {
  buildStemIndex,
  clearLastPath,
  displayName,
  groupFiles,
  loadGroupOpen,
  matchesQuery,
  readLastPath,
  resolveStem,
  saveGroupOpen,
  writeLastPath,
} from './tree';
import { KEEPER_TREE_KEY, keeperFileKey, useKeeperFile, useKeeperTree, useSaveKeeperFile } from './useKeeperData';
import styles from './KeeperPage.module.css';

/** How long the "Deleted … / Undo" toast stays up (legacy showUndo). */
const UNDO_TOAST_MS = 8000;

/** How long the deleted file's folder flashes after the bump (legacy bumpToGroup). */
const BUMP_MS = 1200;

/**
 * The Files tab — native port of templates/keeper.html. Sidebar file tree
 * over /api/keeper/tree, content pane with read/edit + autosave over
 * /api/keeper/file, delete/undo via DELETE + /api/keeper/file/restore.
 * Deep link: /files?path=<vault-relative-path> (replaces the legacy #path
 * hash and the shell's keeper-open postMessage; a legacy hash is still
 * honored once on mount for old bookmarks).
 */
export function KeeperPage() {
  const search = useSearch({ from: '/files' });
  const navigate = useNavigate({ from: '/files' });
  const queryClient = useQueryClient();

  const treeQuery = useKeeperTree();
  const files = useMemo(() => treeQuery.data?.files ?? [], [treeQuery.data]);
  const groups = useMemo(() => groupFiles(files), [files]);
  const stemIndex = useMemo(() => buildStemIndex(files), [files]);
  const resolveWikilink = useCallback((name: string) => resolveStem(stemIndex, name), [stemIndex]);

  const currentPath = search.path ?? null;

  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [editorFocused, setEditorFocused] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bumpGroup, setBumpGroup] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastItem | null>(null);
  // Group open-state: session overrides on top of the remembered localStorage
  // values (same keeper.open.<group> keys as the legacy page).
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});

  // One-shot undo of the last delete (content came back with the DELETE).
  const lastDeleted = useRef<{ path: string; content: string } | null>(null);
  // The unmounting FileView flushes dirty edits on unmount — after a delete
  // that flush must not resurrect the file through the save endpoint.
  const justDeletedPath = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);

  const isGroupOpen = useCallback(
    (group: string) => openOverrides[group] ?? loadGroupOpen(group),
    [openOverrides],
  );
  const setGroupOpen = useCallback((group: string, open: boolean) => {
    saveGroupOpen(group, open);
    setOpenOverrides((cur) => (cur[group] === open ? cur : { ...cur, [group]: open }));
  }, []);

  const fileQuery = useKeeperFile(currentPath, editorFocused);
  const saveMutation = useSaveKeeperFile();

  // Deep-link init, once the tree is known: ?path= wins (already in the URL);
  // otherwise a legacy #<path> hash (old bookmarks / pre-cutover links), then
  // the remembered last-open file.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    if (search.path) {
      didInit.current = true;
      return;
    }
    if (!treeQuery.data) return;
    didInit.current = true;
    const all = treeQuery.data.files;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    const last = readLastPath();
    const target =
      hash && all.some((f) => f.path === hash) ? hash : last && all.some((f) => f.path === last) ? last : null;
    if (target) void navigate({ search: { path: target }, replace: true });
  }, [search.path, treeQuery.data, navigate]);

  // Remember the open file once it actually loads (legacy set keeper.last
  // only after a successful fetch).
  useEffect(() => {
    if (currentPath && fileQuery.data && fileQuery.data.path === currentPath) writeLastPath(currentPath);
  }, [currentPath, fileQuery.data]);

  // Make sure the active file's group is open so it's visible (legacy markActive).
  useEffect(() => {
    if (!currentPath) return;
    const file = files.find((f) => f.path === currentPath);
    if (file && !isGroupOpen(file.group)) setGroupOpen(file.group, true);
  }, [currentPath, files, isGroupOpen, setGroupOpen]);

  // Searching auto-expands groups with matches (legacy filterTree set
  // group.open, which persisted through its ontoggle handler — kept as-is).
  useEffect(() => {
    if (!query.trim()) return;
    for (const g of groups) {
      if (!isGroupOpen(g.group) && g.files.some((f) => matchesQuery(f, query))) setGroupOpen(g.group, true);
    }
  }, [query, groups, isGroupOpen, setGroupOpen]);

  // Surface load failures (stale ?path deep link, file deleted elsewhere) in
  // the status line, like legacy openFile's error branch.
  useEffect(() => {
    if (fileQuery.isError) {
      setStatusText(`Error: ${fileQuery.error instanceof ApiError ? fileQuery.error.message : 'load failed'}`);
    } else {
      // A later poll succeeded — don't leave a stale load error stuck in the
      // status line (save statuses aren't prefixed "Error:", so they survive).
      setStatusText((s) => (s.startsWith('Error:') ? '' : s));
    }
  }, [fileQuery.isError, fileQuery.error]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (bumpTimer.current) clearTimeout(bumpTimer.current);
    },
    [],
  );

  function openFile(path: string) {
    setDrawerOpen(false);
    if (path === currentPath) return;
    setStatusText('');
    void navigate({ search: { path } });
  }

  function bumpToGroup(group: string) {
    setDrawerOpen(true); // mobile: show the tree so the bump is visible (desktop: no-op)
    setBumpGroup(group);
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
    bumpTimer.current = setTimeout(() => setBumpGroup(null), BUMP_MS);
  }

  function showUndoToast(path: string) {
    const id = ++toastSeq.current;
    setToast({
      id,
      message: `Deleted ${displayName(path)}`,
      tone: 'info',
      actionLabel: 'Undo',
      onAction: () => void undoDelete(),
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((cur) => (cur && cur.id === id ? null : cur)), UNDO_TOAST_MS);
  }

  async function doDelete() {
    const path = currentPath;
    if (!path) {
      setConfirmOpen(false);
      return;
    }
    let deleted;
    try {
      deleted = await deleteKeeperFile(path);
    } catch (err) {
      setConfirmOpen(false);
      setStatusText(`Delete failed: ${err instanceof ApiError ? err.message : 'network'}`);
      return;
    }
    setConfirmOpen(false);
    lastDeleted.current = { path, content: deleted.content };
    justDeletedPath.current = path;
    if (readLastPath() === path) clearLastPath();
    setStatusText('');
    void navigate({ search: {} }); // back to the empty state
    queryClient.removeQueries({ queryKey: keeperFileKey(path) });
    void queryClient.invalidateQueries({ queryKey: KEEPER_TREE_KEY }); // drop it from the tree
    setGroupOpen(deleted.group, true); // make sure the folder renders open
    bumpToGroup(deleted.group);
    showUndoToast(path);
  }

  async function undoDelete() {
    const deleted = lastDeleted.current;
    if (!deleted) return;
    try {
      await restoreKeeperFile(deleted.path, deleted.content);
    } catch (err) {
      setStatusText(`Undo failed: ${err instanceof ApiError ? err.message : 'network'}`);
      // Tapping Undo dismissed the toast — put it back so she can retry
      // (lastDeleted still holds the content).
      showUndoToast(deleted.path);
      return;
    }
    lastDeleted.current = null;
    justDeletedPath.current = null;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
    await queryClient.invalidateQueries({ queryKey: KEEPER_TREE_KEY });
    openFile(deleted.path);
  }

  // Bound per open file; the guard keeps a post-delete unmount flush from
  // recreating the file it just deleted.
  const save = (content: string) => {
    if (!currentPath || justDeletedPath.current === currentPath) return Promise.resolve();
    return saveMutation.mutateAsync({ path: currentPath, content });
  };

  const fileData = currentPath && fileQuery.data && fileQuery.data.path === currentPath ? fileQuery.data : null;

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <button
          type="button"
          className={styles.menuBtn}
          onClick={() => setDrawerOpen((o) => !o)}
          aria-label="Files"
        >
          &#9776;
        </button>
        <h1 className={styles.title}>Keeper memory</h1>
        <input
          className={styles.search}
          type="search"
          placeholder="Search files…"
          aria-label="Search files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className={styles.main}>
        <div
          className={`${styles.scrim} ${drawerOpen ? styles.scrimOpen : ''}`}
          onClick={() => setDrawerOpen(false)}
        />
        <FileTree
          groups={groups}
          query={query}
          currentPath={currentPath}
          isGroupOpen={isGroupOpen}
          onToggleGroup={setGroupOpen}
          onOpenFile={openFile}
          bumpGroup={bumpGroup}
          drawerOpen={drawerOpen}
        />
        <div className={styles.pane}>
          {fileData ? (
            <FileView
              key={fileData.path}
              path={fileData.path}
              initialContent={fileData.content}
              resolveWikilink={resolveWikilink}
              save={save}
              onOpenFile={openFile}
              onAskDelete={() => setConfirmOpen(true)}
              onFocusChange={setEditorFocused}
              setStatus={setStatusText}
            />
          ) : currentPath && fileQuery.isLoading ? (
            <div className={styles.emptyState}>Loading…</div>
          ) : treeQuery.isError && !treeQuery.data ? (
            // The sidebar renders nothing when the tree never loaded — say so
            // instead of an unexplained "pick a file" over an empty tree.
            <div className={styles.emptyState}>Couldn&apos;t load the file tree.</div>
          ) : (
            <div className={styles.emptyState}>Pick a file to see what the keeper remembers.</div>
          )}
          <div className={styles.saveStatus}>{statusText}</div>
        </div>
      </div>

      <ConfirmDeleteModal
        open={confirmOpen}
        path={currentPath}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void doDelete()}
      />

      <ToastStack toasts={toast ? [toast] : []} onDismiss={() => setToast(null)} />
    </div>
  );
}
