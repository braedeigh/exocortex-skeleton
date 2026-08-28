/**
 * pondNodes.ts — the journal, collapsed from a thousand anonymous dots into
 * ONE body on the map: the pond tile.
 *
 * THE PROBLEM THIS SOLVES. The card pool is one markdown file per utterance,
 * so on a map that draws a dot per file the journal arrives as ~1,700
 * identical dots in a starburst — the largest single structure on the terrain,
 * and it says nothing. You cannot read "March was quiet" or "this week was
 * heavy" off it, because every card looks like every other card.
 *
 * So the card files are swapped, before the graph is ever built, for a single
 * synthetic file: the tile. It carries the last month of the journal bucketed
 * per day (`days`, oldest first), and the canvas draws it as a small square of
 * water — one column per day, lit by the same heat math as everything else on
 * the map. A month is the window on purpose: the backdrop's breath swells its
 * heat lens from a one-day half-life out to a one-month one, so a month of
 * water is exactly the stretch the breath can visibly move through.
 *
 * The tile is one node, so it is one BODY: it gets a collision radius in the
 * force sim and the rest of the terrain bumps around it instead of being
 * covered by a floating overlay.
 *
 * WHERE THE MONTH'S NUMBERS COME FROM. The payload carries `pond_days`: one
 * dense row per day for the last month, counted in the journal's own card
 * table (routes/terrain.py `_pond_days`). The tile uses that when it's there.
 *
 * It does NOT count the card files in the payload, which is the obvious thing
 * and is wrong: `repos[].files` is cut to the hottest N per repo, so most of
 * the pool never arrives. Measured on this vault, that cut left 265 of 2,240
 * cards — every day drew short, the heaviest day of the month drew as a stub,
 * and three days she had written on drew as bare water. Counting the files
 * still happens as a FALLBACK, for an install with no journal mirror, and it
 * is honest about being second best.
 *
 * A card's filename is enough for that fallback on its own — `2026-08-21.2232b.md`
 * is day, time, and speaker (`b` = the owner, `k` = the Keeper) — so no matter
 * which source is used, nothing here fetches anything.
 *
 * WHERE IT SITS. Between the payload and `buildTerrainGraph` — this returns a
 * new TerrainData with the card files replaced, so the trie, the heat maths,
 * the repo chips, the dials and the renderer all keep working untouched. The
 * tile's path stays under the real `tulku/_system/data/cards/` prefix so the
 * trie still parents it under the `cards` hub where the journal actually
 * lives. Cards older than the window aren't lost: their touches pool into the
 * tile's own `touches`, so the node's overall heat and last-touch (the flash)
 * stay honest about the whole pool.
 *
 * Used by TerrainPage.tsx and TerrainBackdrop.tsx; drawn by terrainCanvas.ts;
 * per-day heat attached in terrainGraph.ts. Tested in pondNodes.test.ts.
 *
 * Prompt that produced it: "I want the pond UI to display in the background of
 * my sessions ... in a square without any labels ... it needs to bump around
 * the other dots and not cover them" / "replace; in terrain too. I want it to
 * be about a month's worth of journal so the breathing function works on the
 * entries within it".
 */
import type { TerrainData, TerrainFile } from './api';

/** The card pool's own directory — one file per utterance. */
export const CARDS_PREFIX = 'tulku/_system/data/cards/';

/** The tile's synthetic path. Under the cards prefix so the trie parents it
 * where the journal lives — and so pond-prefix checks (the landmark's anchor
 * set) pick it up without knowing it exists. */
export const POND_TILE_PATH = `${CARDS_PREFIX}pond`;

/** How much journal the tile draws: a month, one column per day — the far end
 * of the breath's swing, so the whole square participates in the breathing. */
export const POND_TILE_DAYS = 31;

/** A card's filename, taken apart. `2026-08-21.2232b.md` → that day, 22:32,
 * hers. Returns null for anything that isn't a card, so a stray file in the
 * directory is left alone rather than guessed at. */
export interface CardStamp {
  day: string;
  /** 'b' = the owner, 'k' = the Keeper. Lowercased. */
  who: string;
}

