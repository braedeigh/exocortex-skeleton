import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionRoster } from '../../features/observatory/api';
import { convIdOf, pageLabel, pathOf, sectionForUrl, sectionById, type Section } from './sections';
import {
  createSet,
  isPinned,
  menuSections,
  pin,
  removeSet,
  reorder,
  sectionsOf,
  unpin,
} from './tabSets';
import { buildBar, closeTab, pruneStale, touchTab, urlsOnBar, type BarItem, type OpenTab } from './panelTabs';
import { useLiveSessions } from './useLiveSessions';
import { urlForIntent } from './panelIntents';
import { useTabSets } from './useTabSets';
import styles from './TabBar.module.css';

/**
 * TabBar.tsx — the row across the top of a panel: what's pinned, what's alive,
 * and what she has open.
 *
 * THREE GROUPS, always in this order so nothing moves around under her:
 *
 *   ANCHORS  the pinned sections of this panel's set. Always there.
 *   LIVE     sessions working now, or stopped and waiting on her. They appear
 *            on their own and leave on their own.
 *   OPEN     what she opened, for as long as she keeps using it.
 *
 * AN ANCHOR ALWAYS SAYS ITS OWN NAME, and clicking it always goes to that
 * room's front page. It used to rename itself to whatever she was looking at
 * inside the section — which made sense when tabs were only destinations, and
 * stopped making sense the moment open tabs existed: opening a session left
 * the Observatory anchor reading the session's name while the session ALSO had
 * its own tab beside it, saying the same thing twice and leaving nothing to
 * click to get back to the roster.
 *
 * So the division is clean. The anchor is the room's front door. The tabs
 * beside it are what's actually open in that room, and one of those is what
 * says where she is.
 *
 * THE LIVE COLOURS. A running session is purple and breathes toward teal and
 * back; one waiting on her is amber and still. They sit in the same group,
 * because both are "something is happening here" — only the colour says which,
 * so a session changing state doesn't make the bar reshuffle. The breathing is
 * on the underline and a dot rather than the label: a name that changes colour
 * continuously is harder to read, and reading which session it is was the
 * whole point. Every pulse shares one clock (see the stylesheet) so several
 * running sessions breathe together instead of flickering out of phase.
 *
 * WHAT DROPS OFF. An open tab she hasn't touched in an hour leaves the bar.
 * It does not end the session and the session stays in the Observatory — the
 * tab is a view, and only the view goes.
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
 * Touches: panelTabs.ts (what belongs on the bar), useLiveSessions.ts (the
 * live feed), sections.ts (what a tab means), tabSets.ts (create/remove/pin/
 * unpin/reorder), PanelFrame.tsx (draws this in the header row).
 *
 * Prompt that produced it: "i want tabs for open and running both. i want the
 * running ones to be purple but glow teal back and forth... the open ones that
 * have been used in the past hour to also display... anything that i've been
 * ignoring just drops from the tabs until i interact with it again. it doesn't
 * close in the observatory, just in the tabs up top."
 */

/** Stable empty list — a fresh [] each render would re-run the bar memo and
 *  the prune effect on every poll for a panel that shows no sessions. */
const EMPTY_LIVE: ReturnType<typeof useLiveSessions> = [];

