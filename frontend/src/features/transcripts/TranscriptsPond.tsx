import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import { ApiError } from '../../api/client';
import {
  DEFAULT_ZOOM,
  POND_ZOOMS,
  UNFILED,
  clockOf,
  dayLabel,
  fitZoom,
  hourLines,
  labelStep,
  layoutPond,
  polylinePoints,
  threadLine,
  threadPoints,
  type PondMode,
} from '../pond/pondMath';
import {
  useConversation,
  useImportExport,
  useStartSort,
  useTranscriptOverview,
  useTranscriptPond,
  type TranscriptCard,
  type TranscriptOverview,
} from './api';
import { railRows, sourceName, speaker, unsortedCount } from './transcriptRail';
import styles from '../pond/PondView.module.css';
import own from './TranscriptsPond.module.css';

/**
 * TranscriptsPond — someone's chatbot history, drawn as the journal's pond.
 *
 * Every message imported from a ChatGPT or Claude.ai export is a card in the
 * pond: time runs left to right, one column per day, and the same two
 * arrangements the journal pond has read down each column — TIME (every
 * message at the hour it was sent, a dot) and WORDS (messages stacked flush,
 * each as tall as it has words). A day spent deep in one conversation stands
 * tall; a month away from the chatbot is a run of empty water.
 *
 * The rail on the left is the TOPICS the user's own AI filed each
 * conversation under (scripts/sort_transcripts.py). Lighting a topic works
 * exactly like lighting a thread in the journal pond — emphasis, not a
 * filter: its messages stay bright with a line running through them, the
 * rest goes quiet, and "Filter" is the one-tap switch to only that topic.
 * A lit topic also lists its conversations under its row, so every topic
 * links straight back to the chats it came from. The search box narrows the
 * pond itself to conversations containing every word.
 *
 * Tap a message and the whole conversation opens beside the pond with that
 * message in view; ‹ › walks the lit topic (or the whole pond) message by
 * message, the same walk the journal pond's card panel has.
 *
 * SAME POND, NOT A COPY. All positioning — where each card goes, the lit
 * line, the hour rules, the zoom steps and the first-open fit — is the
 * journal pond's own code in pond/pondMath.ts, and the drawing wears the
 * journal pond's stylesheet (pond/PondView.module.css). This file only adds
 * what's different: the import and sort controls, the topic rail's rows
 * (transcriptRail.ts), and reading a whole conversation.
 *
 * Importing and reading never need an AI login; only sorting does, and the
 * header says so with a link to Settings rather than hiding the button.
 *
 * Reads routes/transcripts.py through ./api.ts.
 *
 * Prompts that produced it: "some kind of organizational framework … like the
 * journal organized by topic, but for people who want to download all their
 * transcripts from their own chat bots"; "use the same visual as the pond so
 * people can organize along those lines by day and time depending on the
 * format"; "make sure the UI for their organization is similar to the pond UI
 * for the journal."
 */

/** How many rows the rail lists before "show all" — same as the journal pond. */
const RAIL_LIMIT = 12;

/** How far back the pond reaches — the journal pond's presets. */
const RANGES = [
  { key: 'all', label: 'All', days: null as number | null },
  { key: '90', label: '90d', days: 90 },
  { key: '30', label: '30d', days: 30 },
];

/** The popup's fixed width; must match .hoverCard in the pond's CSS. */
const POPUP_W = 272;

/** How long typing pauses before the search runs — a debounce. */
const SEARCH_DEBOUNCE_MS = 300;

const VIEW_KEY = 'transcripts-pond-view';

interface SavedView {
  mode?: PondMode;
  zoom?: number;
  range?: string;
  hideReplies?: boolean;
}

function loadView(): SavedView {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as SavedView;
  } catch {
    return {};
  }
}

/** What's lit — a rail row's key, a label to say so, and the tags it covers. */
interface Lit {
  key: string;
  label: string;
  tags: Set<string>;
}

/** The open conversation, and which message in it was tapped (null = none). */
interface Open {
  conv: number;
  cardId: string | null;
}

const whoDotClass = (who: string) => (who === 'K' ? styles.fromKeeper : styles.fromOwner);
const whoHoverClass = (who: string) =>
  who === 'K' ? styles.hoverDotKeeper : styles.hoverDotOwner;

