import { describe, expect, it } from 'vitest';
import { APPS, appAllows, appById, appFromSearch, appOfSet, appOwning, appSetId } from './apps';
import { appSectionIds, appTabs } from './appTabs';
import { ALL_SECTIONS, sectionForUrl } from './panels/sections';
import { TAB_ROUTES, VALID_TABS } from './tabs';

const journal = appById('journal')!;
const observatory = appById('observatory')!;

describe('which app holds a page', () => {
  it('gives every page to the app whose prefix is longest', () => {
    expect(appOwning('/journal')?.id).toBe('journal');
    expect(appOwning('/todos/editor')?.id).toBe('journal');
    expect(appOwning('/person/someone')?.id).toBe('journal');
    expect(appOwning('/observatory/archive')?.id).toBe('observatory');
    expect(appOwning('/terrain/files')?.id).toBe('observatory');
    // The Pond is the Journal's though the rest of /terrain is the Observatory's.
    expect(appOwning('/terrain/pond')?.id).toBe('journal');
    expect(appOwning('/money')?.id).toBe('finances');
    expect(appOwning('/inventory')?.id).toBe('inventory');
  });

  it('gives the Food area and the kitchen to no app — they are bound for Based Foods', () => {
    for (const url of ['/kitchen', '/food', '/food/foods/kale', '/food-map', '/share/recipes']) {
      expect(appOwning(url), url).toBeNull();
    }
  });

  it('is not fooled by a path that merely starts the same way', () => {
    expect(appOwning('/journalling')).toBeNull();
    expect(appOwning('/moneybags')).toBeNull();
  });
});

describe('which pages an app shows in its own shell', () => {
  it('shows its own pages and the shared ones in every app', () => {
    for (const app of APPS) {
      expect(appAllows(app.start, app), app.id).toBe(true);
      expect(appAllows('/settings', app), app.id).toBe(true);
      expect(appAllows('/code?repo=skeleton&path=a.py', app), app.id).toBe(true);
    }
  });

  it('opens another app’s pages bare rather than as its own', () => {
    expect(appAllows('/terrain/files', journal)).toBe(false);
    expect(appAllows('/terrain/pond', observatory)).toBe(false);
    expect(appAllows('/journal', observatory)).toBe(false);
    expect(appAllows('/kitchen', journal)).toBe(false);
  });

  it('lets the Journal borrow the session list and a session, and nothing else of the Observatory', () => {
    expect(appAllows('/observatory', journal)).toBe(true);
    expect(appAllows('/observatory/session?conv=latest', journal)).toBe(true);
    expect(appAllows('/observatory/archive', journal)).toBe(false);
    expect(appAllows('/observatory/nightcrew', journal)).toBe(false);
  });
});

describe('which app a window or pane is', () => {
  it('reads ?app= and ignores an id that names no app', () => {
    expect(appFromSearch('?app=journal')?.id).toBe('journal');
    expect(appFromSearch('?conv=x&app=finances')?.id).toBe('finances');
    expect(appFromSearch('?app=nonsense')).toBeNull();
    expect(appFromSearch('')).toBeNull();
  });

  it('knows an app’s tab set from one of her own', () => {
    expect(appOfSet(appSetId('inventory'))?.id).toBe('inventory');
    expect(appOfSet('work')).toBeNull();
    expect(appOfSet('app:nonsense')).toBeNull();
    expect(appOfSet(undefined)).toBeNull();
  });
});

describe('an app’s tabs', () => {
  it('name only sections that exist, and each opens a page its app shows', () => {
    const ids = new Set(ALL_SECTIONS.map((section) => section.id));
    for (const app of APPS) {
      for (const tab of app.tabs) {
        if (tab.section !== 'based-foods') expect(ids.has(tab.section), `${app.id}: ${tab.section}`).toBe(true);
      }
      for (const item of appTabs(app, '')) {
        if (item.kind === 'section') expect(appAllows(item.section.home, app), `${app.id}: ${item.section.id}`).toBe(true);
      }
    }
  });

  it('puts the Journal’s four first, in her order', () => {
    expect(appSectionIds(journal).slice(0, 4)).toEqual(['journal', 'todos', 'keeper', 'sessions']);
    expect(appTabs(journal, '').filter((item) => item.place === 'bar').length).toBe(4);
  });

  it('draws the Based Foods link only where the install has its address', () => {
    expect(appTabs(journal, '').some((item) => item.kind === 'link')).toBe(false);
    const link = appTabs(journal, 'https://foods.example').find((item) => item.kind === 'link');
    expect(link && link.kind === 'link' ? link.href : null).toBe('https://foods.example');
  });

  it('lights the app’s own tab for a page the Dashboard also claims', () => {
    // On her own sets every dashboard route is still the one Dashboard…
    for (const tab of VALID_TABS) expect(sectionForUrl(TAB_ROUTES[tab])?.id).not.toBe('todos');
    expect(sectionForUrl('/todos')?.id).toBe('dashboard');
    // …and on the Journal's bar /todos and /map are its own tabs.
    expect(sectionForUrl('/todos', appSectionIds(journal))?.id).toBe('todos');
    expect(sectionForUrl('/map', appSectionIds(journal))?.id).toBe('map');
    expect(sectionForUrl('/person/someone', appSectionIds(journal))?.id).toBe('people');
  });
});
