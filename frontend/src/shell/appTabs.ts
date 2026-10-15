import { ALL_SECTIONS, type Section } from './panels/sections';
import { BASED_FOODS, basedFoodsUrl, type AppDef, type TabPlace } from './apps';

/**
 * appTabs.ts — an app's tabs, turned from ids in apps.json into things the
 * strip can draw.
 *
 * Each tab in apps.json names a section (panels/sections.ts), which already
 * knows its label, glyph and front page — so the phone strip (TopTabs.tsx)
 * and a desktop pane wearing the app (panels/tabSets.ts) draw the same tabs
 * from one place. One tab is not a section: 'based-foods', the link out to
 * Based Foods, which is drawn only when this install has its address
 * (config.based_foods_url) and leaves the site when tapped.
 *
 * Its own file, not part of apps.ts, because sections.ts can't be imported
 * there without a loop (see the note in apps.ts).
 */

export type AppTabItem =
  | { kind: 'section'; section: Section; place: TabPlace }
  | { kind: 'link'; id: string; label: string; icon: string; href: string; place: TabPlace };

/** An app's tabs in order, with any id that names nothing — or the Based
 * Foods link on an install without its address — left out. */
export function appTabs(app: AppDef, foodsUrl: string = basedFoodsUrl()): AppTabItem[] {
  const items: AppTabItem[] = [];
  for (const tab of app.tabs) {
    if (tab.section === 'based-foods') {
      if (foodsUrl) {
        items.push({ kind: 'link', id: 'based-foods', label: `${BASED_FOODS.name} ↗`, icon: BASED_FOODS.glyph, href: foodsUrl, place: tab.place });
      }
      continue;
    }
    const section = ALL_SECTIONS.find((candidate) => candidate.id === tab.section);
    if (section) items.push({ kind: 'section', section, place: tab.place });
  }
  return items;
}

/** The section ids an app's tabs name, in order — what its tab set holds. */
export function appSectionIds(app: AppDef): string[] {
  return app.tabs.map((tab) => tab.section).filter((id) => ALL_SECTIONS.some((section) => section.id === id));
}
