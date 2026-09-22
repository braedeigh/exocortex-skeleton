import { describe, expect, it } from 'vitest';
import type { TerrainData, TerrainFile } from './api';
import {
  DEFAULT_COIL_WINDOWS,
  coilWindowLabel,
  nextCoilWindow,
  parseStampedName,
  windowCoils,
} from './coilFolders';

/**
 * coilFolders.test.ts — which files land on a coil, in what order, and on
 * what clock.
 *
 * Two things here are invisible until they're badly wrong, so they're pinned
 * hardest. The RE-TIMING: a stamp coil throws git's history away for the
 * moment in the filename, and a coil lit by the wrong times looks exactly
 * like a coil lit by the right ones. And the PARSER, which now has to read
 * every naming shape her candidate folders actually use — those live in
 * `REAL_NAMES` below, straight off disk, because a parser that handles the
 * shapes someone imagined is worth nothing.
 *
 * Pinned beside them: a window never comes back empty while the folder has
 * anything in it (the folder node is the coil's own "load more" button, and
 * the trie drops a folder holding no files, so an empty month would take the
 * control off the map); coils don't bleed into each other; the uncapped
 * server list beats the payload's capped files; and agent attribution
 * survives the swap.
 */

const NOW = Math.floor(new Date(2026, 8, 21, 12, 0, 0).getTime() / 1000);
const DAY = 86400;

/** One real filename from each candidate folder, with what it means. */
const REAL_NAMES: [string, string, [number, number, number, number, number]][] = [
  // folder                    name                        y  m  d  h  min
  ['data/uploads-archive/', '20260326_232944.png', [2026, 2, 26, 23, 29]],
  ['data/uploads-archive/', '20260725_IMG_2801.png', [2026, 6, 25, 12, 0]],
  ['data/bot_chats/', '2026-07-23.101356.jsonl', [2026, 6, 23, 10, 13]],
  ['data/bot_chats/', '2026-07-23.102832-2.jsonl', [2026, 6, 23, 10, 28]],
  ['tulku/Journal/Daily/', '2026-02-27.md', [2026, 1, 27, 12, 0]],
  ['tulku/tulku-diary/', '00-asa-2026-02-27.md', [2026, 1, 27, 12, 0]],
  ['tulku/tulku-diary/', '100-hazel-2026-06-17.md', [2026, 5, 17, 12, 0]],
  ['data/write_log/', '2026-08-21.db', [2026, 7, 21, 12, 0]],
];

function file(path: string, touches: number[] = [], sessions: TerrainFile['sessions'] = []): TerrainFile {
  return { path, touches, sessions };
}

function listing(over: Partial<NonNullable<TerrainData['coils']>[number]> = {}) {
  return {
    repo: 'vault',
    prefix: 'data/uploads-archive/',
    time: 'stamp' as const,
    windows: [...DEFAULT_COIL_WINDOWS],
    paths: [],
    ...over,
  };
}

function payload(files: TerrainFile[], coils: TerrainData['coils'] = []): TerrainData {
  return {
    generated_at: '2026-09-21 12:00',
    window_days: null,
    file_cap: 350,
    repos: [{ id: 'vault', name: 'vault', files }] as TerrainData['repos'],
    coils,
  };
}

/** A stamped filename `daysAgo`, in the uploads folder's own form. */
function stamped(daysAgo: number, tag = 'a'): string {
  const at = new Date((NOW - daysAgo * DAY) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `data/uploads-archive/${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}_${tag}.png`
  );
}

describe('parseStampedName', () => {
  it.each(REAL_NAMES)('reads %s%s', (_prefix, name, [year, month, day, hour, minute]) => {
    const at = parseStampedName(name);
    expect(at).not.toBeNull();
    const asDate = new Date(at! * 1000);
    expect([
      asDate.getFullYear(),
      asDate.getMonth(),
      asDate.getDate(),
      asDate.getHours(),
      asDate.getMinutes(),
    ]).toEqual([year, month, day, hour, minute]);
  });

  it('finds a date buried in the middle of a name', () => {
    // The diary puts an index and a name in front of the date; anchoring the
    // parser at the start would make that whole folder undatable.
    expect(parseStampedName('00-asa-2026-02-27.md')).not.toBeNull();
    expect(parseStampedName('100-hazel-2026-06-17.md')).toBe(
      parseStampedName('2026-06-17.md'),
    );
  });

  it('refuses a number that is not a date', () => {
    expect(parseStampedName('notes.md')).toBeNull();
    // Month 13 — Date would quietly roll this into the next January.
    expect(parseStampedName('20261332_232944.png')).toBeNull();
    // A year nobody is writing files in.
    expect(parseStampedName('12340102.png')).toBeNull();
  });

  it('does not read a date out of the tail of a longer number', () => {
    // `...120260326...` contains `20260326`, but it isn't a date, it's the
    // middle of some id.
    expect(parseStampedName('id120260326x.png')).toBeNull();
  });

  it('refuses a seven-digit run as a time', () => {
    // `2345678` isn't `23:45:67`; it's a longer number that starts plausibly.
    const at = parseStampedName('20260326_2345678.png');
    expect(new Date(at! * 1000).getHours()).toBe(12); // fell back to midday
  });
});

