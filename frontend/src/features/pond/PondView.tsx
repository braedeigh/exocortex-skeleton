import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { usePondCard, usePondCards, usePondThreads } from './api';
import {
  dayLabel,
  hourLines,
  layoutPond,
  polylinePoints,
  threadPoints,
} from './pondMath';
import styles from './PondView.module.css';

/**
 * PondView — the journal drawn as a place.
 *
 * The terrain map draws the CREEK: data moving across the seam between the
 * code and the vault. This is the other half — the POND, where that data comes
 * to rest. Time runs left to right, one column per day, and inside a column
 * every card sits at the hour it was written, so a month of living has a
 * visible shape: the late-night cards low, the morning ones high, a quiet day
 * a nearly empty column.
 *
 * Pick a thread from the rail and its cards join into a line that dips and
 * climbs across the days it touches. That bouncing is the point. A thread
 * surfacing on ten days across a month draws a long, wandering, mostly-silent
 * line — and nothing else in the system shows that shape.
 *
 * Lighting a thread is EMPHASIS, NOT A FILTER: the rest of the pond stays
 * drawn, just quieter. Seeing where a preoccupation sits inside everything
 * else that was happening is the whole reason to draw it in place rather than
 * list it.
 *
 * Reads GET /api/pond/{threads,cards,card/<id>} (routes/pond.py) and nothing
 * else. All positioning maths lives in pondMath.ts and is tested there; this
 * file only draws what comes back and handles what's lit and what's open.
 *
 * Prompt that produced it: "the base files laid out by day and time with
 * threads stored inside of them connected by lines, and you can scroll to the
 * left or right over time and the threads bounce around in the entries."
 */

/** Visible radius of a card. The hit target is much larger — see HIT_R. */
const CARD_R = 3.5;
/** An invisible circle over each card so a 3.5px dot is still tappable on a
 * phone. The dot is the drawing; this is the button. */
const HIT_R = 11;
/** How many threads the rail lists before "show all". Ranked by span, so the
 * ones with a shape worth seeing are always above the fold. */
const RAIL_LIMIT = 14;

