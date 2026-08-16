import { useEffect, useRef, useState } from 'react';
import { useSessionRoster } from '../../features/observatory/api';
import { convIdOf, pageLabel, sectionForUrl, type Section } from './sections';
import { isPinned, menuSections, pin, reorder, sectionsOf, unpin } from './tabSets';
import { useTabSets } from './useTabSets';
import styles from './TabBar.module.css';

/**
 * TabBar.tsx — the row of tabs across the top of a panel, and the one control
 * that changes what's in it.
 *
 * THE RULE, which is the whole design: a tab names its SECTION, except the one
 * you're currently inside, which names what you're actually looking at — the
 * session's title, the file's name. Clicking that active tab takes you back up
 * to the section's front page. Clicking any other tab goes to that section,
 * returning you to wherever you last were in it rather than resetting.
 *
 * So one control does three jobs: it labels, it shows you where you are, and
 * it's the way back up.
 *
 * THE DROPDOWN at the left end is deliberately the only chrome added, because
 * it carries both of the things she actually needs: switch this panel's whole
 * bar to the other set, and pin or unpin any section. Pinning is a click on a
 * star, not a drag out of the menu — it's something you do a handful of times
 * ever, and a drag is the most expensive gesture to build for the rarest
 * action. Dragging is kept for REORDERING, inside the bar, where it's cheap
 * (one strip, both ends visible) and where it genuinely beats clicking.
 *
 * WHICH SET this panel wears is per window, stored with the layout, because
 * that's the point of two sets — the monitor running sessions and the monitor
 * running the journal want different bars. The sets themselves are shared
 * (useTabSets.ts).
 *
 * Touches: sections.ts (what a tab means), tabSets.ts (the operations),
 * useTabSets.ts (load/save), PanelFrame.tsx (draws this in the header row).
 *
 * Prompt that produced it: "i want like any given session to show the tab at
 * the top and clicking that tab takes you back to the front page for that
 * route... you can pin other tabs up there on any given window... maybe there
 * is the little dropdown menu on the left, and i can drag and drop tabs out
 * onto the top so they stick up on the top tabs".
 */

