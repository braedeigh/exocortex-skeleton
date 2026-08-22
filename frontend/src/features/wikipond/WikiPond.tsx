import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useAddTag, useRemoveTag, useSubjectTags, useWikiPond } from './api';
import {
  clockOf,
  dayLabel,
  hourLines,
  labelStep,
  layoutWikiPond,
  polylinePoints,
  wikiTagRows,
  wikiThreadLine,
} from './wikiPondMath';
import type { WikiFamily, WikiMode, WikiRailNs, WikiRow, WikiTagRef } from './wikiPondMath';
import styles from './WikiPond.module.css';

/**
 * WikiPond — everything tagged, drawn in the pond's own place.
 *
 * Plain English: the journal pond draws HER WORDS as a place — one column
 * per day, time running down it. This page is that same drawing stretched
 * over everything the tags table knows about: journal cards, research
 * entries, build commits, todos — four thin lanes inside every day column,
 * in a fixed left-to-right order (journal, research, build, todo), each
 * lane its own muted colour. CLOCK mode puts a row at its own hour, a small
 * box per row; WORDS mode drops the clock and stacks journal/research rows
 * flush, sized by how much they wrote — build and todo have no prose to
 * stack, so those two lanes simply switch off in that mode, same as the
 * pond's own working lane does.
 *
 * The rail down the left is the tags table's own filing: sections by
 * NAMESPACE (Fronts, Threads, People, Topics, then whatever else exists,
 * alphabetically), each tag a row you can tap. Tapping LIGHTS a tag — never
 * a filter. Everything stays drawn; the lit tag's rows go full-strength and
 * a line is drawn through their centres, everything else just dims, the
 * exact rule PondView.tsx already follows for threads.
 *
 * Tapping a row opens a panel with its full text and its tag chips — ns:tag
 * pills with a visible × to remove, plus a picker+input to add another.
 * Those writes go through POST /api/tags/add|remove (routes/tags.py) and
 * this page just redraws what comes back, the same shape PondView.tsx's own
 * card-tagging panel already uses.
 *
 * Reads GET /api/wiki/pond (routes/wiki.py) and GET /api/tags/for. All the
 * placement arithmetic lives in wikiPondMath.ts, pure and tested; this file
 * only draws what comes back and tracks what's lit and what's open.
 *
 * Prompt that produced it: "the wiki gets the pond UI — day columns and
 * lanes for journal, research, build and todos, a rail grouped by tag
 * namespace, lighting as emphasis not filter, and tag chips editable where
 * she notices them."
 */

/** One zoom step, read differently by each mode — same idea as the pond's
 * own ZOOMS table, just re-tuned: this column has to hold four lanes side by
 * side in clock mode (so it starts wider than the pond's 4px floor), and two
 * lanes of readable prose in words mode. */
const ZOOMS = [
  { clock: { colWidth: 40, dayHeight: 420, dotSize: 4 }, words: { colWidth: 150, fontSize: 9 } },
  { clock: { colWidth: 72, dayHeight: 620, dotSize: 6 }, words: { colWidth: 220, fontSize: 12 } },
  { clock: { colWidth: 112, dayHeight: 860, dotSize: 8 }, words: { colWidth: 300, fontSize: 14 } },
  { clock: { colWidth: 160, dayHeight: 1100, dotSize: 10 }, words: { colWidth: 380, fontSize: 16 } },
];
const DEFAULT_ZOOM = 1;

/** How far back the water reaches. Server-side (`days=`), same reasoning as
 * the pond's own RANGES — the payload stays bounded. 45 matches the API's
 * own default (docs/tags-architecture.md). */
const RANGES = [
  { key: '45', label: '45d', days: 45 },
  { key: '90', label: '90d', days: 90 },
  { key: '180', label: '180d', days: 180 },
  { key: '365', label: '1y', days: 365 },
];

/** The rail's shelf order — the vault's own filing, not alphabetical for the
 * four it already names; anything else falls in after, sorted by ns. */
