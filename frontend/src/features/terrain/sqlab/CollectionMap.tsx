/**
 * CollectionMap — what's actually in this database, at a glance.
 *
 * **Form.** Sorted horizontal bars, grouped by domain — not the bubble/circle
 * pack this started out as. Two reasons the bubbles lost: circle AREA is read
 * badly by humans (a bubble twice the value looks maybe 1.4× bigger), and a
 * bubble field is an "all-pairs" form where every mark neighbours every other,
 * which caps categorical colour at three — far too few for the domains here.
 * Bars put every collection on one baseline where the comparison is exact.
 *
 * **Colour does one job: emphasis.** Typed tables in the accent, blob
 * collections in the de-emphasis grey. Not a colour per domain — the domains
 * are carried by grouping and headings, which costs no colour budget at all.
 * The one question the colour answers is the live one: what's been migrated to
 * real columns, and what's still a JSON blob.
 *
 * **Kind is a glyph, not a hue** (log / registry / config / keyed) — composite
 * encoding, so it survives colourblindness and greyscale printing.
 *
 * **Recency is text, not a second colour ramp.** Two colour scales competing on
 * one chart is how a map stops being readable; "cold" rows get a muted marker
 * and the date is written out.
 *
 * Blobs and typed tables are drawn as two separate charts with two separate
 * scales, because their record counts differ by an order of magnitude and one
 * shared axis would flatten every blob to nothing.
 *
 * Prompt that produced this file: "a visualizer for my SQL databases — have
 * them be different sizes and shapes based on what's in them."
 */
import { useMemo } from 'react';
import { DOMAIN_ORDER, domainOf } from './domains';
import type { Collection, TypedTable } from './types';
import styles from './CollectionMap.module.css';

/** Past this, a collection hasn't been written in a season. */
const COLD_DAYS = 30;

const KIND_GLYPH: Record<string, string> = {
  log: '▤',
  registry: '▦',
  keyed: '▥',
  config: '▪',
  table: '▣',
  scalar: '·',
  unreadable: '⚠',
};

const KIND_LABEL: Record<string, string> = {
  log: 'log — keyed by date, grows daily',
  registry: 'registry — a list of records',
  keyed: 'keyed — a dict keyed by name',
  config: 'config — a small settings map',
  table: 'typed table — real columns',
  scalar: 'scalar',
  unreadable: 'could not be parsed',
};

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

function Bar({
  label,
  records,
  max,
  kind,
  updatedAt,
  accent,
}: {
  label: string;
  records: number;
  max: number;
  kind: string;
  updatedAt?: string;
  accent: boolean;
}) {
  const age = daysSince(updatedAt);
  const cold = age !== null && age > COLD_DAYS;
  // Zero-record collections still get a hairline, so an empty collection reads
  // as "empty" rather than as a rendering failure.
  const pct = max > 0 ? Math.max((records / max) * 100, records > 0 ? 1.5 : 0) : 0;

  return (
    <div className={styles.row}>
      <span className={styles.glyph} title={KIND_LABEL[kind] ?? kind}>
        {KIND_GLYPH[kind] ?? '·'}
      </span>
      <span className={styles.name}>{label}</span>
      <span className={styles.track}>
        <span
          className={accent ? styles.fillAccent : styles.fill}
          style={{ width: `${pct}%` }}
        />
        {records === 0 && <span className={styles.emptyMark}>empty</span>}
      </span>
      <span className={styles.count}>{records.toLocaleString()}</span>
      <span className={cold ? styles.ageCold : styles.age}>
        {age === null ? '' : cold ? `${age}d cold` : `${age}d`}
      </span>
    </div>
  );
}

export function CollectionMap({
  blobs,
  typed,
}: {
  blobs: Collection[];
  typed: TypedTable[];
}) {
  const groups = useMemo(() => {
    const byDomain = new Map<string, Collection[]>();
    for (const c of blobs) {
      const d = domainOf(c.name);
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d)!.push(c);
    }
    for (const list of byDomain.values()) list.sort((a, b) => b.records - a.records);
    return DOMAIN_ORDER.filter((d) => byDomain.has(d)).map((d) => ({
      domain: d,
      items: byDomain.get(d)!,
    }));
  }, [blobs]);

  const blobMax = useMemo(() => Math.max(1, ...blobs.map((b) => b.records)), [blobs]);
  const typedMax = useMemo(() => Math.max(1, ...typed.map((t) => t.records)), [typed]);
  const cold = blobs.filter((b) => (daysSince(b.updated_at) ?? 0) > COLD_DAYS).length;
  const empty = blobs.filter((b) => b.records === 0).length;

  return (
    <div className={styles.map}>
      <div className={styles.summary}>
        <div className={styles.stat}>
          <span className={styles.statValue}>
            {typed.length}
            <span className={styles.statOf}> / {typed.length + blobs.length}</span>
          </span>
          <span className={styles.statLabel}>real tables</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{cold}</span>
          <span className={styles.statLabel}>untouched {COLD_DAYS}d+</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{empty}</span>
          <span className={styles.statLabel}>empty</span>
        </div>
      </div>

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.swatchAccent} /> typed table
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatch} /> JSON blob
        </span>
        {['log', 'registry', 'keyed', 'config'].map((k) => (
          <span key={k} className={styles.legendItem} title={KIND_LABEL[k]}>
            {KIND_GLYPH[k]} {k}
          </span>
        ))}
      </div>

      <section className={styles.group}>
        <h3 className={styles.groupHead}>
          Typed tables <span className={styles.scaleNote}>own scale · max {typedMax.toLocaleString()} rows</span>
        </h3>
        {typed.map((t) => (
          <Bar key={t.name} label={t.name} records={t.records} max={typedMax} kind="table" accent />
        ))}
      </section>

      {groups.map((g) => (
        <section key={g.domain} className={styles.group}>
          <h3 className={styles.groupHead}>
            {g.domain}
            <span className={styles.scaleNote}>
              {g.items.length} collection{g.items.length === 1 ? '' : 's'}
            </span>
          </h3>
          {g.items.map((c) => (
            <Bar
              key={c.name}
              label={c.name}
              records={c.records}
              max={blobMax}
              kind={c.kind}
              updatedAt={c.updated_at}
              accent={false}
            />
          ))}
        </section>
      ))}

      <p className={styles.footnote}>
        Blob collections share one scale (max {blobMax.toLocaleString()} records); the typed tables
        have their own, because their row counts are an order of magnitude larger and one shared
        axis would flatten every blob to nothing.
      </p>
    </div>
  );
}
