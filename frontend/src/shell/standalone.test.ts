import { describe, expect, it } from 'vitest';
import {
  SETUP_PATH,
  STANDALONE_LEAVES_OUT,
  STANDALONE_SECTION_IDS,
  standaloneAllows,
  standaloneRedirect,
  standaloneSectionIds,
} from './standalone';
import { ALL_SECTIONS, sectionsFor } from './panels/sections';
import { defaultSetsFor } from './panels/tabSets';
import { TAB_ROUTES, VALID_TABS, VIEW_META } from './tabs';
import { agentSectionsFor } from '../features/terrain/TerrainAgentBar';

describe('which pages the desktop app holds', () => {
  it('keeps the Observatory, Terrain, and the pages they open', () => {
    for (const url of [
      '/observatory',
      '/observatory/session?conv=2026-10-06.205806',
      '/observatory/archive',
      '/observatory/tree',
      '/observatory/burn',
      '/observatory/swarm/28',
      '/terrain',
      '/terrain/files',
      '/terrain/map',
      '/terrain/sql',
      '/code?repo=skeleton&path=server.py',
      '/sql',
      SETUP_PATH,
    ]) {
      expect(standaloneAllows(url), url).toBe(true);
    }
  });

  it('holds none of the rest of the site', () => {
    // Every dashboard tab and every More-menu view: the whole reachable site
    // outside the two kept parts, read from the lists the tab strip draws.
    const rest = [...VALID_TABS.map((tab) => TAB_ROUTES[tab]), ...VIEW_META.map((view) => view.to)];
    for (const url of [...rest, '/', '/chat', '/sessions', '/wiki', '/threads', '/person/someone', '/login']) {
      expect(standaloneAllows(url), url).toBe(false);
    }
  });

  it('leaves out the rooms only the owner’s install has, and the pages under them', () => {
    for (const left of STANDALONE_LEAVES_OUT) {
      expect(standaloneAllows(left), left).toBe(false);
      expect(standaloneAllows(`${left}/anything?x=1`), left).toBe(false);
    }
  });

  it('does not mistake a longer name for a kept part', () => {
    expect(standaloneAllows('/codex')).toBe(false);
    expect(standaloneAllows('/terrainium')).toBe(false);
    expect(standaloneAllows('/observatory/linearity')).toBe(true);
  });
});

describe('the journal, which the desktop app holds only when its server offers it', () => {
  it('does not exist until the server names it', () => {
    expect(standaloneAllows('/journal', [])).toBe(false);
    expect(standaloneRedirect('/journal', true, [])).toBe('/terrain/files');
    expect(sectionsFor(true, standaloneSectionIds([])).map((section) => section.id)).not.toContain('journal');
  });

  it('is a kept page with its own tab once the server names it', () => {
    expect(standaloneAllows('/journal', ['journal'])).toBe(true);
    // The journal's cards link to their threads, so that page comes with it.
    expect(standaloneAllows('/threads/some-thread', ['journal'])).toBe(true);
    expect(standaloneAllows('/threads', [])).toBe(false);
    expect(standaloneRedirect('/journal', true, ['journal'])).toBeNull();
    const ids = sectionsFor(true, standaloneSectionIds(['journal'])).map((section) => section.id);
    expect(ids).toContain('journal');
    // Setup stays last, and nothing else of the site comes along with it.
    expect(ids[ids.length - 1]).toBe('setup');
    expect(standaloneAllows('/todos', ['journal'])).toBe(false);
  });

  it('brings Terrain’s Pond with it, and still leaves the Creek out', () => {
    expect(standaloneAllows('/terrain/pond', [])).toBe(false);
    expect(standaloneAllows('/terrain/pond', ['journal'])).toBe(true);
    expect(standaloneRedirect('/terrain/pond', true, ['journal'])).toBeNull();
    expect(standaloneAllows('/terrain/creek', ['journal'])).toBe(false);
  });

  it('ignores a part name it does not know', () => {
    expect(standaloneAllows('/todos', ['dashboard', 'everything'])).toBe(false);
    expect(standaloneSectionIds(['everything'])).toEqual([...STANDALONE_SECTION_IDS]);
  });
});

describe('where the desktop app sends a page it does not hold', () => {
  it('lets a kept page through', () => {
    expect(standaloneRedirect('/terrain/files', true)).toBeNull();
    expect(standaloneRedirect('/observatory', false)).toBeNull();
  });

  it('opens a wide window on the map, beside the workspace’s Observatory panel', () => {
    expect(standaloneRedirect('/', true)).toBe('/terrain/files');
    expect(standaloneRedirect('/todos', true)).toBe('/terrain/files');
  });

  it('opens a narrow window on the sessions', () => {
    expect(standaloneRedirect('/', false)).toBe('/observatory');
    expect(standaloneRedirect('/terrain/pond', false)).toBe('/observatory');
  });

  it('never sends anyone somewhere it would send them away from again', () => {
    for (const wide of [true, false]) {
      const home = standaloneRedirect('/journal', wide);
      expect(home && standaloneRedirect(home, wide)).toBeNull();
    }
  });
});

describe('the desktop tab bar', () => {
  const desktop = sectionsFor(true, standaloneSectionIds([]));
  const site = sectionsFor(false);

  it('offers exactly the listed sections, and every one opens a page the app holds', () => {
    expect(desktop.map((section) => section.id)).toEqual([...STANDALONE_SECTION_IDS]);
    for (const section of desktop) {
      expect(standaloneAllows(section.home), section.id).toBe(true);
    }
  });

  it('offers nothing of the owner’s own: no Keeper, journal, dashboard or settings', () => {
    const ids = desktop.map((section) => section.id);
    for (const hers of ['keeper', 'journal', 'dashboard', 'research', 'pond', 'settings', 'ecosystem']) {
      expect(ids).not.toContain(hers);
    }
  });

  it('leaves the normal site’s sections exactly as they were, with no Setup tab', () => {
    expect(site).toEqual(ALL_SECTIONS.filter((section) => section.id !== 'setup'));
    expect(site.length).toBe(ALL_SECTIONS.length - 1);
  });

  it('starts with tab sets whose every tab exists in the desktop app', () => {
    const ids = new Set(desktop.map((section) => section.id));
    const sets = defaultSetsFor(true);
    // The workspace's opening arrangement names these two ids (panelStore.ts).
    expect(sets.map((set) => set.id)).toEqual(expect.arrayContaining(['work', 'life']));
    for (const set of sets) {
      for (const sectionId of set.sections) expect(ids.has(sectionId), sectionId).toBe(true);
    }
    expect(sets.find((set) => set.id === 'life')?.sections.length).toBeGreaterThan(0);
  });
});

describe('the map\'s agent filter in the desktop app', () => {
  it('offers the person\'s own rooms, by their own names, and none of the owner\'s', () => {
    const rooms = [
      { id: 'personal', name: 'Home' },
      { id: 'room-3', name: 'Experiments' },
    ];
    expect(agentSectionsFor(true, rooms)).toEqual([
      { id: '', label: 'All' },
      { id: 'personal', label: 'Home' },
      { id: 'room-3', label: 'Experiments' },
    ]);
    // The site still reaches every room a session can be in.
    const site = agentSectionsFor(false, rooms).map((choice) => choice.id);
    for (const room of ['research', 'linear', 'orchestra']) expect(site, room).toContain(room);
  });
});