export function PondView() {
  const threads = usePondThreads();
  const cards = usePondCards();
  const [lit, setLit] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAllThreads, setShowAllThreads] = useState(false);
  const detail = usePondCard(openId);

  const layout = useMemo(
    () => layoutPond(cards.data?.cards ?? []),
    [cards.data?.cards],
  );
  const litPoints = useMemo(() => threadPoints(layout, lit), [layout, lit]);
  const litIds = useMemo(
    () => new Set(litPoints.map((p) => p.card.id)),
    [litPoints],
  );
  const gridLines = useMemo(() => hourLines(), []);

  const allThreads = threads.data?.threads ?? [];
  const shownThreads = showAllThreads ? allThreads : allThreads.slice(0, RAIL_LIMIT);
  const totalCards = cards.data?.cards.length ?? 0;
  const dayCount = layout.columns.length;

  return (
    <section className={styles.view} aria-label="The pond">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>The pond</h2>
          <p className={styles.sub}>
            {totalCards > 0
              ? `${totalCards.toLocaleString()} cards across ${dayCount} days — where the journal sits.`
              : 'Where the journal sits.'}
          </p>
        </div>
        <Link to="/terrain/map" className={styles.back} aria-label="Back to the terrain map">
          ← Terrain
        </Link>
      </header>

      {cards.isLoading ? <p className={styles.note}>Reading the pond…</p> : null}
      {cards.isError ? <p className={styles.note}>Couldn&rsquo;t read the pond.</p> : null}
      {cards.data && totalCards === 0 ? (
        <p className={styles.note}>No cards in the pool yet.</p>
      ) : null}

      {totalCards > 0 ? (
        <div className={styles.body}>
          {/* The threads, ranked by how many DAYS they touch rather than how
              many cards they have — span is the shape this page is about. */}
          <nav className={styles.rail} aria-label="Threads">
            <button
              type="button"
              className={[styles.thread, lit === null ? styles.threadOn : ''].filter(Boolean).join(' ')}
              aria-pressed={lit === null}
              onClick={() => setLit(null)}
            >
              <span className={styles.threadName}>Everything</span>
              <span className={styles.threadMeta}>{dayCount} days</span>
            </button>
            {shownThreads.map((t) => (
              <button
                key={t.tag}
                type="button"
                className={[styles.thread, lit === t.tag ? styles.threadOn : ''].filter(Boolean).join(' ')}
                aria-pressed={lit === t.tag}
                onClick={() => setLit((cur) => (cur === t.tag ? null : t.tag))}
              >
                <span className={styles.threadName}>{t.tag}</span>
                <span className={styles.threadMeta}>
                  {t.days} {t.days === 1 ? 'day' : 'days'} · {t.cards}
                </span>
              </button>
            ))}
            {allThreads.length > RAIL_LIMIT ? (
              <button
                type="button"
                className={styles.moreThreads}
                onClick={() => setShowAllThreads((v) => !v)}
              >
                {showAllThreads ? 'Show fewer' : `${allThreads.length - RAIL_LIMIT} more`}
              </button>
            ) : null}
          </nav>

          <div className={styles.stage}>
            {/* The clock gutter sits OUTSIDE the scroller so the hours stay put
                while the days pan underneath them. */}
            <svg
              className={styles.gutter}
              width={34}
              height={layout.height}
              aria-hidden="true"
            >
              {gridLines.map((line) => (
                <text key={line.label} x={30} y={line.y + 3} className={styles.hourLabel}>
                  {line.label}
                </text>
              ))}
            </svg>

            <div className={styles.scroller}>
              <svg
                width={layout.width}
                height={layout.height}
                className={styles.canvas}
                role="img"
                aria-label={
                  lit
                    ? `The pond, with the ${lit} thread lit`
                    : 'The pond — every card by day and time'
                }
              >
                {gridLines.map((line) => (
                  <line
                    key={line.label}
                    x1={0}
                    x2={layout.width}
                    y1={line.y}
                    y2={line.y}
                    className={styles.hourLine}
                  />
                ))}

                {layout.columns.map((col, i) => (
                  <text
                    key={col.day}
                    x={col.x}
                    y={14}
                    className={styles.dayLabel}
                    textAnchor="middle"
                  >
                    {dayLabel(col.day, layout.columns[i - 1]?.day)}
                  </text>
                ))}

                {/* The thread's own line, under the cards so the dots stay
                    readable where it passes through them. Drawn across the
                    silences too — the long flat stretch between appearances is
                    part of the thread's shape. */}
                {litPoints.length > 1 ? (
                  <polyline points={polylinePoints(litPoints)} className={styles.threadLine} />
                ) : null}

                {layout.columns.map((col) =>
                  col.cards.map((placed) => {
                    const isLit = litIds.has(placed.card.id);
                    const isOpen = placed.card.id === openId;
                    return (
                      <g key={placed.card.id}>
                        <circle
                          cx={placed.x}
                          cy={placed.y}
                          r={isLit || isOpen ? CARD_R + 1.5 : CARD_R}
                          className={[
                            styles.card,
                            placed.card.who === 'K' ? styles.cardKeeper : styles.cardOwner,
                            lit && !isLit ? styles.cardDimmed : '',
                            isOpen ? styles.cardOpen : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        />
                        {/* The button over the dot. Invisible, generous, and
                            the thing that actually receives a fingertip. */}
                        <circle
                          cx={placed.x}
                          cy={placed.y}
                          r={HIT_R}
                          className={styles.hit}
                          onClick={() => setOpenId((cur) => (cur === placed.card.id ? null : placed.card.id))}
                        >
                          <title>
                            {`${placed.card.day}${placed.card.ts ? ` ${placed.card.ts}` : ''} · ${placed.card.preview}`}
                          </title>
                        </circle>
                      </g>
                    );
                  }),
                )}
              </svg>
            </div>
          </div>

          {openId ? (
            <aside className={styles.detail} aria-label="Card">
              <div className={styles.detailHead}>
                <span className={styles.detailMeta}>
                  {detail.data?.card
                    ? `${detail.data.card.day}${detail.data.card.ts ? ` · ${detail.data.card.ts}` : ''} · ${
                        detail.data.card.who === 'K' ? 'Keeper' : 'You'
                      }`
                    : 'Loading…'}
                </span>
                <button
                  type="button"
                  className={styles.detailClose}
                  onClick={() => setOpenId(null)}
                  aria-label="Close card"
                >
                  ×
                </button>
              </div>
              {detail.isError ? <p className={styles.note}>Couldn&rsquo;t read that card.</p> : null}
              {detail.data?.card ? (
                <>
                  <p className={styles.detailBody}>{detail.data.card.body}</p>
                  {detail.data.card.tags.length > 0 ? (
                    <div className={styles.detailTags}>
                      {detail.data.card.tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className={[styles.tagChip, lit === tag ? styles.tagChipOn : '']
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => setLit((cur) => (cur === tag ? null : tag))}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </aside>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
