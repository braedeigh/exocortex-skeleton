/**
 * pondShape.ts — the pond's silhouette, bucketed down to however much detail
 * is wanted.
 *
 * The landmark on the terrain map draws the same pond twice: crude when it's
 * small, resolved when it grows. Both drawings come from here, and the ONLY
 * difference between them is the bucket count — which is what makes the growth
 * read as approaching one thing rather than as swapping one picture for
 * another.
 *
 * Reads `GET /api/pond/shape` (routes/pond.py): one row per day, how many
 * cards and how many were hers. Used by terrain/PondLandmark.tsx; tested in
 * pondShape.test.ts.
 *
 * Prompt that produced it: "i want it to be small and poorly detailed and if
 * you hover over it it gets big".
 */

/** One day of the pond, as the shape endpoint reports it. */
export interface ShapeDay {
  day: string;
  cards: number;
  /** Of those, how many were hers rather than the Keeper's. */
  owner: number;
}

/** One drawn column: a fraction of the tallest, and how much of it is her own
 * voice. Both 0..1, so the drawing can scale them to any size it likes. */
export interface ShapeColumn {
  /** 0..1 against the busiest bucket in this run. */
  height: number;
  /** 0..1 — her share of this bucket's cards. */
  ownShare: number;
  /** Total cards in the bucket, for the label when there's room to say it. */
  cards: number;
}

/**
 * Bucket a run of days into `columns` columns.
 *
 * Buckets by POSITION in the day list, not by date arithmetic: the pond's days
 * are already contiguous and sorted, and bucketing by index means an empty
 * stretch narrows the columns either side of it rather than opening a gap the
 * thumbnail has no room to express. At this size a gap would read as a
 * rendering bug, not as a fallow week.
 *
 * Heights are normalised against the tallest bucket rather than against an
 * absolute card count, because the drawing's job is the SHAPE — where the busy
 * stretches are — and an absolute scale would flatten a quiet month into
 * nothing at all.
 */
export function bucketShape(days: ShapeDay[], columns: number): ShapeColumn[] {
  if (days.length === 0 || columns <= 0) return [];
  const n = Math.min(columns, days.length);
  const out: ShapeColumn[] = [];

  for (let i = 0; i < n; i += 1) {
    const start = Math.floor((i * days.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * days.length) / n));
    let cards = 0;
    let owner = 0;
    for (let d = start; d < end; d += 1) {
      cards += days[d].cards;
      owner += days[d].owner;
    }
    out.push({ height: cards, ownShare: cards > 0 ? owner / cards : 0, cards });
  }

  const tallest = out.reduce((m, c) => Math.max(m, c.height), 0);
  if (tallest === 0) return out.map((c) => ({ ...c, height: 0 }));
  return out.map((c) => ({ ...c, height: c.height / tallest }));
}

/**
 * The silhouette as an SVG path, drawn as a water body: the columns' tops
 * become the surface, closed along a flat bed underneath.
 *
 * Deliberately a filled body rather than separate bars. Bars at eight pixels
 * are a smear of unreadable ticks; a single closed shape still reads as a
 * pond-ish blob at any size, which is exactly what "small and poorly detailed"
 * wants. The same path at forty columns resolves into the real profile.
 *
 * `w`/`h` are the drawing box. The surface never touches the top edge (a 0.9
 * ceiling) so the busiest day has somewhere to be, and every column keeps a
 * floor so a quiet stretch stays water rather than becoming a hole in it.
 */
export function shapePath(cols: ShapeColumn[], w: number, h: number): string {
  if (cols.length === 0) return '';
  const step = w / cols.length;
  const surface = cols.map((c, i) => {
    const x = i * step + step / 2;
    // A floor of 0.12 — the pond has water in it even on her quietest days.
    const y = h - h * (0.12 + c.height * 0.78);
    return { x, y };
  });

  const parts = [`M 0 ${h.toFixed(1)}`, `L ${surface[0].x.toFixed(1)} ${surface[0].y.toFixed(1)}`];
  // Smoothed with midpoint quadratics — the surface of water, not a bar chart.
  for (let i = 1; i < surface.length; i += 1) {
    const prev = surface[i - 1];
    const cur = surface[i];
    const mx = (prev.x + cur.x) / 2;
    const my = (prev.y + cur.y) / 2;
    parts.push(`Q ${prev.x.toFixed(1)} ${prev.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`);
  }
  const last = surface[surface.length - 1];
  parts.push(`L ${w.toFixed(1)} ${last.y.toFixed(1)}`);
  parts.push(`L ${w.toFixed(1)} ${h.toFixed(1)}`);
  parts.push('Z');
  return parts.join(' ');
}