const CARD_RE = /^(\d{4}-\d{2}-\d{2})\.(\d{4})([a-z])\d*\.md$/;

export function parseCardPath(path: string): CardStamp | null {
  if (!path.startsWith(CARDS_PREFIX)) return null;
  const name = path.slice(CARDS_PREFIX.length);
  const m = CARD_RE.exec(name);
  if (!m) return null;
  return { day: m[1], who: m[3] };
}

/** Today as YYYY-MM-DD in the LOCAL timezone — the tile's newest column is
 * "today" as she experiences it, not as Greenwich does. Injectable for tests. */
export function localDayISO(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The tile's day window, oldest first, ending on `todayISO`. Walked in UTC
 * so string date math can't slip a day on browsers west of Greenwich. */
export function pondTileWindow(todayISO: string, days: number = POND_TILE_DAYS): string[] {
  const end = new Date(`${todayISO}T00:00:00Z`);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** The node id the graph will give the tile in `repoId`'s territory. */
export function pondTileNodeId(repoId: string): string {
  return `${repoId}:file:${POND_TILE_PATH}`;
}

export interface CollapsedPondTile {
  data: TerrainData;
  /** The tile node id per repo that had cards — what the landmark anchors on. */
  tileIds: Set<string>;
}

/**
 * Replace every card file in `data` with one synthetic tile file per repo
 * that holds cards (in practice: the vault).
 *
 * The `days` buckets are the month the square draws: one entry per day, oldest
 * first, each carrying a timestamp per card written that day. They come from
 * `data.pond_days` — the journal counted at the source — and fall back to
 * bucketing the payload's own card files by filename date when the server sent
 * none. A quiet day is an empty bucket, drawn as bare water.
 *
 * The tile's own `touches` pool the WHOLE journal, not just the window, so the
 * node's heat, its last-touch, and the live-mode flash keep meaning exactly
 * what they mean for real files: the window's true card times, plus the git
 * touches of card files older than the window. Splitting at the window's start
 * rather than merging both is what stops the last month being counted twice.
 *
 * Non-card files under the same directory, and every file in every other repo,
 * pass through untouched.
 */
export function collapseToPondTile(
  data: TerrainData,
  todayISO: string,
  days: number = POND_TILE_DAYS,
): CollapsedPondTile {
  const tileIds = new Set<string>();
  // The server's window wins when it sent one: it carries its own day labels,
  // and re-deriving them here would be a second clock free to disagree.
  const fromServer = data.pond_days?.length ? data.pond_days : null;
  const window = fromServer ? fromServer.map((d) => d.day) : pondTileWindow(todayISO, days);
  const dayIndex = new Map(window.map((day, i) => [day, i]));
  // Midnight local on the window's first day — the line either side of which a
  // card's time is already accounted for by pond_days.
  const windowStart = fromServer ? Date.parse(`${window[0]}T00:00:00`) / 1000 : Infinity;

  const repos = data.repos.map((repo) => {
    const kept: TerrainFile[] = [];
    const pooled: number[] = [];
    const dayTouches: number[][] = window.map(() => []);
    let cards = 0;

    for (const file of repo.files) {
      const stamp = parseCardPath(file.path);
      if (!stamp) {
        kept.push(file);
        continue;
      }
      cards += 1;
      for (const touch of file.touches) {
        if (touch < windowStart) pooled.push(touch);
      }
      if (fromServer) continue;
      const i = dayIndex.get(stamp.day);
      if (i !== undefined) dayTouches[i].push(...file.touches);
    }

    if (cards === 0) return repo;

    if (fromServer) {
      fromServer.forEach((d, i) => {
        dayTouches[i].push(...d.touches);
        pooled.push(...d.touches);
      });
    }

    // Newest first, matching what the payload guarantees for real files —
    // the heat maths and `fileLastTouch` both read touches[0] as "last".
    pooled.sort((a, b) => b - a);
    kept.push({
      path: POND_TILE_PATH,
      touches: pooled,
      sessions: [],
      days: window.map((day, i) => ({ day, touches: dayTouches[i] })),
    });
    tileIds.add(pondTileNodeId(repo.id));
    return { ...repo, files: kept };
  });

  return { data: { ...data, repos }, tileIds };
}
