import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionRoster } from '../../features/observatory/api';
import { convIdOf, pageLabel, pathOf, sectionForUrl, sectionById, type Section } from './sections';
import {
  appTabSets,
  createSet,
  isPinned,
  menuSections,
  pin,
  removeSet,
  reorder,
  sectionsOf,
  unpin,
} from './tabSets';
import {
  buildBar,
  closeTab,
  fallbackAfterClose,
  moveTab,
  neighbourAfterClose,
  urlsOnBar,
  type BarItem,
  type OpenTab,
} from './panelTabs';
import { gapToPosition, useTabDrag, type DropSlot, type TabDrag, type TabDragSource } from './tabDrag';
import { useLiveSessions } from './useLiveSessions';
import { useTabSets } from './useTabSets';
import { useMenuFit } from '../menuFit';
import { appOfSet } from '../apps';
import styles from './TabBar.module.css';

/**
 * TabBar.tsx — the row across the top of a panel: what's pinned, and what she
 * has open. It works like a browser's tab row.
 *
 * TWO GROUPS, always in this order:
 *
 *   ANCHORS  the pinned sections of this panel's set. Always there, at the
 *            left; changed only from the ▾.
 *   OPEN     what she opened, in the order she arranged them. Arriving
 *            somewhere opens a tab (Workspace.tsx), and it stays until she
 *            closes it with its ×.
 *
 * NOTHING ELSE APPEARS. A session running or waiting on her that she hasn't
 * opened gets no tab, no dot, no count — the roster shows those. A session she
 * HAS opened wears its state on its own tab: purple breathing toward teal
 * while it runs, amber and still while it waits on her. The breathing is on
 * the underline and a dot rather than the label, so the name stays readable,
 * and every pulse shares one clock (see the stylesheet) so several running
 * sessions breathe together.
 *
 * THE × CLOSES THE VIEW, NEVER THE SESSION. The session keeps running and
 * stays in the Observatory; opening it again brings the tab back at the end.
 * Closing the tab she's ON moves her to the tab beside it — right, else left,
 * else the section's front page — the way a browser does, so the page never
 * sits there with nothing lit.
 *
 * DRAGGING (tabDrag.ts): pinned tabs rearrange among pinned tabs, open tabs
 * among open tabs, by mouse or by press-and-hold on a touch screen. An open
 * tab can also be dropped on ANOTHER panel's row, which moves it there
 * (Workspace.tsx does the move). The order is saved with the layout.
 *
 * AN ANCHOR ALWAYS SAYS ITS OWN NAME, and clicking it always goes to that
 * room's front page. The tabs beside it are what's actually open in that
 * room, and one of those is what says where she is.
 *
 * WHICH SET this panel wears is per window (stored with the layout); the sets
 * themselves are shared from the vault (useTabSets.ts). They're numbered
 * rather than named, so they're slots she fills rather than categories the app
 * decided for her.
 *
 * SETS ARE HERS TO MAKE AND UNMAKE, from the ▾. A new one starts empty and the
 * panel switches to it immediately — an empty bar says "nothing pinned, use the
 * ▾", which is already the next thing to do, so there's nothing to name or
 * configure first.
 *
 * Deleting is deliberately the quietest thing in the menu. Only the set she's
 * WEARING offers it, so switching to a set is how she takes aim and the bar
 * shows her what she's about to lose; it says "Delete" rather than wearing an
 * icon, because the icon column beside it belongs to the pin stars, which are a
 * reversible toggle and must not read as the same kind of gesture; and it takes
 * two clicks ("Delete" → "Sure?", disarming itself after a few seconds) rather
 * than opening a dialog, which interrupts a dropdown worse than the thing it's
 * guarding. The last set offers nothing at all — deleting it would leave no ▾
 * to make another from.
 *
 * THE APPS ARE SETS TOO, listed first in the ▾ (tabSets.ts appTabSets).
 * Picking one puts that app in this panel: its tabs, and its pages behaving
 * as that app's (Workspace.tsx hands the app down). They're read-only — no
 * stars, no delete, anchors don't reorder — and never saved.
 *
 * Touches: panelTabs.ts (what belongs on the bar), tabDrag.ts (the drag),
 * useLiveSessions.ts (running/waiting state), sections.ts (what a tab means),
 * tabSets.ts (create/remove/pin/unpin/reorder), PanelFrame.tsx (draws this in
 * the header row), Workspace.tsx (opens tabs, holds the drag).
 *
 * Prompt that produced it: "function basically like a browser tab except
 * clicking the x button doesn't close the actual session. i want to be able to
 * drag to rearrange them and i want it to automatically place those that i
 * open up there, but don't place them up there until i open it again." Later:
 * "I should be able to like, have tabs open on the right window too ... or be
 * draggable between the split screen windows."
 */