export function TabBar({
  url,
  setId,
  openTabs,
  onSetId,
  onOpenTabs,
  onNavigate,
}: {
  /** Where this panel currently is. */
  url: string;
  setId: string;
  openTabs: OpenTab[];
  onSetId: (setId: string) => void;
  onOpenTabs: (next: OpenTab[]) => void;
  onNavigate: (url: string) => void;
}) {
  const { sets, save } = useTabSets();
  const liveSessions = useLiveSessions();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
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

  const activeIndex = Math.max(0, sets.findIndex((s) => s.id === setId));
  const active = sets[activeIndex];
  const activeSetId = active?.id ?? '';
  const anchors = useMemo(() => sectionsOf(sets, activeSetId), [sets, activeSetId]);
  const here = sectionForUrl(url);

  const liveUrlFor = (convId: string) => urlForIntent({ kind: 'conversation', convId }) ?? '/observatory';

  /* Live sessions belong to the panel that's ABOUT the observatory — the one
     with it pinned. Showing them on every bar sounds generous and isn't: the
     other panel's own anchors get squeezed until they truncate, to make room
     for work it has nothing to do with.

     Pinning the OBSERVATORY opts a panel in; pinning the Keeper does not. The
     Keeper is a shortcut to one particular conversation, and wanting that one
     to hand isn't the same as wanting every session in the house on your
     journal bar. */
  const watchesSessions = useMemo(() => anchors.some((a) => a.id === 'observatory'), [anchors]);
  const live = watchesSessions ? liveSessions : EMPTY_LIVE;

  // Rebuilt on every roster poll, which is what makes a starting session
  // appear without anything being told about it.
  const bar = useMemo(
    () =>
      buildBar({
        anchors: anchors.map((a) => a.id),
        live,
        open: openTabs,
        now: Date.now(),
        liveUrlFor,
      }),
    [anchors, live, openTabs],
  );

  /* She's here, so this isn't being ignored — restart its hour, and sweep off
     anything that has been. The page in front of her and everything currently
     live are spared whatever their age. */
  const onOpenTabsRef = useRef(onOpenTabs);
  onOpenTabsRef.current = onOpenTabs;
  const spared = useMemo(() => new Set([url, ...urlsOnBar(bar)]), [url, bar]);
  useEffect(() => {
    const now = Date.now();
    const kept = pruneStale(touchTab(openTabs, url, now), now, spared);
    if (kept !== openTabs) onOpenTabsRef.current(kept);
    // Deliberately keyed on the url and the tab list, not on a timer: the
    // sweep happens when she moves, which is the only moment the answer can
    // change in a way she'd notice.
  }, [url, openTabs, spared]);

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
          className={styles.menuBtn}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title={`Set ${activeIndex + 1} — switch set, or pin a tab`}
          aria-label="Switch tab set or pin a tab"
        >
          <span className={styles.setNum}>{activeIndex + 1}</span>
          <span aria-hidden="true">&#9662;</span>
        </button>
        {menuOpen ? (
          <div className={styles.menu} role="menu">
            <div className={styles.groupLabel}>Sets</div>
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

            <div className={styles.groupLabel}>Go, or pin to set {activeIndex + 1}</div>
            {menuSections().map((section) => {
              const isOn = isPinned(sets, activeSetId, section.id);
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
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Panel tabs">
        {bar.map((item, i) => (
          <Tab
            key={item.kind === 'anchor' ? `a:${item.sectionId}` : item.url}
            item={item}
            index={i}
            currentUrl={url}
            titleFor={titleFor}
            drag={drag}
            onDrag={setDrag}
            onGoSection={goToSection}
            onGoUrl={onNavigate}
            onCloseOpen={(u) => onOpenTabs(closeTab(openTabs, u))}
            onReorderAnchors={(from, to) => save(reorder(sets, activeSetId, from, to))}
            anchorCount={anchors.length}
          />
        ))}
        {visiting ? (
          <div className={styles.tabWrap} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected
              className={[styles.tab, styles.tabActive, styles.tabVisiting].join(' ')}
              title={`${here?.label} — not pinned to set ${activeIndex + 1}. Use the ▾ to pin it.`}
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

/** One tab. Split out because an anchor, a live session and an open page share
 *  a shape but almost nothing else. */
function Tab({
  item,
  index,
  currentUrl,
  titleFor,
  drag,
  onDrag,
  onGoSection,
  onGoUrl,
  onCloseOpen,
  onReorderAnchors,
  anchorCount,
}: {
  item: BarItem;
  index: number;
  currentUrl: string;
  titleFor: (url: string) => string;
  drag: { from: number; over: number } | null;
  onDrag: (d: { from: number; over: number } | null) => void;
  onGoSection: (s: Section) => void;
  onGoUrl: (url: string) => void;
  onCloseOpen: (url: string) => void;
  onReorderAnchors: (from: number, to: number) => void;
  anchorCount: number;
}) {
  const isAnchor = item.kind === 'anchor';
  const section = isAnchor ? sectionById(item.sectionId) : null;
  if (isAnchor && !section) return null;

  const url = isAnchor ? section!.home : item.url;
  /* Exactly one tab is lit. An anchor lights only while she's on its front
     page, not anywhere in its section — otherwise reading a session lit both
     the Observatory anchor and the session's own tab at once. */
  const selected = isAnchor ? pathOf(currentUrl) === pathOf(url) : currentUrl === url;

  const label = isAnchor ? section!.label : item.kind === 'live' ? item.title : titleFor(url);

  const running = item.kind === 'live' && item.running && !item.awaiting;
  const awaiting = item.kind === 'live' && item.awaiting;

  return (
    <div
      role="presentation"
      className={[
        styles.tabWrap,
        drag?.over === index && drag.from !== index ? styles.tabDropTarget : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // Only anchors reorder — the live group is ordered by the roster and the
      // open group by when she opened things, neither of which is hers to drag.
      draggable={isAnchor}
      onDragStart={() => isAnchor && onDrag({ from: index, over: index })}
      onDragOver={(e) => {
        if (!isAnchor) return;
        e.preventDefault(); // without this the drop never fires
        if (drag && drag.over !== index) onDrag({ ...drag, over: index });
      }}
      onDrop={() => {
        if (drag && isAnchor && index < anchorCount) onReorderAnchors(drag.from, index);
        onDrag(null);
      }}
      onDragEnd={() => onDrag(null)}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
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
        onClick={() => (isAnchor ? onGoSection(section!) : onGoUrl(url))}
      >
        {running || awaiting ? (
          <span className={running ? styles.dotRunning : styles.dotAwaiting} aria-hidden="true" />
        ) : (
          <span className={styles.icon}>{isAnchor ? section!.icon : '◈'}</span>
        )}
        <span className={styles.tabLabel}>{label}</span>
      </button>
      {/* Only the open ones close. An anchor is unpinned from the ▾, and a live
          session isn't hers to dismiss — it leaves when it stops. */}
      {item.kind === 'open' ? (
        <button
          type="button"
          className={styles.close}
          title={`Close ${label}`}
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