export function TranscriptsPond() {
  // Read once; the states below seed from it so the pond comes back the way it was left.
  const [saved] = useState(loadView);
  const [mode, setMode] = useState<PondMode>(saved.mode === 'words' ? 'words' : 'clock');
  const [zoom, setZoom] = useState(() =>
    saved.zoom != null ? Math.max(0, Math.min(POND_ZOOMS.length - 1, saved.zoom)) : DEFAULT_ZOOM,
  );
  const [range, setRange] = useState(() =>
    RANGES.some((r) => r.key === saved.range) ? (saved.range as string) : 'all',
  );
  const [hideReplies, setHideReplies] = useState(saved.hideReplies === true);
  const [onlyLit, setOnlyLit] = useState(false);
  const [lit, setLit] = useState<Lit | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [hover, setHover] = useState<{ card: TranscriptCard; x: number; y: number; flip: boolean } | null>(null);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  // Run the search once typing pauses — a debounce, so each keystroke isn't a request.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const rangeDays = RANGES.find((r) => r.key === range)?.days ?? null;
  const from = useMemo(
    () =>
      rangeDays === null
        ? null
        : new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 10),
    [rangeDays],
  );
  const overview = useTranscriptOverview();
  const pond = useTranscriptPond(from, search);
  const conversation = useConversation(open?.conv ?? null);
  const importer = useImportExport();
  const sorter = useStartSort();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const fitTarget = useRef<number | null>(null);
  const skipZoomPick = useRef(saved.zoom != null);
  const keepCentre = useRef<{ fx: number; fy: number } | null>(null);
  const openMessageRef = useRef<HTMLDivElement>(null);

  const z = POND_ZOOMS[zoom];
  const geom = mode === 'clock' ? z.clock : z.words;
  const litTags = lit?.tags ?? null;
  // Hiding only bites when something is lit — otherwise it would blank the page.
  const hiding = onlyLit && litTags !== null;
  // A long message in words mode windows onto the searched words, the way a
  // journal card windows onto its lit thread's words.
  const searchWords = useMemo(() => search.toLowerCase().match(/\w+/g) ?? [], [search]);

  // The chatbot's replies, toggleable out of the water — subtraction, not
  // emphasis: with them off the pond is only what the user asked.
  const visibleCards = useMemo(() => {
    const all = pond.data?.cards ?? [];
    return hideReplies ? all.filter((c) => c.who !== 'K') : all;
  }, [pond.data?.cards, hideReplies]);

  const layout = useMemo(
    () =>
      layoutPond(visibleCards, {
        mode,
        ...geom,
        only: hiding ? litTags : null,
        terms: searchWords.length ? searchWords : null,
      }),
    [visibleCards, mode, geom, hiding, litTags, searchWords],
  );
  const litIds = useMemo(
    () => new Set(threadPoints(layout, litTags).map((p) => p.card.id)),
    [layout, litTags],
  );
  const line = useMemo(() => threadLine(layout, litTags), [layout, litTags]);
  const gridLines = useMemo(
    () => hourLines({ mode, dayHeight: z.clock.dayHeight }),
    [mode, z.clock.dayHeight],
  );
  const step = labelStep(layout.colWidth);
  // How far past the dot the invisible tap target reaches — the journal pond's rule.
  const hitPad =
    mode === 'clock'
      ? Math.max(2, Math.min(6, (z.clock.colWidth - z.clock.dotSize) / 2 + 2))
      : 0;

  // Frame the whole pond on first paint: the widest zoom where every day fits.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const cards = pond.data?.cards ?? [];
    if (fitted.current || !el || cards.length === 0) return;
    fitted.current = true;
    let best = zoom;
    if (skipZoomPick.current) {
      skipZoomPick.current = false;
    } else {
      best = fitZoom(new Set(cards.map((c) => c.day)).size, el.clientWidth);
    }
    fitTarget.current = best;
    setZoom(best);
  }, [pond.data, zoom]);

  // Once the fitted zoom is drawn, centre on the days and on where the dots
  // actually sit; after a manual zoom, keep the same spot under the eye.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && fitTarget.current !== null && zoom === fitTarget.current) {
      fitTarget.current = null;
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
      const ys = layout.columns.flatMap((c) => c.cards.map((p) => p.y));
      const meanY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
      el.scrollTop = Math.max(0, meanY - el.clientHeight / 2);
    }
    const k = keepCentre.current;
    if (el && k) {
      keepCentre.current = null;
      el.scrollLeft = Math.max(0, k.fx * el.scrollWidth - el.clientWidth / 2);
      el.scrollTop = Math.max(0, k.fy * el.scrollHeight - el.clientHeight / 2);
    }
  }, [zoom, layout]);

  // Remember how the pond is looked at — not where it was scrolled, not what's lit.
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ mode, zoom, range, hideReplies }));
    } catch {
      // Storage blocked — the pond just won't remember.
    }
  }, [mode, zoom, range, hideReplies]);

  // Bring the tapped message into view once its conversation has loaded.
  useEffect(() => {
    openMessageRef.current?.scrollIntoView({ block: 'center' });
  }, [conversation.data, open?.cardId]);

  function changeZoom(next: number) {
    const el = scrollerRef.current;
    if (el) {
      keepCentre.current = {
        fx: (el.scrollLeft + el.clientWidth / 2) / Math.max(1, el.scrollWidth),
        fy: (el.scrollTop + el.clientHeight / 2) / Math.max(1, el.scrollHeight),
      };
    }
    setZoom(next);
  }

  function changeRange(next: string) {
    if (next === range) return;
    setRange(next);
    fitted.current = false;
  }

  function toggle(row: { key: string; name: string; tags: Set<string> }) {
    setLit((cur) => (cur?.key === row.key ? null : { key: row.key, label: row.name, tags: row.tags }));
  }

  function showHover(el: Element, card: TranscriptCard) {
    const r = el.getBoundingClientRect();
    const flip = r.right + POPUP_W + 16 > window.innerWidth;
    setHover({ card, x: flip ? r.left : r.right, y: r.top, flip });
  }

  function importFile(file: File | undefined) {
    if (!file) return;
    setNotice({ error: false, text: `Reading ${file.name}…` });
    importer.mutate(file, {
      onSuccess: (r) =>
        setNotice({
          error: false,
          text: `Read ${r.read} conversations: ${r.added} new, ${r.updated} updated, ${r.unchanged} already here.`,
        }),
      onError: (e) =>
        setNotice({ error: true, text: e instanceof ApiError ? e.message : 'Upload failed.' }),
    });
  }

  function startSort() {
    setNotice(null);
    sorter.mutate(undefined, {
      onError: (e) =>
        setNotice({ error: true, text: e instanceof ApiError ? e.message : 'Couldn’t start the sort.' }),
    });
  }

  // The walk ‹ › follows: the lit topic's messages when the open one is on
  // it, the whole pond otherwise — the journal pond's card walk.
  const openCardId = open?.cardId ?? null;
  const walk = useMemo(() => {
    const onTopic = openCardId !== null && litIds.has(openCardId);
    const seq = onTopic && litTags ? threadPoints(layout, litTags) : layout.columns.flatMap((c) => c.cards);
    return seq.map((p) => p.card as TranscriptCard);
  }, [layout, litTags, litIds, openCardId]);
  const walkAt = openCardId ? walk.findIndex((c) => c.id === openCardId) : -1;
  const walkingTopic = openCardId !== null && litIds.has(openCardId) && lit !== null;

  const topics = overview.data?.topics ?? [];
  const rows = useMemo(() => railRows(topics, visibleCards), [topics, visibleCards]);
  const shown = showAll ? rows : rows.slice(0, RAIL_LIMIT);
  const unfiled = useMemo(() => unsortedCount(visibleCards), [visibleCards]);
  const totalCards = visibleCards.length;
  const dayCount = layout.columns.length;
  const empty = overview.data && overview.data.stats.conversations === 0;
  const openSeq = openCardId ? Number(openCardId.split(':')[1]) : null;

  return (
    <section className={styles.view} aria-label="Transcripts">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>Transcripts</h2>
          <p className={styles.sub}>
            {totalCards > 0
              ? `${totalCards.toLocaleString()} messages across ${dayCount} days${
                  lit ? ` — ${lit.label} lit` : ''
                }`
              : 'Your chatbot history, by day and by topic.'}
          </p>
        </div>

        <div className={styles.controls}>
          {/* Search narrows the pond itself to conversations holding every word. */}
          <input
            type="search"
            className={own.search}
            value={typed}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            onChange={(e) => setTyped(e.target.value)}
          />

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
              onClick={() => changeZoom(Math.max(0, zoom - 1))}
            >
              −
            </button>
            <span className={styles.zoomPips} aria-hidden="true">
              {POND_ZOOMS.map((_, i) => (
                <span key={i} className={i === zoom ? styles.pipOn : styles.pip} />
              ))}
            </span>
            <button
              type="button"
              className={styles.seg}
              disabled={zoom === POND_ZOOMS.length - 1}
              aria-label="Zoom in"
              onClick={() => changeZoom(Math.min(POND_ZOOMS.length - 1, zoom + 1))}
            >
              +
            </button>
          </div>

          {/* The chatbot's voice, toggleable out of the water; struck through when hidden. */}
          <button
            type="button"
            className={hideReplies ? styles.keeperOff : styles.keeperOn}
            aria-pressed={hideReplies}
            aria-label={hideReplies ? 'Show the chatbot’s replies' : 'Hide the chatbot’s replies'}
            onClick={() => setHideReplies((v) => !v)}
          >
            Replies
          </button>

          {lit ? (
            <button
              type="button"
              className={onlyLit ? styles.onlyOn : styles.only}
              aria-pressed={onlyLit}
              aria-label={`Filter to ${lit.label}`}
              onClick={() => setOnlyLit((v) => !v)}
            >
              Filter
            </button>
          ) : null}

          <label className={own.action}>
            Import
            <input
              type="file"
              accept=".zip,.json,application/zip,application/json"
              className={own.fileInput}
              disabled={importer.isPending}
              onChange={(e) => {
                importFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </header>

      <SortLine overview={overview.data} starting={sorter.isPending} onSort={startSort} />
      {notice ? (
        <p className={notice.error ? own.noticeError : own.notice} role="status">
          {notice.text}
        </p>
      ) : null}

      {empty ? <Welcome onFile={importFile} busy={importer.isPending} /> : null}
      {pond.isError ? <p className={styles.note}>Couldn&rsquo;t read the transcripts.</p> : null}
      {!empty && pond.data && totalCards === 0 ? (
        <p className={styles.note}>{search ? `Nothing matches “${search}”.` : 'Nothing in this window.'}</p>
      ) : null}
      {pond.data?.truncated ? (
        <p className={styles.note}>
          Showing the newest {totalCards.toLocaleString()} messages — narrow the range or search to
          see further back.
        </p>
      ) : null}

      {totalCards > 0 ? (
        <div className={styles.body}>
          <nav className={styles.rail} aria-label="Topics">
            <div className={styles.railList}>
              <button
                type="button"
                className={[styles.thread, lit === null ? styles.threadOn : ''].filter(Boolean).join(' ')}
                aria-pressed={lit === null}
                onClick={() => setLit(null)}
              >
                <span className={styles.threadName}>Everything</span>
                <span className={styles.threadMeta}>{dayCount} days</span>
              </button>
              {unfiled.messages > 0 ? (
                <button
                  type="button"
                  className={[styles.thread, lit?.key === 'unfiled' ? styles.threadOn : '']
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={lit?.key === 'unfiled'}
                  onClick={() => toggle({ key: 'unfiled', name: 'Unsorted', tags: new Set([UNFILED]) })}
                >
                  <span className={styles.threadName}>Unsorted</span>
                  <span className={styles.threadMeta}>
                    {unfiled.days} {unfiled.days === 1 ? 'day' : 'days'} · {unfiled.messages}
                  </span>
                </button>
              ) : null}
              {shown.map((row) => (
                <div key={row.key}>
                  <button
                    type="button"
                    className={[styles.thread, lit?.key === row.key ? styles.threadOn : '']
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={lit?.key === row.key}
                    onClick={() => toggle({ key: row.key, name: row.name, tags: new Set([row.tag]) })}
                  >
                    <span className={styles.threadName}>{row.name}</span>
                    <span className={styles.threadMeta}>
                      {row.days} {row.days === 1 ? 'day' : 'days'} · {row.messages}
                    </span>
                  </button>
                  {/* A lit topic links back to every conversation filed under it. */}
                  {lit?.key === row.key ? (
                    <div className={own.sources}>
                      {row.conversations.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className={open?.conv === c.id ? own.sourceOn : own.source}
                          onClick={() => setOpen({ conv: c.id, cardId: null })}
                        >
                          {c.title}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {rows.length === 0 && unfiled.messages === 0 ? (
                <p className={styles.railEmpty}>No topics yet.</p>
              ) : null}
              {rows.length > RAIL_LIMIT ? (
                <button type="button" className={styles.moreThreads} onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `${rows.length - RAIL_LIMIT} more`}
                </button>
              ) : null}
            </div>
          </nav>

          <div className={styles.stage}>
            {/* The clock gutter sits outside the horizontal scroller so the
                hours stay put while the days pan (the journal pond's layout). */}
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
                setHover(null);
              }}
            >
              <div
                className={styles.canvas}
                style={{ width: layout.width, height: layout.height }}
                role="group"
                aria-label={lit ? `The pond, with ${lit.label} lit` : 'The pond — every message by day'}
              >
                <svg className={styles.underlay} width={layout.width} height={layout.height} aria-hidden="true">
                  {gridLines.map((l) => (
                    <line key={l.label} x1={0} x2={layout.width} y1={l.y} y2={l.y} className={styles.hourLine} />
                  ))}
                  {line.length > 1 ? (
                    <polyline points={polylinePoints(line)} className={styles.threadLine} />
                  ) : null}
                </svg>

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
                  col.cards.map((placed) => {
                    const card = placed.card as TranscriptCard;
                    const isLit = litIds.has(card.id);
                    return (
                      <button
                        key={card.id}
                        type="button"
                        className={[
                          mode === 'clock' ? styles.dot : styles.wordCard,
                          whoDotClass(card.who),
                          lit && !isLit ? styles.dimmed : '',
                          isLit && !hiding ? styles.onThread : '',
                          card.id === openCardId ? styles.open : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        style={{
                          left: placed.x,
                          top: placed.y,
                          width: placed.w,
                          height: placed.h,
                          ...(mode === 'words'
                            ? { fontSize: z.words.fontSize }
                            : { ['--hit' as string]: `${hitPad}px` }),
                        }}
                        aria-label={`${speaker(card)}, ${card.day}${clockOf(card.ts) ? ` ${clockOf(card.ts)}` : ''}`}
                        onClick={() =>
                          setOpen((cur) =>
                            cur?.cardId === card.id ? null : { conv: card.conv, cardId: card.id },
                          )
                        }
                        onMouseEnter={mode === 'clock' ? (e) => showHover(e.currentTarget, card) : undefined}
                        onMouseLeave={mode === 'clock' ? () => setHover(null) : undefined}
                        onFocus={mode === 'clock' ? (e) => showHover(e.currentTarget, card) : undefined}
                        onBlur={mode === 'clock' ? () => setHover(null) : undefined}
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

          {/* The hover tooltip, the journal pond's own — portaled so the scroller can't clip it. */}
          {hover
            ? createPortal(
                <div
                  className={styles.hoverCard}
                  style={{
                    left: hover.flip ? hover.x - POPUP_W - 10 : hover.x + 10,
                    top: Math.max(8, Math.min(hover.y - 12, window.innerHeight - 300)),
                  }}
                >
                  <div className={styles.hoverHead}>
                    <span className={whoHoverClass(hover.card.who)} aria-hidden="true" />
                    <span className={styles.hoverTitle}>
                      {dayLabel(hover.card.day)}
                      {clockOf(hover.card.ts) ? ` · ${clockOf(hover.card.ts)}` : ''}
                      {` · ${speaker(hover.card)}`}
                    </span>
                  </div>
                  <div className={styles.hoverBody}>{hover.card.body}</div>
                  {hover.card.tags.length > 0 ? (
                    <div className={styles.hoverThreads}>
                      <div className={styles.hoverLabel}>topics</div>
                      <div className={styles.hoverTags}>
                        {hover.card.tags
                          .map((tag) => topics.find((t) => t.tag === tag)?.name ?? tag)
                          .join(' · ')}
                      </div>
                    </div>
                  ) : null}
                </div>,
                document.body,
              )
            : null}

          {open ? (
            <aside className={styles.detail} aria-label="Conversation">
              <div className={styles.detailHead}>
                <span className={styles.detailMeta}>
                  {conversation.data
                    ? `${sourceName(conversation.data.source)} · ${conversation.data.messages.length} messages`
                    : 'Loading…'}
                </span>
                <button
                  type="button"
                  className={styles.detailClose}
                  onClick={() => setOpen(null)}
                  aria-label="Close conversation"
                >
                  ×
                </button>
              </div>

              {walkAt !== -1 && walk.length > 1 ? (
                <div className={styles.detailNav}>
                  <button
                    type="button"
                    className={styles.navBtn}
                    disabled={walkAt <= 0}
                    aria-label="Previous message"
                    onClick={() => setOpen({ conv: walk[walkAt - 1].conv, cardId: walk[walkAt - 1].id })}
                  >
                    ‹
                  </button>
                  <span className={styles.navWhere}>
                    {walkAt + 1} of {walk.length}
                    {walkingTopic ? ` in ${lit!.label}` : ''}
                  </span>
                  <button
                    type="button"
                    className={styles.navBtn}
                    disabled={walkAt >= walk.length - 1}
                    aria-label="Next message"
                    onClick={() => setOpen({ conv: walk[walkAt + 1].conv, cardId: walk[walkAt + 1].id })}
                  >
                    ›
                  </button>
                </div>
              ) : null}

              {conversation.isError ? <p className={styles.note}>Couldn&rsquo;t read that conversation.</p> : null}
              {conversation.data ? (
                <>
                  <h3 className={own.convTitle}>{conversation.data.title}</h3>
                  {conversation.data.summary ? (
                    <p className={own.summary}>{conversation.data.summary}</p>
                  ) : null}
                  {/* Its topics — tap one to light it on the pond. */}
                  <div className={styles.detailTags}>
                    {conversation.data.topics.map((t) => (
                      <button
                        key={t.tag}
                        type="button"
                        className={[styles.tagChip, lit?.key === `topic:${t.tag}` ? styles.tagChipOn : '']
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => toggle({ key: `topic:${t.tag}`, name: t.name, tags: new Set([t.tag]) })}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                  <div className={own.messages}>
                    {conversation.data.messages.map((m) => (
                      <div
                        key={m.seq}
                        ref={m.seq === openSeq ? openMessageRef : undefined}
                        className={[
                          own.message,
                          m.role === 'user' ? own.fromUser : own.fromBot,
                          m.seq === openSeq ? own.messageOpen : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <div className={own.messageMeta}>
                          {m.role === 'user' ? 'You' : sourceName(conversation.data!.source)}
                          {m.ts ? ` · ${dayLabel(m.ts.slice(0, 10))} ${clockOf(m.ts)}` : ''}
                        </div>
                        <div className={own.messageText}>{m.text}</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </aside>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The sorter's line under the header: what's waiting, what's running, what
 * went wrong — and the one button. Signed out, it says where to sign in
 * instead of hiding the button, so the next step is always on screen.
 */
function SortLine({
  overview,
  starting,
  onSort,
}: {
  overview: TranscriptOverview | undefined;
  starting: boolean;
  onSort: () => void;
}) {
  if (!overview || overview.stats.conversations === 0) return null;
  const { sort, stats, llm } = overview;
  const provider = sourceName(llm.provider);
  if (sort.running) {
    return (
      <p className={own.notice} role="status">
        Sorting into topics… {sort.done ?? 0} of {sort.total ?? stats.unsorted}
      </p>
    );
  }
  const failed =
    sort.state === 'failed'
      ? `The last sort stopped: ${sort.error ?? 'unknown error'}.`
      : sort.state === 'stopped'
        ? 'The last sort stopped partway.'
        : null;
  if (stats.unsorted === 0) {
    return failed ? <p className={own.noticeError}>{failed}</p> : null;
  }
  return (
    <div className={own.sortLine}>
      <span className={failed ? own.noticeError : own.notice}>
        {failed ? `${failed} ` : ''}
        {stats.unsorted.toLocaleString()} {stats.unsorted === 1 ? 'conversation isn’t' : 'conversations aren’t'} in
        topics yet.
      </span>
      {llm.signed_in ? (
        <button type="button" className={own.action} disabled={starting} onClick={onSort}>
          Sort with {provider}
        </button>
      ) : (
        <Link to="/settings" className={own.action}>
          Sign in to {provider} to sort
        </Link>
      )}
    </div>
  );
}

/** The empty pond: where to get an export, and the door to bring it in. */
function Welcome({ onFile, busy }: { onFile: (file: File | undefined) => void; busy: boolean }) {
  return (
    <div className={own.welcome}>
      <h3 className={own.convTitle}>Bring in your chatbot history</h3>
      <p>
        Download your data from the chatbot, then choose the file it sends you — the whole
        <code> .zip</code>, or the <code>conversations.json</code> inside it.
      </p>
      <ul className={own.steps}>
        <li>
          <strong>ChatGPT:</strong> Settings → Data controls → Export data
        </li>
        <li>
          <strong>Claude:</strong> Settings → Privacy → Export data
        </li>
      </ul>
      <p>
        Every message lands in the pond on the day it was sent. Sorting into topics uses your own AI
        subscription, and it's optional: the pond is readable without it.
      </p>
      <label className={own.action}>
        {busy ? 'Reading…' : 'Choose export file'}
        <input
          type="file"
          accept=".zip,.json,application/zip,application/json"
          className={own.fileInput}
          disabled={busy}
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
    </div>
  );
}