const NS_ORDER = ['front', 'thread', 'person', 'topic'];
const NS_LABEL: Record<string, string> = {
  front: 'Fronts', thread: 'Threads', person: 'People', topic: 'Topics',
};

function nsLabel(ns: string): string {
  return NS_LABEL[ns] ?? ns.charAt(0).toUpperCase() + ns.slice(1);
}

function sortRail(rail: WikiRailNs[]): WikiRailNs[] {
  return [...rail].sort((a, b) => {
    const ai = NS_ORDER.indexOf(a.ns);
    const bi = NS_ORDER.indexOf(b.ns);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? NS_ORDER.length : ai) - (bi === -1 ? NS_ORDER.length : bi);
    return a.ns.localeCompare(b.ns);
  });
}

const FAMILY_LABEL: Record<WikiFamily, string> = {
  journal: 'Journal', research: 'Research', build: 'Build', todo: 'Todo',
};

const FAMILY_CLASS: Record<WikiFamily, string> = {
  journal: styles.laneJournal,
  research: styles.laneResearch,
  build: styles.laneBuild,
  todo: styles.laneTodo,
};

/** ns/tag slug rule from docs/tags-architecture.md's write door — enforced
 * here too so a bad tag never round-trips to the server just to bounce. */
const SLUG_OK = /^[a-z0-9][a-z0-9\-_.]*$/;

