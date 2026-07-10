import { useRef, useState } from 'react';
import { Sheet } from '../../ui';
import { useDismiss } from '../../shell/useDismiss';
import { NotesPanel } from '../todos/NotesPanel';
import type { NotesPillKind } from '../todos/useNotesPill';
import { readStoredSort, writeStoredSort, type SortDir } from '../todos/noteHelpers';
import { entityHue } from './markdown';
import { usePeople, useThreads } from './useJournalData';
import styles from './JournalRail.module.css';

export interface JournalRailProps {
  /** Open the person popover for a slug — same handler the inline entity-click path uses. */
  onOpenPerson: (slug: string) => void;
  /** Open the thread popover for an id — same handler the inline chip-click path uses. */
  onOpenThread: (id: string) => void;
  /** Scroll the always-open bottom composer into view and focus it. Omitted
   * (and the button hidden) on days that aren't in card mode, where there's
   * no composer to jump to. */
  onAddNote?: () => void;
  /** Surface a fetch/mutate failure from the Dev notes / Ideas panel — same
   * toast the rest of the journal page's mutations report through. */
  onError: (message: string) => void;
}

type PanelKind = 'people' | 'threads';

const RAIL_COLLAPSED_KEY = 'journalRailCollapsed';

function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // localStorage unavailable — collapsed state just won't persist across visits
  }
}

/**
 * Port of journal.html's "cutesy floating rail" (.jrail) — People and
 * Threads launcher buttons riding the top-right of the journal, each
 * opening a browse list so an entity can be reached without hunting for an
 * inline mention. A tap reuses the person/thread popovers the journal
 * already uses, so the rail and the in-text highlights share one surface.
 *
 * The legacy .jlist-panel floating cards become Sheets here (the same
 * translation DevNotesPanel got): a Sheet already handles backdrop,
 * Escape, and outside-tap dismissal, so useDismiss isn't needed.
 */
export function JournalRail({ onOpenPerson, onOpenThread, onAddNote, onError }: JournalRailProps) {
  const [openPanel, setOpenPanel] = useState<PanelKind | null>(null);
  const [openKind, setOpenKind] = useState<NotesPillKind | null>(null);
  const [sort, setSort] = useState<SortDir>(readStoredSort);
  const [collapsed, setCollapsed] = useState<boolean>(readRailCollapsed);
  const notesRef = useRef<HTMLDivElement>(null);
  const peopleQuery = usePeople();
  const threadsQuery = useThreads();

  const closeNotes = () => setOpenKind(null);
  useDismiss(openKind !== null, closeNotes, notesRef);

  const people = (peopleQuery.data?.people ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const threads = (threadsQuery.data?.threads ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  function pick(kind: PanelKind, id: string) {
    setOpenPanel(null);
    if (kind === 'people') onOpenPerson(id);
    else onOpenThread(id);
  }

  // Opening a Sheet (People/Threads) closes any open notes panel and vice
  // versa — one floating surface open at a time.
  function openSheet(kind: PanelKind) {
    setOpenKind(null);
    setOpenPanel(kind);
  }

  function openNotes(kind: NotesPillKind) {
    setOpenPanel(null);
    setOpenKind(kind);
  }

  function toggleSort() {
    setSort((cur) => {
      const next: SortDir = cur === 'newest' ? 'oldest' : 'newest';
      writeStoredSort(next);
      return next;
    });
  }

  function toggleCollapsed() {
    setCollapsed((cur) => {
      const next = !cur;
      writeRailCollapsed(next);
      return next;
    });
    // Collapsing (or expanding, though nothing should be open by then)
    // closes any open Sheet/notes panel — the rows they're anchored to are
    // about to disappear.
    setOpenPanel(null);
    setOpenKind(null);
  }

  function panelBody(kind: PanelKind) {
    const query = kind === 'people' ? peopleQuery : threadsQuery;
    const items = kind === 'people' ? people : threads;
    if (query.isLoading) return <div className={styles.listEmpty}>Loading…</div>;
    if (query.isError) return <div className={styles.listEmpty}>Couldn&apos;t load.</div>;
    if (!items.length) return <div className={styles.listEmpty}>Nothing here yet.</div>;
    return (
      <>
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={styles.listItem}
            style={{ color: kind === 'people' ? `hsl(${entityHue(it.id)} 70% 66%)` : 'var(--accent)' }}
            onClick={() => pick(kind, it.id)}
          >
            {it.name}
          </button>
        ))}
      </>
    );
  }

  return (
    <>
      <div className={styles.rail}>
        <div className={`${styles.railGroup} ${collapsed ? styles.railGroupCollapsed : ''}`}>
          <button
            type="button"
            className={`${styles.collapseTab} ${collapsed ? styles.collapseTabCollapsed : ''}`}
            title={collapsed ? 'Expand rail' : 'Collapse rail'}
            aria-label={collapsed ? 'Expand rail' : 'Collapse rail'}
            onClick={toggleCollapsed}
          >
            {collapsed ? '‹' : '›'}
          </button>

          {collapsed ? null : (
            <div className={styles.pill}>
              <button type="button" className={styles.railBtn} onClick={() => openSheet('people')}>
                <span className={styles.railIcon} aria-hidden="true">
                  &#128100;
                </span>
                People
              </button>
              <button type="button" className={styles.railBtn} onClick={() => openSheet('threads')}>
                <span className={styles.railIcon} aria-hidden="true">
                  &#10697;
                </span>
                Threads
              </button>
              {onAddNote ? (
                <button type="button" className={styles.railBtn} onClick={onAddNote}>
                  <span className={styles.railIcon} aria-hidden="true">
                    &#43;
                  </span>
                  Add note
                </button>
              ) : null}
              <button type="button" className={styles.railBtn} onClick={() => openNotes('dev')}>
                <span className={styles.railIcon} aria-hidden="true">
                  &#128221;
                </span>
                Dev notes
              </button>
              <button type="button" className={styles.railBtn} onClick={() => openNotes('idea')}>
                <span className={styles.railIcon} aria-hidden="true">
                  &#128161;
                </span>
                Ideas
              </button>
            </div>
          )}
        </div>
      </div>

      <Sheet open={openPanel === 'people'} onClose={() => setOpenPanel(null)} title="People">
        {panelBody('people')}
      </Sheet>

      <Sheet open={openPanel === 'threads'} onClose={() => setOpenPanel(null)} title="Threads">
        {panelBody('threads')}
      </Sheet>

      {openKind ? (
        <NotesPanel
          ref={notesRef}
          kind={openKind}
          tab="journal"
          showAllLink
          sort={sort}
          onToggleSort={toggleSort}
          onClose={closeNotes}
          onError={onError}
        />
      ) : null}
    </>
  );
}
