import { describe, expect, it } from 'vitest';
import type { TerrainData, TerrainFile } from './api';
import {
  CARDS_PREFIX,
  collapseToPondTile,
  parseCardPath,
  POND_TILE_DAYS,
  POND_TILE_PATH,
  pondTileNodeId,
  pondTileWindow,
} from './pondNodes';

const card = (name: string, touches: number[] = [100]): TerrainFile => ({
  path: `${CARDS_PREFIX}${name}`,
  touches,
  sessions: [],
});

const data = (files: TerrainFile[]): TerrainData => ({
  generated_at: '2026-08-21T00:00:00Z',
  window_days: null,
  file_cap: null,
  repos: [{ id: 'vault', name: 'Personal vault', root: '/v', files, files_total: files.length }],
});

const TODAY = '2026-08-21';

describe('parseCardPath', () => {
  it('reads the day and the speaker off a card filename', () => {
    expect(parseCardPath(`${CARDS_PREFIX}2026-08-21.2232b.md`)).toEqual({
      day: '2026-08-21',
      who: 'b',
    });
    expect(parseCardPath(`${CARDS_PREFIX}2026-07-06.0000k.md`)).toEqual({
      day: '2026-07-06',
      who: 'k',
    });
  });

  it('handles the disambiguating suffix on same-minute cards', () => {
    // 0923b2, 0923b3 — several cards inside one minute.
    expect(parseCardPath(`${CARDS_PREFIX}2026-07-06.0923b4.md`)).toEqual({
      day: '2026-07-06',
      who: 'b',
    });
  });

  it('returns null for anything that is not a card', () => {
    expect(parseCardPath('tulku/Journal/Daily/2026-08-21.md')).toBeNull();
    expect(parseCardPath(`${CARDS_PREFIX}README.md`)).toBeNull();
    expect(parseCardPath(`${CARDS_PREFIX}index.json`)).toBeNull();
    expect(parseCardPath('routes/pond.py')).toBeNull();
  });
});

describe('pondTileWindow', () => {
  it('runs oldest to newest and ends on today', () => {
    const w = pondTileWindow(TODAY, 3);
    expect(w).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
  });

  it('crosses a month boundary without slipping a day', () => {
    const w = pondTileWindow('2026-09-02', 4);
    expect(w).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  });

  it('defaults to a month of days', () => {
    expect(pondTileWindow(TODAY)).toHaveLength(POND_TILE_DAYS);
  });
});

describe('collapseToPondTile', () => {
  it('replaces every card file with one tile and reports its node id', () => {
    const got = collapseToPondTile(
      data([
        card('2026-08-21.0900b.md'),
        card('2026-08-21.1000k.md'),
        card('2026-08-20.0900b.md'),
      ]),
      TODAY,
    );
    const paths = got.data.repos[0].files.map((f) => f.path);
    expect(paths).toEqual([POND_TILE_PATH]);
    expect(got.tileIds).toEqual(new Set([pondTileNodeId('vault')]));
  });

  it('buckets the window per day, oldest first, quiet days empty', () => {
    const got = collapseToPondTile(
      data([card('2026-08-21.0900b.md', [200]), card('2026-08-19.0900b.md', [50, 60])]),
      TODAY,
      3,
    );
    const tile = got.data.repos[0].files[0];
    expect(tile.days?.map((d) => d.day)).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
    expect(tile.days?.[0].touches).toEqual([50, 60]);
    expect(tile.days?.[1].touches).toEqual([]);
    expect(tile.days?.[2].touches).toEqual([200]);
  });

  it('pools cards older than the window into the tile without a day bucket', () => {
    const got = collapseToPondTile(
      data([card('2026-08-21.0900b.md', [200]), card('2026-01-05.0900b.md', [10])]),
      TODAY,
      3,
    );
    const tile = got.data.repos[0].files[0];
    // Newest first, matching what the payload guarantees for real files.
    expect(tile.touches).toEqual([200, 10]);
    expect(tile.days?.flatMap((d) => d.touches)).toEqual([200]);
  });

  it('leaves non-card files and card-free repos untouched', () => {
    const stray: TerrainFile = { path: `${CARDS_PREFIX}index.json`, touches: [5], sessions: [] };
    const code: TerrainFile = { path: 'routes/pond.py', touches: [7], sessions: [] };
    const withCards = collapseToPondTile(data([stray, card('2026-08-21.0900b.md')]), TODAY);
    expect(withCards.data.repos[0].files.map((f) => f.path)).toEqual([
      `${CARDS_PREFIX}index.json`,
      POND_TILE_PATH,
    ]);

    const noCards = data([code]);
    const got = collapseToPondTile(noCards, TODAY);
    expect(got.data.repos[0]).toBe(noCards.repos[0]);
    expect(got.tileIds.size).toBe(0);
  });
});