export function WikiPond() {
  const [mode, setMode] = useState<WikiMode>('clock');
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [range, setRange] = useState('45');
  const [lit, setLit] = useState<WikiTagRef | null>(null);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [newNs, setNewNs] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');

  const days = RANGES.find((r) => r.key === range)?.days ?? 45;
  const pond = useWikiPond(days, null);
  const rows: WikiRow[] = pond.data?.rows ?? [];
  const rail = useMemo(() => sortRail(pond.data?.rail ?? []), [pond.data?.rail]);

  const z = ZOOMS[zoom];
  const geom = mode === 'clock' ? z.clock : z.words;

  // The lit tag's terms, for excerpt() to window a long journal/research row
  // onto — same job pondMath's `terms` option does for the pond, just fed a
  // single tag's own text rather than a thread's alias list (the wiki-pond
  // API has no alias table to draw from).
  const terms = lit ? [lit.tag] : null;

  const layout = useMemo(
    () => layoutWikiPond(rows, { mode, ...geom, terms }),
    // `zoom` (not `geom`) is the real dependency — geom is a union type
    // derived from it, and every field the layout reads changes only when
    // zoom or mode does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, mode, zoom, terms],
  );

  const litRows = useMemo(() => wikiTagRows(layout, lit), [layout, lit]);
  const litIds = useMemo(() => new Set(litRows.map((p) => p.row.id)), [litRows]);
  const line = useMemo(() => wikiThreadLine(layout, lit), [layout, lit]);
  const gridLines = useMemo(
    () => hourLines({ mode, dayHeight: z.clock.dayHeight }),
    [mode, z.clock.dayHeight],
  );
  const step = labelStep(layout.colWidth);
  const laneWidth = layout.families.length > 0 ? layout.colWidth / layout.families.length : layout.colWidth;

  const openRow = rows.find((r) => r.id === openRowId) ?? null;
  const subjectTags = useSubjectTags(openRowId);
  const addTag = useAddTag();
  const removeTag = useRemoveTag();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  // Frame the whole window on first paint, same call the pond makes: pick
  // the widest zoom whose days all fit at once, then land in the middle of
  // it rather than at day one.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (fitted.current || !el || layout.columns.length === 0) return;
    fitted.current = true;
    let best = zoom;
    for (let i = ZOOMS.length - 1; i >= 0; i -= 1) {
      const colW = mode === 'clock' ? ZOOMS[i].clock.colWidth : ZOOMS[i].words.colWidth;
      if (layout.columns.length * colW <= el.clientWidth) {
        best = i;
        break;
      }
    }
    setZoom(best);
    requestAnimationFrame(() => {
      if (el) el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.columns.length]);

  function changeRange(next: string) {
    if (next === range) return;
    setRange(next);
    fitted.current = false;
  }

  function toggleLit(ns: string, tag: string) {
    setLit((cur) => (cur && cur.ns === ns && cur.tag === tag ? null : { ns, tag }));
  }

  function openRowPanel(id: string) {
    setConfirmRemove(null);
    setNewTag('');
    setOpenRowId((cur) => (cur === id ? null : id));
  }

  const namespaces = rail.map((r) => r.ns);
  const nsForForm = newNs && namespaces.includes(newNs) ? newNs : (namespaces[0] ?? 'topic');

  function submitAddTag(e: FormEvent) {
    e.preventDefault();
    const tag = newTag.trim().toLowerCase();
    if (!openRowId || !SLUG_OK.test(tag) || !SLUG_OK.test(nsForForm) || addTag.isPending) return;
    addTag.mutate({ subject: openRowId, ns: nsForForm, tag });
    setNewTag('');
  }

  const totalRows = rows.length;
  const dayCount = layout.columns.length;

  return (
    <section className={styles.view} aria-label="The wiki pond">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>The pond</h2>
          <p className={styles.sub}>
            {totalRows > 0
              ? `${totalRows.toLocaleString()} rows across ${dayCount} days${lit ? ` — ${lit.ns}:${lit.tag} lit` : ''}`
              : 'Everything tagged, drawn in place.'}
          </p>
        </div>

        <div className={styles.controls}>
          <div className={styles.segmented} role="group" aria-label="Arrangement">
            <button
              type="button"
              className={mode === 'clock' ? styles.segOn : styles.seg}
              aria-pressed={mode === 'clock'}
              onClick={() => setMode('clock')}
            >
              Time
            </button>
            <button
              type="button"
              className={mode === 'words' ? styles.segOn : styles.seg}
              aria-pressed={mode === 'words'}
              onClick={() => setMode('words')}
            >
              Words
            </button>
          </div>

          <div className={styles.segmented} role="group" aria-label="How far back">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={range === r.key ? styles.segOn : styles.seg}
                aria-pressed={range === r.key}
                onClick={() => changeRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className={styles.segmented} role="group" aria-label="Zoom">
            <button
              type="button"
              className={styles.seg}
              disabled={zoom === 0}
              aria-label="Zoom out"
              onClick={() => setZoom((z2) => Math.max(0, z2 - 1))}
            >
              −
            </button>
            <span className={styles.zoomPips} aria-hidden="true">
              {ZOOMS.map((_, i) => (
                <span key={i} className={i === zoom ? styles.pipOn : styles.pip} />
              ))}
            </span>
            <button
              type="button"
              className={styles.seg}
              disabled={zoom === ZOOMS.length - 1}
              aria-label="Zoom in"
              onClick={() => setZoom((z2) => Math.min(ZOOMS.length - 1, z2 + 1))}
            >
              +
            </button>
          </div>

          <Link to="/wiki" className={styles.back} aria-label="Back to the wiki">
            ← Wiki
          </Link>
        </div>
      </header>

      {/* Which colour is which family — only the lanes THIS mode draws, so
          the legend switches off along with build/todo in words mode rather
          than naming lanes that aren't on the page. */}
      <div className={styles.legend} aria-hidden="true">
        {layout.families.map((f) => (
          <span key={f} className={styles.legendItem}>
            <span className={[styles.legendSwatch, FAMILY_CLASS[f]].join(' ')} />
            {FAMILY_LABEL[f]}
          </span>
        ))}
      </div>

      {pond.isLoading ? <p className={styles.note}>Reading the pond…</p> : null}
      {pond.isError ? <p className={styles.note}>Couldn&rsquo;t read the wiki pond.</p> : null}
      {pond.data && totalRows === 0 ? (
        <p className={styles.note}>Nothing tagged in this window yet.</p>
      ) : null}

      {totalRows > 0 ? (
        <div className={styles.body}>
          <nav className={styles.rail} aria-label="Tags">
            <div className={styles.railList}>
              {rail.length === 0 ? (
                <p className={styles.railEmpty}>Nothing filed yet.</p>
              ) : (
                rail.map((section) => (
                  <div key={section.ns} className={styles.railSection}>
                    <div className={styles.railSectionLabel}>{nsLabel(section.ns)}</div>
                    {section.tags.map((t) => {
                      const isLit = lit?.ns === section.ns && lit.tag === t.tag;
                      return (
                        <button
                          key={t.tag}
                          type="button"
                          className={isLit ? styles.tagRowOn : styles.tagRow}
                          aria-pressed={isLit}
                          onClick={() => toggleLit(section.ns, t.tag)}
                        >
                          <span className={styles.tagRowName}>{t.tag}</span>
                          <span className={styles.tagRowMeta}>
                            {t.count} · {t.span} {t.span === 1 ? 'day' : 'days'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </nav>

          <div className={styles.stage}>
            {mode === 'clock' ? (
              <div className={styles.gutter} ref={gutterRef} aria-hidden="true">
                <div className={styles.gutterInner} style={{ height: layout.height }}>
                  {gridLines.map((l) => (
                    <span key={l.label} className={styles.hourLabel} style={{ top: l.y - 8 }}>
                      {l.label}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div
              className={styles.scroller}
              ref={scrollerRef}
              onScroll={(e) => {
                const g = gutterRef.current;
                if (g) g.scrollTop = e.currentTarget.scrollTop;
              }}
            >
              <div
                className={styles.canvas}
                style={{ width: layout.width, height: layout.height }}
                role="group"
                aria-label={lit ? `The wiki pond, with ${lit.ns}:${lit.tag} lit` : 'The wiki pond — every tagged row by day'}
              >
                <svg className={styles.underlay} width={layout.width} height={layout.height} aria-hidden="true">
                  {gridLines.map((l) => (
                    <line key={l.label} x1={0} x2={layout.width} y1={l.y} y2={l.y} className={styles.hourLine} />
                  ))}
                  {line.length > 1 ? (
                    <polyline points={polylinePoints(line)} className={styles.threadLine} />
                  ) : null}
                </svg>

                {/* The lane bands — a faint tint per family so the four (or
                    two, in words mode) vertical lanes read as lanes even
                    before anything is lit. */}
                {layout.columns.map((col) =>
                  layout.families.map((f, i) => (
                    <span
                      key={`${col.day}:${f}`}
                      className={[styles.laneBand, FAMILY_CLASS[f]].join(' ')}
                      style={{ left: col.x + i * laneWidth, top: 0, width: laneWidth, height: layout.height }}
                    />
                  )),
                )}

                <div className={styles.dayHeader} style={{ width: layout.width }}>
                  {layout.columns.map((col, i) =>
                    i % step === 0 ? (
                      <span
                        key={col.day}
                        className={styles.dayLabel}
                        style={{ left: col.x, width: Math.max(layout.colWidth, 30) }}
                      >
                        {dayLabel(col.day, step === 1 ? layout.columns[i - 1]?.day : undefined)}
                      </span>
                    ) : null,
                  )}
                </div>

                {layout.columns.map((col) =>
                  col.rows.map((placed) => {
                    const isLit = litIds.has(placed.row.id);
                    const isOpen = placed.row.id === openRowId;
                    const familyClass = FAMILY_CLASS[placed.row.family];
                    return (
                      <button
                        key={placed.row.id}
                        type="button"
                        className={[
                          mode === 'clock' ? styles.dot : styles.wordCard,
                          familyClass,
                          lit && !isLit ? styles.dimmed : '',
                          isLit ? styles.onTag : '',
                          isOpen ? styles.open : '',
                        ].filter(Boolean).join(' ')}
                        style={{
                          left: placed.x,
                          top: placed.y,
                          width: placed.w,
                          height: placed.h,
                          ...(mode === 'words' ? { fontSize: z.words.fontSize } : {}),
                        }}
                        title={`${placed.row.day}${clockOf(placed.row.ts) ? ` ${clockOf(placed.row.ts)}` : ''} · ${FAMILY_LABEL[placed.row.family]}`}
                        onClick={() => openRowPanel(placed.row.id)}
                      >
                        {placed.text ? (
                          <span className={styles.wordText}>
                            {placed.text.clippedHead ? '… ' : ''}
                            {placed.text.text}
                            {placed.text.clippedTail ? ' …' : ''}
                          </span>
                        ) : null}
                      </button>
                    );
                  }),
                )}
              </div>
            </div>
          </div>

          {openRow ? (
            <aside className={styles.detail} aria-label="Row">
              <div className={styles.detailHead}>
                <span className={styles.detailMeta}>
                  {dayLabel(openRow.day)}
                  {clockOf(openRow.ts) ? ` · ${clockOf(openRow.ts)}` : ''}
                  {` · ${FAMILY_LABEL[openRow.family]}`}
                </span>
                <button
                  type="button"
                  className={styles.detailClose}
                  onClick={() => setOpenRowId(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {/* Full body for journal/research; title for build/todo — the
                  two families whose "body" carries no prose worth showing. */}
              <p className={styles.detailBody}>
                {openRow.family === 'build' || openRow.family === 'todo'
                  ? openRow.title
                  : (openRow.body || openRow.title)}
              </p>

              <div className={styles.detailTags}>
                {(subjectTags.data?.tags ?? openRow.tags.map((t) => ({ ...t, source: 'manual' as const }))).map((t) => {
                  const chipKey = `${t.ns}:${t.tag}`;
                  const chipLit = lit?.ns === t.ns && lit.tag === t.tag;
                  return (
                    <span key={chipKey} className={styles.chipPair}>
                      <button
                        type="button"
                        className={chipLit ? styles.tagChipOn : styles.tagChip}
                        onClick={() => toggleLit(t.ns, t.tag)}
                      >
                        {t.ns}:{t.tag}
                      </button>
                      <button
                        type="button"
                        className={confirmRemove === chipKey ? styles.chipRemoveArmed : styles.chipRemove}
                        disabled={removeTag.isPending}
                        aria-label={
                          confirmRemove === chipKey
                            ? `Really remove ${chipKey} from this row`
                            : `Remove ${chipKey} from this row`
                        }
                        onClick={() => {
                          if (confirmRemove === chipKey) {
                            setConfirmRemove(null);
                            removeTag.mutate({ subject: openRow.id, ns: t.ns, tag: t.tag });
                          } else {
                            setConfirmRemove(chipKey);
                          }
                        }}
                      >
                        {confirmRemove === chipKey ? 'sure?' : '×'}
                      </button>
                    </span>
                  );
                })}
                {subjectTags.data && subjectTags.data.tags.length === 0 ? (
                  <span className={styles.railEmpty}>No tags yet.</span>
                ) : null}
              </div>

              <form className={styles.addTag} onSubmit={submitAddTag}>
                <select
                  className={styles.addTagNs}
                  value={nsForForm}
                  aria-label="Namespace"
                  onChange={(e) => setNewNs(e.target.value)}
                >
                  {namespaces.length === 0 ? <option value="topic">topic</option> : null}
                  {namespaces.map((ns) => (
                    <option key={ns} value={ns}>{ns}</option>
                  ))}
                </select>
                <input
                  type="text"
                  className={styles.addTagInput}
                  value={newTag}
                  placeholder="add a tag…"
                  aria-label="Add a tag to this row"
                  onChange={(e) => setNewTag(e.target.value)}
                />
                <button
                  type="submit"
                  className={styles.addTagBtn}
                  disabled={addTag.isPending || !SLUG_OK.test(newTag.trim().toLowerCase())}
                >
                  Add
                </button>
              </form>
              {addTag.isError || removeTag.isError ? (
                <p className={styles.note}>Couldn&rsquo;t change that — try again.</p>
              ) : null}
            </aside>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
