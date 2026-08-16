import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionRoster } from '../../features/observatory/api';
import { convIdOf, pageLabel, sectionForUrl, sectionById, type Section } from './sections';
import { isPinned, menuSections, pin, reorder, sectionsOf, unpin } from './tabSets';
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
 * A tab names its section, except the one she's inside, which names what she's
 * actually looking at. Clicking the active anchor takes her back up to that
 * section's front page; clicking another goes where she last was in it.
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
 * Touches: panelTabs.ts (what belongs on the bar), useLiveSessions.ts (the
 * live feed), sections.ts (what a tab means), tabSets.ts (pin/unpin/reorder),
 * PanelFrame.tsx (draws this in the header row).
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

  const activeIndex = Math.max(0, sets.findIndex((s) => s.id === setId));
  const active = sets[activeIndex];
  const activeSetId = active?.id ?? '';
  const anchors = useMemo(() => sectionsOf(sets, activeSetId), [sets, activeSetId]);
  const here = sectionForUrl(url);

  const liveUrlFor = (convId: string) => urlForIntent({ kind: 'conversation', convId }) ?? '/observatory';

  /* Live sessions belong to the panel that's ABOUT the observatory — the one
     with it pinned. Showing them on every bar sounds generous and isn't: the
     journal panel's own anchors get squeezed until they truncate, to make room
     for work that panel has nothing to do with. Pinning the Observatory (or
     the Keeper, which lives inside it) is what opts a panel in. */
  const watchesSessions = useMemo(
    () => anchors.some((a) => a.id === 'observatory' || a.id === 'keeper'),
    [anchors],
  );
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

  // A conversation's real title, from the roster the app already keeps warm —
  // the url carries only an opaque id.
  const convId = convIdOf(url);
  const { data: roster } = useSessionRoster();
  const convTitle = convId ? roster?.sessions.find((s) => s.id === convId)?.title : undefined;

  const lastSeen = useRef<Record<string, string>>({});
  useEffect(() => {
    if (here) lastSeen.current[here.id] = url;
  }, [here, url]);

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

  const goToSection = (section: Section) => {
    if (here?.id === section.id) {
      onNavigate(section.home); // already here — this is the way back up
      return;
    }
    onNavigate(lastSeen.current[section.id] ?? section.home);
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
            {sets.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={s.id === activeSetId}
                className={styles.menuItem}
                onClick={() => {
                  onSetId(s.id);
                  setMenuOpen(false);
                }}
              >
                <span className={styles.radio}>{s.id === activeSetId ? '●' : '○'}</span>
                {i + 1}
                <span className={styles.setPreview}>
                  {sectionsOf(sets, s.id).map((x) => x.label).join(' · ') || 'empty'}
                </span>
              </button>
            ))}

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
            here={here}
            convTitle={convTitle}
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
              <span className={styles.tabLabel}>{convTitle ?? pageLabel(url)}</span>
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
  here,
  convTitle,
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
  here: Section | null;
  convTitle?: string;
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
  const selected = isAnchor ? here?.id === section!.id : currentUrl === url;

  const label = isAnchor
    ? here?.id === section!.id
      ? (convTitle ?? pageLabel(currentUrl))
      : section!.label
    : item.kind === 'live'
      ? item.title
      : pageLabel(url);

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
