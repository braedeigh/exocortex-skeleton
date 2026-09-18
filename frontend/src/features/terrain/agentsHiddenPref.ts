import { makeStickyToggle } from './codeHeatPref';

/**
 * agentsHiddenPref.ts — the map's "hide agents" switch: whether the terrain
 * draws any agents at all. On, the map is files only — no orbs, no tethers,
 * no read/write rings, no agent names.
 *
 * A toggle that stays — the same pattern, and the same code, as the
 * red-edits and gold-ran switches in codeHeatPref.ts: kept in localStorage so
 * it survives a reload, and shared by every terrain open in any panel or tab.
 * Off unless she turns it on; agents are part of the map's normal view.
 *
 * The Hide / Show buttons live in TerrainAgentBar.tsx; TerrainPage.tsx reads
 * the value and empties its shown-agents list while it's on, which is the one
 * list everything agent-related on the map already follows.
 *
 * Prompt that produced it: "make it possible to hide agents".
 */
const hiddenToggle = makeStickyToggle('terrain-agents-hidden');
export const setAgentsHiddenOn = hiddenToggle.set;
export const useAgentsHiddenOn = hiddenToggle.useOn;