export function TabBar({
  url,
  setId,
  onSetId,
  onNavigate,
}: {
  /** Where this panel currently is. */
  url: string;
  /** Which set this panel wears. */
  setId: string;
  onSetId: (setId: string) => void;
  onNavigate: (url: string) => void;
}) {
  const { sets, save } = useTabSets();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Which tab is being dragged, and which gap it's hovering, so the bar can
  // show where it would land before the pointer is released.
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  const active = sets.find((s) => s.id === setId) ?? sets[0];
  const activeSetId = active?.id ?? '';
  const pinned = sectionsOf(sets, activeSetId);
  const here = sectionForUrl(url);

  /**
   * Where you are always has a tab, even when it isn't pinned to this set.
   *
   * Switch a panel to the other set and the section you're standing in usually
   * isn't in it — which would leave the bar with nothing lit and no name for
   * the page you're looking at, breaking the one rule the whole bar runs on.
   * So an unpinned section you're actually in gets a tab at the end, marked as
   * a visitor. It behaves like any other active tab (clicking goes back up),
   * and it disappears the moment you leave.
   */
  const visiting = here && !pinned.some((s) => s.id === here.id) ? here : null;
  const tabs = visiting ? [...pinned, visiting] : pinned;

  // A conversation's real title, from the roster query the app already keeps
  // warm — the URL only carries an opaque id, so without this the tab for an
  // open session would just read "Session".
  const convId = convIdOf(url);
  const { data: roster } = useSessionRoster();
  const convTitle = convId ? roster?.sessions.find((s) => s.id === convId)?.title : undefined;

  // Where she last was in each section, so an inactive tab returns her there
  // instead of resetting. Per panel and deliberately not persisted: it's a
  // "carry on where I was" convenience within a sitting, not a saved place.
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

  const labelFor = (section: Section): string => {
    if (here?.id !== section.id) return section.label;
    // The active tab wears where she actually is.
    return convTitle ?? pageLabel(url);
  };

  const goTo = (section: Section) => {
    if (here?.id === section.id) {
      onNavigate(section.home); // already here — this is the way back up
      return;
    }
    onNavigate(lastSeen.current[section.id] ?? section.home);
  };

  return (
    <div className={styles.bar}>
      <div className={styles.menuWrap} ref={menuRef}>
        <button
          type="button"
          className={styles.menuBtn}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title={active ? `${active.name} — switch set, or pin a tab` : 'Tabs'}
          aria-label="Switch tab set or pin a tab"
        >
          &#9662;
        </button>
        {menuOpen ? (
          <div className={styles.menu} role="menu">
            <div className={styles.groupLabel}>Sets</div>
            {sets.map((s) => (
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
                {s.name}
                <span className={styles.setPreview}>
                  {sectionsOf(sets, s.id).map((x) => x.label).join(' · ') || 'empty'}
                </span>
              </button>
            ))}

            <div className={styles.groupLabel}>Go, or pin to {active?.name ?? 'this set'}</div>
            {menuSections().map((section) => {
              const isOn = isPinned(sets, activeSetId, section.id);
              return (
                <div key={section.id} className={styles.menuRow}>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      goTo(section);
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
                    title={isOn ? `Unpin from ${active?.name}` : `Pin to ${active?.name}`}
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
        {tabs.map((section, i) => {
          const isHere = here?.id === section.id;
          // The visiting tab isn't in the set, so there's nothing to take out
          // of it — it leaves on its own when you go elsewhere.
          const closable = section !== visiting;
          return (
            /* The × has to be a real button, and HTML won't nest one inside
               another — so it's a sibling laid over the tab's right edge
               rather than a child of it. The wrapper is presentational so the
               tablist still sees `role="tab"` directly beneath it, and it
               carries the drag because the whole tab is what moves. */
            <div
              key={section.id}
              role="presentation"
              className={[
                styles.tabWrap,
                drag?.over === i && drag.from !== i ? styles.tabDropTarget : '',
              ]
                .filter(Boolean)
                .join(' ')}
              draggable={closable}
              onDragStart={() => closable && setDrag({ from: i, over: i })}
              onDragOver={(e) => {
                e.preventDefault(); // without this the drop never fires
                setDrag((d) => (d && d.over !== i ? { ...d, over: i } : d));
              }}
              onDrop={() => {
                // Dropping onto the visiting tab would aim at a slot the set
                // doesn't have; reorder ignores it, but don't even ask.
                if (drag && closable) save(reorder(sets, activeSetId, drag.from, i));
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isHere}
                className={[
                  styles.tab,
                  isHere ? styles.tabActive : '',
                  section === visiting ? styles.tabVisiting : '',
                  closable ? styles.tabClosable : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                title={
                  section === visiting
                    ? `${section.label} — not pinned to ${active?.name}. Use the ▾ to pin it.`
                    : isHere
                      ? `Back to ${section.label}`
                      : section.label
                }
                onClick={() => goTo(section)}
              >
                <span className={styles.icon}>{section.icon}</span>
                <span className={styles.tabLabel}>{labelFor(section)}</span>
              </button>
              {closable ? (
                <button
                  type="button"
                  className={styles.close}
                  title={`Remove ${section.label} from ${active?.name}`}
                  aria-label={`Remove ${section.label} from ${active?.name}`}
                  onClick={(e) => {
                    // The × sits on top of the tab; without this the click
                    // would also navigate to the tab being removed.
                    e.stopPropagation();
                    save(unpin(sets, activeSetId, section.id));
                  }}
                >
                  &#10005;
                </button>
              ) : null}
            </div>
          );
        })}
        {tabs.length === 0 ? (
          <span className={styles.empty}>No tabs pinned — use the ▾ to add some</span>
        ) : null}
      </div>
    </div>
  );
}
