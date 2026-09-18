import { makeStickyToggle } from './codeHeatPref';

/**
 * typeColorPref.ts — the map's "Types" switch: whether file dots are painted
 * by file type (GitHub's colours, fileTypes.ts) instead of by heat.
 *
 * A toggle that stays — the same pattern, and the same code, as the red-edits
 * and gold-ran switches in codeHeatPref.ts: kept in localStorage so it
 * survives a reload, and shared by every terrain open in any panel or tab.
 * Off unless she turns it on; heat is the map's normal lighting.
 *
 * The button lives in TerrainHeatBar.tsx; TerrainPage.tsx reads the value and
 * hands it to the canvas (terrainCanvas.ts setTypeColors).
 *
 * Prompt that produced it: "a toggle that overrides the other colors when i
 * toggle it on".
 */
const typesToggle = makeStickyToggle('terrain-type-colors');
export const setTypeColorsOn = typesToggle.set;
export const useTypeColorsOn = typesToggle.useOn;
