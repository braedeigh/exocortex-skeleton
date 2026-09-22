import { describe, expect, it } from 'vitest';
import type { TerrainData, TerrainFile } from './api';
import {
  UPLOADS_PREFIX,
  UPLOAD_WINDOW_STEPS,
  nextUploadWindow,
  parseUploadPath,
  uploadWindowLabel,
  windowUploads,
} from './uploadNodes';

/**
 * uploadNodes.test.ts — the window the upload coil shows, and the timestamps
 * it shows them on.
 *
 * The one that matters most here is the re-timing. An upload's git history is
 * bulk-commit noise (633 files, 20 distinct touch-sets, measured), so the
 * coil reads its times off the filenames instead. That substitution is
 * invisible on screen — a coil lit by the wrong times looks exactly like a
 * coil lit by the right ones — so it gets pinned hard.
 *
 * Pinned beside it: the window never comes back empty while uploads exist
 * (the folder node is the coil's own "load more" button, and the trie drops a
 * folder that holds no files, so an empty month would take the control off
 * the map); the uncapped server list beats the payload's capped files; and
 * agent attribution survives the swap.
 */

const NOW = Math.floor(new Date(2026, 8, 21, 12, 0, 0).getTime() / 1000);
const DAY = 86400;

/** An upload's filename at `daysAgo`, in the folder's own stamped form. */
function uploadPath(daysAgo: number, tag = 'a'): string {
  const at = new Date((NOW - daysAgo * DAY) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${UPLOADS_PREFIX}${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}_${tag}.png`
  );
}

function file(path: string, touches: number[] = [], sessions: TerrainFile['sessions'] = []): TerrainFile {
  return { path, touches, sessions };
}

function payload(
  files: TerrainFile[],
  uploads?: { repo: string; paths: string[]; prefix?: string },
): TerrainData {
  return {
    generated_at: '2026-09-21 12:00',
    window_days: null,
    file_cap: 350,
    repos: [{ id: 'vault', name: 'vault', files }] as TerrainData['repos'],
    ...(uploads ? { uploads: { prefix: UPLOADS_PREFIX, ...uploads } } : {}),
  };
}

describe('parseUploadPath', () => {
  it('reads the upload moment off the filename', () => {
    const at = parseUploadPath(`${UPLOADS_PREFIX}20260326_232944.png`);
    expect(at).not.toBeNull();
    const asDate = new Date(at! * 1000);
    expect(asDate.getFullYear()).toBe(2026);
    expect(asDate.getMonth()).toBe(2);
    expect(asDate.getDate()).toBe(26);
    expect(asDate.getHours()).toBe(23);
    expect(asDate.getMinutes()).toBe(29);
  });

  it('reads a stamp that carries a suffix', () => {
    // The pasted-text uploads are named `..._paste.txt`; they're uploads too.
    expect(parseUploadPath(`${UPLOADS_PREFIX}20260328_190203_paste.txt`)).not.toBeNull();
  });

  it('reads the dated-but-not-timed form, at midday', () => {
    // `20260725_IMG_2801.png` — the shape the repo's own filer fixtures use.
    // Midday, because the day is what's being placed and midnight is the one
    // hour that rounds into the wrong day.
    const at = parseUploadPath(`${UPLOADS_PREFIX}20260725_IMG_2801.png`);
    expect(at).not.toBeNull();
    const asDate = new Date(at! * 1000);
    expect(asDate.getDate()).toBe(25);
    expect(asDate.getHours()).toBe(12);
  });

  it('refuses anything that is not a stamped file in the folder', () => {
    expect(parseUploadPath('data/other/20260326_232944.png')).toBeNull();
    expect(parseUploadPath(`${UPLOADS_PREFIX}notes.md`)).toBeNull();
    // A nested folder isn't on the strand.
    expect(parseUploadPath(`${UPLOADS_PREFIX}old/20260326_232944.png`)).toBeNull();
    // A number that isn't a date — Date would roll this into January.
    expect(parseUploadPath(`${UPLOADS_PREFIX}20261332_232944.png`)).toBeNull();
  });
});

describe('windowUploads', () => {
  it('replaces bulk-commit history with the filename time', () => {
    // THE point of the module. Both uploads carry the same fake stamp (one
    // commit swept the folder); they must come out on their own real times.
    const bulkCommit = NOW - 40 * DAY;
    const recent = uploadPath(2);
    const older = uploadPath(5);
    const out = windowUploads(
      payload([file(recent, [bulkCommit]), file(older, [bulkCommit])], {
        repo: 'vault',
        paths: [recent, older],
      }),
      { nowSeconds: NOW },
    );
    const byPath = new Map(out.data.repos[0].files.map((f) => [f.path, f]));
    expect(byPath.get(recent)!.touches).toEqual([parseUploadPath(recent)]);
    expect(byPath.get(older)!.touches).toEqual([parseUploadPath(older)]);
    // And the lie is gone, not merely outvoted.
    expect(byPath.get(recent)!.touches).not.toContain(bulkCommit);
  });

  it('shows the last month and drops what is older', () => {
    const paths = [uploadPath(1), uploadPath(10), uploadPath(60), uploadPath(200)];
    const out = windowUploads(payload([], { repo: 'vault', paths }), {
      windowDays: 31,
      nowSeconds: NOW,
    });
    expect(out.shown).toBe(2);
    expect(out.total).toBe(4);
    expect(out.hasMore).toBe(true);
    expect(out.data.repos[0].files.map((f) => f.path)).toEqual([uploadPath(1), uploadPath(10)]);
  });

  it('opens the whole folder on the null window', () => {
    const paths = [uploadPath(1), uploadPath(200)];
    const out = windowUploads(payload([], { repo: 'vault', paths }), {
      windowDays: null,
      nowSeconds: NOW,
    });
    expect(out.shown).toBe(2);
    expect(out.hasMore).toBe(false);
  });

  it('orders the coil newest first', () => {
    // The order IS the geometry: spiralLayout lays spot 0 innermost.
    const paths = [uploadPath(10), uploadPath(1), uploadPath(5)];
    const out = windowUploads(payload([], { repo: 'vault', paths }), { nowSeconds: NOW });
    expect(out.spiralIds).toEqual([
      `vault:file:${uploadPath(1)}`,
      `vault:file:${uploadPath(5)}`,
      `vault:file:${uploadPath(10)}`,
    ]);
  });

  it('keeps the newest upload when the window catches nothing', () => {
    // Otherwise the folder node vanishes and takes the "load more" target
    // with it — there'd be nothing left to tap to get the rest back.
    const paths = [uploadPath(200), uploadPath(300)];
    const out = windowUploads(payload([], { repo: 'vault', paths }), {
      windowDays: 31,
      nowSeconds: NOW,
    });
    expect(out.shown).toBe(1);
    expect(out.spiralIds).toEqual([`vault:file:${uploadPath(200)}`]);
    expect(out.hasMore).toBe(true);
  });

  it('prefers the uncapped server list over the capped payload', () => {
    // The cap leaves 0 of 633 uploads in repos[].files on this vault, so a
    // coil built from the payload alone would draw empty.
    const onDisk = [uploadPath(1), uploadPath(2), uploadPath(3)];
    const out = windowUploads(payload([file(onDisk[0])], { repo: 'vault', paths: onDisk }), {
      nowSeconds: NOW,
    });
    expect(out.shown).toBe(3);
  });

  it('falls back to the payload when the server sent no list', () => {
    const paths = [uploadPath(1), uploadPath(2)];
    const out = windowUploads(payload(paths.map((p) => file(p))), { nowSeconds: NOW });
    expect(out.shown).toBe(2);
    expect(out.repoId).toBe('vault');
  });

  it('keeps agent attribution across the swap', () => {
    const path = uploadPath(1);
    const sessions: TerrainFile['sessions'] = [
      { id: 'c1', title: 'a look at the photos', writes: 0, reads: 1, last: null },
    ];
    const out = windowUploads(
      payload([file(path, [NOW - 40 * DAY], sessions)], { repo: 'vault', paths: [path] }),
      { nowSeconds: NOW },
    );
    expect(out.data.repos[0].files[0].sessions).toEqual(sessions);
  });

  it('leaves every other file alone', () => {
    const other = file('server.py', [NOW - 100]);
    const out = windowUploads(payload([other], { repo: 'vault', paths: [uploadPath(1)] }), {
      nowSeconds: NOW,
    });
    expect(out.data.repos[0].files).toContain(other);
  });

  it('puts an undated upload on the tip, and only on "everything"', () => {
    // It can't be left off the coil: every child of the folder is pinned, and
    // a loose one would be pulled to the centre by the folder rope while the
    // coil's body shoved it out.
    const dated = uploadPath(1);
    const odd = `${UPLOADS_PREFIX}screenshot.png`;
    const month = windowUploads(payload([], { repo: 'vault', paths: [dated, odd] }), {
      windowDays: 31,
      nowSeconds: NOW,
    });
    expect(month.spiralIds).toEqual([`vault:file:${dated}`]);
    expect(month.total).toBe(2);
    expect(month.hasMore).toBe(true);

    const everything = windowUploads(payload([], { repo: 'vault', paths: [dated, odd] }), {
      windowDays: null,
      nowSeconds: NOW,
    });
    // Last on the strand — past every dated upload.
    expect(everything.spiralIds).toEqual([`vault:file:${dated}`, `vault:file:${odd}`]);
    expect(everything.hasMore).toBe(false);
  });

  it('keeps an undated upload\'s real history rather than inventing one', () => {
    const odd = `${UPLOADS_PREFIX}screenshot.png`;
    const realTouch = NOW - 3 * DAY;
    const out = windowUploads(
      payload([file(odd, [realTouch])], { repo: 'vault', paths: [odd] }),
      { windowDays: null, nowSeconds: NOW },
    );
    expect(out.data.repos[0].files[0].touches).toEqual([realTouch]);
  });

  it('follows the folder the server points at, not its own default', () => {
    // store.UPLOAD_ARCHIVE_DIR is env-overridable, so an install can move it.
    const prefix = 'data/elsewhere/';
    const moved = `${prefix}20260920_120000.png`;
    const out = windowUploads(payload([], { repo: 'vault', prefix, paths: [moved] }), {
      nowSeconds: NOW,
    });
    expect(out.shown).toBe(1);
    expect(out.spiralIds).toEqual([`vault:file:${moved}`]);
  });

  it('says nothing is there on an install with no uploads folder', () => {
    const out = windowUploads(payload([file('server.py')]), { nowSeconds: NOW });
    expect(out.repoId).toBeNull();
    expect(out.spiralIds).toEqual([]);
    expect(out.total).toBe(0);
  });
});

describe('nextUploadWindow', () => {
  it('steps out and then back round to the month', () => {
    let at = UPLOAD_WINDOW_STEPS[0];
    const seen = [at];
    for (let i = 0; i < UPLOAD_WINDOW_STEPS.length; i += 1) {
      at = nextUploadWindow(at);
      seen.push(at);
    }
    expect(seen).toEqual([...UPLOAD_WINDOW_STEPS, UPLOAD_WINDOW_STEPS[0]]);
  });

  it('starts over from a window it has never heard of', () => {
    expect(nextUploadWindow(7)).toBe(UPLOAD_WINDOW_STEPS[0]);
  });
});

describe('uploadWindowLabel', () => {
  it('names each step the way the centre shows it', () => {
    expect(uploadWindowLabel(31)).toBe('1mo');
    expect(uploadWindowLabel(92)).toBe('3mo');
    expect(uploadWindowLabel(183)).toBe('6mo');
    expect(uploadWindowLabel(null)).toBe('all');
  });
});
