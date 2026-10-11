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
 * hands it to the canvas (terrainCanvas.ts setTypeColors). Heat isn't gone
 * under it, only its hues: it still sets each dot's size, and how much of the
 * type colour is left, so stale files fade into the sky (staleTypeColor) and
 * the lines into them fade halfway with them (staleTypeAlpha). Folder outlines
 * follow the toggle too: on, a hollow folder's border is split between the
 * file types beneath it (folderTypes.ts) instead of showing its own heat, and
 * a folder with nothing live inside fades out along with its files.
 *
 * Prompts that produced it: "a toggle that overrides the other colors when i
 * toggle it on" → "i want to hide stale files … the dots turn black or
 * disappear when i am on the 'types' display" → "the lines that go to the
 * dots faded too … maybe like 50% opacity".
 */
const typesToggle = makeStickyToggle('terrain-type-colors');
export const setTypeColorsOn = typesToggle.set;
export const useTypeColorsOn = typesToggle.useOn;