describe('windowCoils', () => {
  it('replaces bulk-commit history with the filename time', () => {
    // THE point of a stamp coil. Both files carry the same fake stamp (one
    // commit swept the folder); they must come out on their own real times.
    const bulkCommit = NOW - 40 * DAY;
    const recent = stamped(2);
    const older = stamped(5);
    const out = windowCoils(
      payload(
        [file(recent, [bulkCommit]), file(older, [bulkCommit])],
        [listing({ paths: [recent, older] })],
      ),
      { nowSeconds: NOW },
    );
    const byPath = new Map(out.data.repos[0].files.map((f) => [f.path, f]));
    expect(byPath.get(recent)!.touches).toEqual([parseStampedName(recent.split('/').pop()!)]);
    // And the lie is gone, not merely outvoted.
    expect(byPath.get(recent)!.touches).not.toContain(bulkCommit);
  });

  it('leaves a git coil its real history', () => {
    // The other source: a folder whose commits mean something keeps them,
    // and is ordered by last touch rather than by any name.
    const a = 'tulku/people/abboody.md';
    const b = 'tulku/people/adam.md';
    const out = windowCoils(
      payload(
        [file(a, [NOW - 2 * DAY]), file(b, [NOW - 1 * DAY])],
        [listing({ prefix: 'tulku/people/', time: 'git', paths: [a, b] })],
      ),
      { nowSeconds: NOW },
    );
    expect(out.data.repos[0].files.find((f) => f.path === a)!.touches).toEqual([NOW - 2 * DAY]);
    // Newest touch innermost.
    expect(out.coils[0].spiralIds).toEqual([`vault:file:${b}`, `vault:file:${a}`]);
  });

  it('shows the first window and drops what is older', () => {
    const paths = [stamped(1), stamped(10), stamped(60), stamped(200)];
    const out = windowCoils(payload([], [listing({ paths })]), { nowSeconds: NOW });
    expect(out.coils[0].shown).toBe(2);
    expect(out.coils[0].total).toBe(4);
    expect(out.coils[0].hasMore).toBe(true);
  });

  it('opens each coil to its own window', () => {
    const a = [stamped(1), stamped(60)];
    const b = ['data/bot_chats/2026-07-23.101356.jsonl'];
    const out = windowCoils(
      payload([], [
        listing({ paths: a }),
        listing({ prefix: 'data/bot_chats/', paths: b }),
      ]),
      { nowSeconds: NOW, windows: { 'data/uploads-archive/': null } },
    );
    // The uploads coil was opened wide; the chats coil kept its default and
    // caught nothing in a month, so it held its newest one back.
    expect(out.coils[0].shown).toBe(2);
    expect(out.coils[1].shown).toBe(1);
  });

  it('keeps two coils from bleeding into each other', () => {
    const up = stamped(1);
    const chat = 'data/bot_chats/2026-09-20.101356.jsonl';
    const out = windowCoils(
      payload([], [
        listing({ paths: [up] }),
        listing({ prefix: 'data/bot_chats/', paths: [chat] }),
      ]),
      { nowSeconds: NOW },
    );
    expect(out.coils[0].spiralIds).toEqual([`vault:file:${up}`]);
    expect(out.coils[1].spiralIds).toEqual([`vault:file:${chat}`]);
  });

  it('orders a coil newest first', () => {
    // The order IS the geometry: spiralLayout lays spot 0 innermost.
    const paths = [stamped(10), stamped(1), stamped(5)];
    const out = windowCoils(payload([], [listing({ paths })]), { nowSeconds: NOW });
    expect(out.coils[0].spiralIds).toEqual([
      `vault:file:${stamped(1)}`,
      `vault:file:${stamped(5)}`,
      `vault:file:${stamped(10)}`,
    ]);
  });

  it('keeps the newest file when the window catches nothing', () => {
    // Otherwise the folder node vanishes and takes the "load more" target
    // with it — there'd be nothing left to tap to get the rest back.
    const paths = [stamped(200), stamped(300)];
    const out = windowCoils(payload([], [listing({ paths })]), { nowSeconds: NOW });
    expect(out.coils[0].shown).toBe(1);
    expect(out.coils[0].spiralIds).toEqual([`vault:file:${stamped(200)}`]);
    expect(out.coils[0].hasMore).toBe(true);
  });

  it('puts an undated file on the tip, and only on "everything"', () => {
    // It can't be left off the coil: every child of the folder is pinned, and
    // a loose one would be pulled to the centre by the folder rope while the
    // coil's body shoved it out.
    const dated = stamped(1);
    const odd = 'data/uploads-archive/screenshot.png';
    const month = windowCoils(payload([], [listing({ paths: [dated, odd] })]), {
      nowSeconds: NOW,
    });
    expect(month.coils[0].spiralIds).toEqual([`vault:file:${dated}`]);
    expect(month.coils[0].total).toBe(2);

    const everything = windowCoils(payload([], [listing({ paths: [dated, odd] })]), {
      nowSeconds: NOW,
      windows: { 'data/uploads-archive/': null },
    });
    // Last on the strand — past everything dated.
    expect(everything.coils[0].spiralIds).toEqual([
      `vault:file:${dated}`,
      `vault:file:${odd}`,
    ]);
  });

  it('prefers the uncapped server list over the capped payload', () => {
    // The cap leaves 0 of 633 uploads in repos[].files on this vault, so a
    // coil built from the payload alone would draw empty.
    const onDisk = [stamped(1), stamped(2), stamped(3)];
    const out = windowCoils(payload([file(onDisk[0])], [listing({ paths: onDisk })]), {
      nowSeconds: NOW,
    });
    expect(out.coils[0].shown).toBe(3);
  });

  it('falls back to the payload when a listing carries no paths', () => {
    const paths = [stamped(1), stamped(2)];
    const out = windowCoils(payload(paths.map((p) => file(p)), [listing()]), {
      nowSeconds: NOW,
    });
    expect(out.coils[0].shown).toBe(2);
  });

  it('keeps agent attribution across the swap', () => {
    const path = stamped(1);
    const sessions: TerrainFile['sessions'] = [
      { id: 'c1', title: 'a look at the photos', writes: 0, reads: 1, last: null },
    ];
    const out = windowCoils(
      payload([file(path, [NOW - 40 * DAY], sessions)], [listing({ paths: [path] })]),
      { nowSeconds: NOW },
    );
    expect(out.data.repos[0].files.find((f) => f.path === path)!.sessions).toEqual(sessions);
  });

  it('leaves every other file alone', () => {
    const other = file('server.py', [NOW - 100]);
    const out = windowCoils(payload([other], [listing({ paths: [stamped(1)] })]), {
      nowSeconds: NOW,
    });
    expect(out.data.repos[0].files).toContain(other);
  });

  it('does nothing at all when no folder is configured', () => {
    const only = file('server.py');
    const out = windowCoils(payload([only]), { nowSeconds: NOW });
    expect(out.coils).toEqual([]);
    expect(out.data.repos[0].files).toEqual([only]);
  });
});

describe('nextCoilWindow', () => {
  it('steps out and then back round to the first', () => {
    const steps = [31, 92, null];
    let at = steps[0];
    const seen = [at];
    for (let i = 0; i < steps.length; i += 1) {
      at = nextCoilWindow(at, steps);
      seen.push(at);
    }
    expect(seen).toEqual([...steps, steps[0]]);
  });

  it('starts over from a window it has never heard of', () => {
    expect(nextCoilWindow(7, [31, 92])).toBe(31);
  });
});

describe('coilWindowLabel', () => {
  it('names each step the way a centre shows it', () => {
    expect(coilWindowLabel(31)).toBe('1mo');
    expect(coilWindowLabel(92)).toBe('3mo');
    expect(coilWindowLabel(183)).toBe('6mo');
    expect(coilWindowLabel(null)).toBe('all');
  });
});
