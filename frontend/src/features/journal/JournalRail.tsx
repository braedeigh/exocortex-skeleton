import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Sheet } from '../../ui';
import { useDismiss } from '../../shell/useDismiss';
import { NotesPanel } from '../todos/NotesPanel';
import type { NotesPillKind } from '../todos/useNotesPill';
import { readStoredSort, writeStoredSort, type SortDir } from '../todos/noteHelpers';
import { entityHue } from './markdown';
import { usePeople } from './useJournalData';
import styles from './JournalRail.module.css';

export interface JournalRailProps {
  /** Open the person popover for a slug — same handler the inline entity-click path uses. */
  onOpenPerson: (slug: string) => void;
  /** Surface a fetch/mutate failure from the Dev notes / Ideas panel — same
   * toast the rest of the journal page's mutations report through. */
  onError: (message: string) => void;
}

const RAIL_COLLAPSED_KEY = 'journalRailCollapsed';

function readRailCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(RAIL_COLLAPSED_KEY);
    if (stored !== null) return stored === '1';
  } catch {
    return false;
  }
  // No stored preference: start collapsed on touch devices — the expanded
  // pill floats over the first journal entry, which is a fine resting state
  // behind a desktop hover-fade but pure obstruction on a phone.
  return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
}

function writeRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // localStorage unavailable — collapsed state just won't persist across visits
  }
}

/**
 * Port of journal.html's "cutesy floating rail" (.jrail) — launcher buttons
 * riding the top-right of the journal. People opens a browse-list Sheet
 * that reuses the person popover; Threads navigates to the dedicated
 * /threads page (it used to open a twin Sheet — the owner asked for the page,
 * 2026-07-14). In-text thread chips still open the ThreadPopover.
 *
 * The legacy .jlist-panel floating cards become Sheets here (the same
 * translation DevNotesPanel got): a Sheet already handles backdrop,
 * Escape, and outside-tap dismissal, so useDismiss isn't needed.
 */
export function JournalRail({ onOpenPerson, onError }: JournalRailProps) {
  const [openPanel, setOpenPanel] = useState<'people' | null>(null);
  const [openKind, setOpenKind] = useState<NotesPillKind | null>(null);
  const [sort, setSort] = useState<SortDir>(readStoredSort);
  const [collapsed, setCollapsed] = useState<boolean>(readRailCollapsed);
  const notesRef = useRef<HTMLDivElement>(null);
  const peopleQuery = usePeople();
  const navigate = useNavigate();

  const closeNotes = () => setOpenKind(null);
  useDismiss(openKind !== null, closeNotes, notesRef);

  const people = (peopleQuery.data?.people ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  function pick(id: string) {
    setOpenPanel(null);
    onOpenPerson(id);
  }

  // Opening the People Sheet closes any open notes panel and vice versa —
  // one floating surface open at a time.
  function openPeople() {
    setOpenKind(null);
    setOpenPanel('people');
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

  function panelBody() {
    if (peopleQuery.isLoading) return <div className={styles.listEmpty}>Loading…</div>;
    if (peopleQuery.isError) return <div className={styles.listEmpty}>Couldn&apos;t load.</div>;
    if (!people.length) return <div className={styles.listEmpty}>Nothing here yet.</div>;
    return (
      <>
        {people.map((it) => (
          <button
            key={it.id}
            type="button"
            className={styles.listItem}
            style={{ color: `hsl(${entityHue(it.id)} 70% 66%)` }}
            onClick={() => pick(it.id)}
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
              <button type="button" className={styles.railBtn} onClick={openPeople}>
                <span className={styles.railIcon} aria-hidden="true">
                  &#128100;
                </span>
                People
              </button>
              <button type="button" className={styles.railBtn} onClick={() => void navigate({ to: '/threads' })}>
                <span className={styles.railIcon} aria-hidden="true">
                  &#10697;
                </span>
                Threads
              </button>
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
        {panelBody()}
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