export function TabBar({
  panelId,
  url,
  setId,
  openTabs,
  drag,
  onSetId,
  onOpenTabs,
  onNavigate,
  onDrag,
  onMoveToPanel,
}: {
  /** Which panel this row belongs to — what a tab dropped on it lands in. */
  panelId: string;
  /** Where this panel currently is. */
  url: string;
  setId: string;
  openTabs: OpenTab[];
  /** The tab being dragged anywhere in the window, or null. */
  drag: TabDrag | null;
  onSetId: (setId: string) => void;
  onOpenTabs: (next: OpenTab[]) => void;
  onNavigate: (url: string) => void;
  onDrag: (drag: TabDrag | null) => void;
  /** An open tab of THIS row was dropped on another panel's row. */
  onMoveToPanel: (url: string, toPanelId: string, index: number) => void;
}) {
  const { sets, save: saveSets } = useTabSets();
  /* The apps are sets too, listed first (tabSets.ts appTabSets): built in and
     read-only. Her own sets are the only ones ever saved, and an operation on
     an app's set changes nothing — so nothing is sent for it. */
  const appSets = useMemo(() => appTabSets(), []);
  const allSets = useMemo(() => [...appSets, ...sets], [appSets, sets]);
  const save = useCallback((next: typeof sets) => {
    if (next !== sets) saveSets(next);
  }, [sets, saveSets]);
  const sessionStates = useLiveSessions();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  /* This menu is the longest thing in the app's chrome — every set, then every
     section — and it opens inside a panel, which clips (PanelFrame.module.css).
     Sized to the window it lost its bottom rows outright; sized to the panel
     they're a scroll away. See menuFit.ts. */
  const [menuBtn, setMenuBtn] = useState<HTMLButtonElement | null>(null);
  const menuFit = useMenuFit(menuBtn, menuOpen);
  /* Which bin is currently asking "Sure?". One at a time, and it gives up on
     its own after a few seconds — an armed delete left sitting there is a trap
     for the next click. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armDelete = useCallback((id: string | null) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmDelete(id);
    if (id) confirmTimer.current = setTimeout(() => setConfirmDelete(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  /* Which set this panel wears: an app, or one of hers (by position, falling
     back to her first when the saved id is gone). */
  const activeApp = appOfSet(setId);
  const activeIndex = activeApp ? -1 : Math.max(0, sets.findIndex((s) => s.id === setId));
  const activeSetId = activeApp ? setId : (sets[activeIndex]?.id ?? '');
  const setMark = activeApp ? activeApp.glyph : String(activeIndex + 1);
  const setName = activeApp ? activeApp.name : `set ${activeIndex + 1}`;
  const anchors = useMemo(() => sectionsOf(allSets, activeSetId), [allSets, activeSetId]);
  // Which section the page is in — this bar's own anchors first, so on an
  // app's bar /todos is To Do rather than the Dashboard (sections.ts).
  const here = sectionForUrl(
    url,
    anchors.map((a) => a.id),
  );

  // Rebuilt on every roster poll, which is what lets an open session's tab
  // change colour the moment it starts or stops.
  const bar = useMemo(
    () =>
      buildBar({
        anchors: anchors.map((a) => a.id),
        open: openTabs,
        stateFor: (u) => {
          const id = convIdOf(u);
          return id ? (sessionStates.get(id) ?? null) : null;
        },
      }),
    [anchors, openTabs, sessionStates],
  );

  /* What to call a tab. A conversation url carries only an opaque id, so the
     roster the app already keeps warm supplies the name — without this an open
     session tab would just read "Session", which is no help at all when three
     of them are side by side. */
  const { data: roster } = useSessionRoster();
  const titleFor = useCallback(
    (u: string): string => {
      const id = convIdOf(u);
      const found = id ? roster?.sessions.find((x) => x.id === id)?.title : undefined;
      return found ?? pageLabel(u);
    },
    [roster],
  );

  /* Close a tab: the view goes, the session doesn't. Closing the one she's on
     moves her beside it first, so the page doesn't stay up with nothing lit. */
  const onCloseOpen = (closing: string) => {
    onOpenTabs(closeTab(openTabs, closing));
    if (closing === url) onNavigate(neighbourAfterClose(openTabs, closing) ?? fallbackAfterClose(closing));
  };

  /* Put a dragged tab down. Within this row it's a reorder of its own group;
     on another panel's row it's a move, which the workspace owns because it
     changes two panels at once. */
  const rowRef = useRef<HTMLDivElement>(null);
  const onDrop = (source: TabDragSource, slot: DropSlot) => {
    if (slot.panelId !== panelId) {
      if (source.kind === 'open') onMoveToPanel(source.url, slot.panelId, slot.index);
      return;
    }
    const to = gapToPosition(source.index, slot.index);
    if (source.kind === 'anchor') save(reorder(sets, activeSetId, source.index, to));
    else onOpenTabs(moveTab(openTabs, source.index, to));
  };
  const { start: startDrag, swallowClick } = useTabDrag({
    rowRef,
    ghostClass: styles.ghost,
    onDrag,
    onDrop,
  });

  /* Where this row draws the drop line: only while a drag is over THIS row,
     and not in the two gaps either side of the tab's own place in its own row,
     where dropping would change nothing. */
  const dropGap =
    drag?.over && drag.over.panelId === panelId
      ? drag.panelId === panelId && (drag.over.index === drag.index || drag.over.index === drag.index + 1)
        ? null
        : { kind: drag.kind, index: drag.over.index }
      : null;

  // A bin left armed behind a closed menu would fire on the next visit.
  useEffect(() => {
    if (!menuOpen) armDelete(null);
  }, [menuOpen, armDelete]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  /* Always the front page. Getting back to where she was inside a room is
     what the open tabs beside the anchor are for — the anchor doesn't need to
     also be a memory, and being one made it ambiguous what a click would do. */
  const goToSection = (section: Section) => onNavigate(section.home);

  /* A new set, and the panel wears it straight away — she asked for it from
     this panel's ▾, so this panel is the one that wants it.

     The id has to be unique across WINDOWS, not just within this one, since
     it's about to be written to the vault where every window reads it; a plain
     counter would collide the moment two windows made a set. The stored name is
     bookkeeping — the menu shows position numbers, not names — but the server
     requires a non-empty one, and "Set 4" is what she'd call it anyway. */
  const onCreateSet = () => {
    const id = `set-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    save(createSet(sets, id, `Set ${sets.length + 1}`));
    onSetId(id);
    setMenuOpen(false);
  };

  /* Deleting the set this panel is wearing moves it to the first one EXPLICITLY
     rather than letting the fallback below (Math.max(0, findIndex)) handle it.
     Same thing on screen, but it clears the dead id out of this window's saved
     layout instead of leaving it there to be silently corrected forever. */
  const onDeleteSet = (id: string) => {
    const next = removeSet(sets, id);
    if (next === sets) return;
    save(next);
    if (id === activeSetId) onSetId(next[0].id);
    armDelete(null);
  };

  /* An anchor she's standing in that isn't pinned to this set still gets a
     tab, or switching sets would leave the bar with nothing lit and no name
     for the page she's on. */
  const visiting =
    here && !anchors.some((a) => a.id === here.id) && !urlsOnBar(bar).includes(url) ? here : null;

  return (
    <div className={styles.bar}>
      <div className={styles.menuWrap} ref={menuRef}>
        <button
          type="button"
          ref={setMenuBtn}
          className={styles.menuBtn}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title={activeApp ? `${activeApp.name} — switch app or set` : `Set ${activeIndex + 1} — switch set, or pin a tab`}
          aria-label="Switch app or tab set, or pin a tab"
        >
          <span className={styles.setNum}>{setMark}</span>
          <span aria-hidden="true">&#9662;</span>
        </button>
        {menuOpen ? (
          <div
            className={[styles.menu, menuFit?.flipUp ? styles.menuUp : ''].filter(Boolean).join(' ')}
            role="menu"
            style={menuFit ? { maxHeight: menuFit.maxHeight } : undefined}
          >
            {appSets.length > 0 ? <div className={styles.groupLabel}>Apps</div> : null}
            {appSets.map((s) => {
              const app = appOfSet(s.id);
              const isActive = s.id === activeSetId;
              return (
                <div key={s.id} className={styles.menuRow}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={styles.menuItem}
                    onClick={() => {
                      onSetId(s.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className={styles.radio}>{isActive ? '●' : '○'}</span>
                    <span className={styles.setNumRow}>{app?.glyph}</span>
                    <span className={styles.setPreview}>{s.name}</span>
                  </button>
                </div>
              );
            })}
            <div className={styles.groupLabel}>{appSets.length > 0 ? 'Your sets' : 'Sets'}</div>
            {sets.map((s, i) => {
              const isActive = s.id === activeSetId;
              return (
                <div key={s.id} className={styles.menuRow}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={styles.menuItem}
                    onClick={() => {
                      onSetId(s.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className={styles.radio}>{isActive ? '●' : '○'}</span>
                    <span className={styles.setNumRow}>{i + 1}</span>
                    <span className={styles.setPreview}>
                      {sectionsOf(sets, s.id).map((x) => x.label).join(' · ') || 'empty'}
                    </span>
                  </button>
                  {/* ONLY THE SET SHE'S WEARING CAN BE DELETED, and it says the
                      word rather than wearing an icon.

                      A bin on every row put three destructive controls on the
                      path she takes to do the ordinary thing — switch sets —
                      and put them in the same column, at the same size, as the
                      pin stars, which are a reversible toggle. One control, on
                      the row already marked as hers, can't be mis-aimed: she
                      switches to a set, sees the bar become it, then throws it
                      away. A word rather than a glyph for the same reason —
                      rare and consequential earns language; frequent and
                      reversible earns an icon.

                      None at all on the last set: there'd be no ▾ left to make
                      another from. Absent, not disabled — a control she can
                      never use is a question she answers every time she looks. */}
                  {isActive && sets.length > 1 ? (
                    <button
                      type="button"
                      className={[styles.delete, confirmDelete === s.id ? styles.deleteArmed : '']
                        .filter(Boolean)
                        .join(' ')}
                      title={`Delete set ${i + 1}`}
                      aria-label={
                        confirmDelete === s.id ? `Confirm delete set ${i + 1}` : `Delete set ${i + 1}`
                      }
                      onClick={() => (confirmDelete === s.id ? onDeleteSet(s.id) : armDelete(s.id))}
                    >
                      {confirmDelete === s.id ? 'Sure?' : 'Delete'}
                    </button>
                  ) : null}
                </div>
              );
            })}
            <button type="button" role="menuitem" className={styles.menuItem} onClick={onCreateSet}>
              <span className={styles.plus} aria-hidden="true">
                +
              </span>
              New set
            </button>

            {/* An app's tabs are fixed, so on an app's bar this list only goes. */}
            <div className={styles.groupLabel}>{activeApp ? 'Go' : `Go, or pin to set ${activeIndex + 1}`}</div>
            {menuSections().map((section) => {
              const isOn = isPinned(allSets, activeSetId, section.id);
              return (
                <div key={section.id} className={styles.menuRow}>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      goToSection(section);
                      setMenuOpen(false);
                    }}
                  >
                    <span className={styles.icon}>{section.icon}</span>
                    {section.label}
                  </button>
                  {activeApp ? null : (
                  <button
                    type="button"
                    className={[styles.star, isOn ? styles.starOn : ''].filter(Boolean).join(' ')}
                    aria-pressed={isOn}
                    title={isOn ? `Unpin from set ${activeIndex + 1}` : `Pin to set ${activeIndex + 1}`}
                    aria-label={isOn ? `Unpin ${section.label}` : `Pin ${section.label}`}
                    onClick={() =>
                      save(
                        isOn
                          ? unpin(sets, activeSetId, section.id)
                          : pin(sets, activeSetId, section.id),
                      )
                    }
                  >
                    {isOn ? '★' : '☆'}
                  </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div
        ref={rowRef}
        className={styles.tabs}
        role="tablist"
        aria-label="Panel tabs"
        data-tab-row={panelId}
        onClickCapture={swallowClick}
      >
        {bar.map((item, i) => {
          const isAnchor = item.kind === 'anchor';
          const groupIndex = isAnchor ? i : i - anchors.length;
          const groupSize = isAnchor ? anchors.length : bar.length - anchors.length;
          const dropHere = dropGap && dropGap.kind === item.kind;
          return (
            <Tab
              key={isAnchor ? `a:${item.sectionId}` : item.url}
              item={item}
              groupIndex={groupIndex}
              currentUrl={url}
              titleFor={titleFor}
              lifted={drag?.panelId === panelId && drag.kind === item.kind && drag.index === groupIndex}
              dropBefore={Boolean(dropHere && dropGap.index === groupIndex)}
              dropAfter={Boolean(dropHere && dropGap.index === groupSize && groupIndex === groupSize - 1)}
              onStartDrag={(e, source) => startDrag(e, { ...source, panelId })}
              onGoSection={goToSection}
              onGoUrl={onNavigate}
              onCloseOpen={onCloseOpen}
            />
          );
        })}
        {/* A row with no open tabs still takes an open tab dropped from
            another panel; the line shows where it would go. */}
        {dropGap?.kind === 'open' && bar.length === anchors.length ? (
          <span className={styles.dropEnd} aria-hidden="true">
            <span className={styles.dropLine} />
          </span>
        ) : null}
        {visiting ? (
          <div className={styles.tabWrap} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected
              className={[styles.tab, styles.tabActive, styles.tabVisiting].join(' ')}
              title={
                activeApp
                  ? `${here?.label} — not one of ${activeApp.name}'s tabs`
                  : `${here?.label} — not pinned to ${setName}. Use the ▾ to pin it.`
              }
              onClick={() => here && onNavigate(here.home)}
            >
              <span className={styles.icon}>{here?.icon}</span>
              <span className={styles.tabLabel}>{here?.label}</span>
            </button>
          </div>
        ) : null}
        {bar.length === 0 && !visiting ? (
          <span className={styles.empty}>Nothing pinned — use the ▾ to add some</span>
        ) : null}
      </div>
    </div>
  );
}

