import { useState } from 'react';
import { Sheet } from '../../ui';
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
}

type PanelKind = 'people' | 'threads';

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
export function JournalRail({ onOpenPerson, onOpenThread, onAddNote }: JournalRailProps) {
  const [openPanel, setOpenPanel] = useState<PanelKind | null>(null);
  const peopleQuery = usePeople();
  const threadsQuery = useThreads();

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
        <div className={styles.pill}>
          <button type="button" className={styles.railBtn} onClick={() => setOpenPanel('people')}>
            <span className={styles.railIcon} aria-hidden="true">
              &#128100;
            </span>
            People
          </button>
          <button type="button" className={styles.railBtn} onClick={() => setOpenPanel('threads')}>
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
        </div>
      </div>

      <Sheet open={openPanel === 'people'} onClose={() => setOpenPanel(null)} title="People">
        {panelBody('people')}
      </Sheet>

      <Sheet open={openPanel === 'threads'} onClose={() => setOpenPanel(null)} title="Threads">
        {panelBody('threads')}
      </Sheet>
    </>
  );
}