/** One tab. Split out because an anchor and an open page share a shape but
 *  little else. */
function Tab({
  item,
  groupIndex,
  currentUrl,
  titleFor,
  lifted,
  dropBefore,
  dropAfter,
  onStartDrag,
  onGoSection,
  onGoUrl,
  onCloseOpen,
}: {
  item: BarItem;
  /** Its place within its own group (anchors, or open tabs). */
  groupIndex: number;
  currentUrl: string;
  titleFor: (url: string) => string;
  /** This is the tab being dragged. */
  lifted: boolean;
  /** Draw the drop line at its left edge, or (last in its group) its right. */
  dropBefore: boolean;
  dropAfter: boolean;
  onStartDrag: (e: React.PointerEvent<HTMLElement>, source: Omit<TabDragSource, 'panelId'>) => void;
  onGoSection: (s: Section) => void;
  onGoUrl: (url: string) => void;
  onCloseOpen: (url: string) => void;
}) {
  const isAnchor = item.kind === 'anchor';
  const section = isAnchor ? sectionById(item.sectionId) : null;
  if (isAnchor && !section) return null;

  const url = isAnchor ? section!.home : item.url;
  /* Exactly one tab is lit. An anchor lights only while she's on its front
     page, not anywhere in its section — otherwise reading a session lit both
     the Observatory anchor and the session's own tab at once. */
  const selected = isAnchor ? pathOf(currentUrl) === pathOf(url) : currentUrl === url;

  const label = isAnchor ? section!.label : titleFor(url);

  const running = item.kind === 'open' && item.running && !item.awaiting;
  const awaiting = item.kind === 'open' && item.awaiting;

  return (
    <div
      role="presentation"
      data-tab-kind={item.kind}
      className={[
        styles.tabWrap,
        lifted ? styles.tabLifted : '',
        dropBefore ? styles.tabDropBefore : '',
        dropAfter ? styles.tabDropAfter : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        draggable={false}
        // Spoken, not just coloured — the state is the point of the tab.
        aria-label={running ? `${label} — running` : awaiting ? `${label} — waiting for you` : label}
        className={[
          styles.tab,
          selected ? styles.tabActive : '',
          running ? styles.tabRunning : '',
          awaiting ? styles.tabAwaiting : '',
          !isAnchor ? styles.tabClosable : '',
        ]
          .filter(Boolean)
          .join(' ')}
        title={
          running
            ? `${label} — running`
            : awaiting
              ? `${label} — waiting for you`
              : isAnchor && selected
                ? `Back to ${section!.label}`
                : label
        }
        onPointerDown={(e) => onStartDrag(e, { kind: item.kind, index: groupIndex, url })}
        onClick={() => (isAnchor ? onGoSection(section!) : onGoUrl(url))}
      >
        {running || awaiting ? (
          <span className={running ? styles.dotRunning : styles.dotAwaiting} aria-hidden="true" />
        ) : (
          <span className={styles.icon}>{isAnchor ? section!.icon : '◈'}</span>
        )}
        <span className={styles.tabLabel}>{label}</span>
      </button>
      {/* Only the open ones close, and closing is the view only — the session
          behind it keeps going. An anchor is unpinned from the ▾. */}
      {item.kind === 'open' ? (
        <button
          type="button"
          className={styles.close}
          title={`Close ${label} (the session keeps going)`}
          aria-label={`Close ${label}`}
          onClick={(e) => {
            e.stopPropagation(); // the × sits over the tab
            onCloseOpen(url);
          }}
        >
          &#10005;
        </button>
      ) : null}
    </div>
  );
}
