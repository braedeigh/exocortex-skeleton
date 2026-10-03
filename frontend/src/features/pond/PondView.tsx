import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import {
  usePondCard,
  usePondCards,
  usePondThreads,
  usePondWorking,
  useRetagCard,
} from './api';
import type { PondFront, PondKind, PondThread } from './api';
import {
  DEFAULT_ZOOM,
  POND_ZOOMS as ZOOMS,
  UNFILED,
  clockOf,
  fitZoom,
  dayLabel,
  hourLines,
  labelStep,
  layoutPond,
  layoutWorking,
  polylinePoints,
  threadLine,
  threadPoints,
  filesBySession,
  workingDays,
  writeWeight,
} from './pondMath';
import type { PondFileEvent, PondMode, PondSession, PondTurn, PondWrite } from './pondMath';
import { loadPondView, POND_VIEW_KEY, type WorkLayer } from './savedView';
import { FileCodeBody } from '../terrain/FileCodeBody';
import styles from './PondView.module.css';

// Who a card is from, as the pond names and draws it: her, the Keeper, or the
// system (a reminder the app sent). One place, so the dot, the hover and the
// detail panel can't disagree — they used to call everything not the
// Keeper's "You", which would have put system reminders in her voice.
const WHO_NAME: Record<string, string> = { B: 'You', K: 'Keeper', S: 'System' };
const whoName = (who: string) => WHO_NAME[who] ?? 'You';
const whoDotClass = (who: string) =>
  who === 'K' ? styles.fromKeeper : who === 'S' ? styles.fromSystem : styles.fromOwner;
const whoHoverClass = (who: string) =>
  who === 'K' ? styles.hoverDotKeeper : who === 'S' ? styles.hoverDotSystem : styles.hoverDotOwner;

/**
 * PondView — the journal drawn as a place.
 *
 * The terrain map draws the CREEK: data moving across the seam between the
 * code and the vault. This is the other half — the POND, where that data comes
 * to rest. Time runs left to right, one column per day, and you choose what
 * runs DOWN the column:
 *
 *   TIME  — every card at the hour it was written. The shape of *when*: late
 *           cards low, morning cards high, a quiet day nearly empty. Cards are
 *           dots, because at that density nothing else would read.
 *   WORDS — the clock dropped, cards stacked flush and set in tiny type, each
 *           as tall as it has words. The shape of *how much*: a day she poured
 *           out is a long ribbon of text, a thin day is a stub. This is the
 *           arrangement you can actually READ the pond in.
 *
 * The rail down the left is sorted the way the VAULT already sorts things,
 * rather than as one flat run of ninety tags: FRONTS (life domains, each
 * holding the threads filed under it), THREADS, PEOPLE, and LOOSE for whatever
 * was never filed. Lighting a front lights all its threads at once.
 *
 * Lighting anything is EMPHASIS, NOT A FILTER: the rest of the pond stays
 * drawn, just quieter. Seeing where a preoccupation sits inside everything else
 * that was happening is the whole reason to draw it in place rather than list
 * it.
 *
 * Reads GET /api/pond/{threads,cards,card/<id>} (routes/pond.py) and nothing
 * else. All positioning maths lives in pondMath.ts and is tested there; this
 * file only draws what comes back and handles what's lit and what's open.
 *
 * Prompt that produced it: "make it so it can be organized by time or just by
 * the words in the journal — I want the words to be tiny and the cards to show.
 * And I want the thread filters sorted by person and front, so I can sort by
 * people or threads."
 */

/** How many rows the rail lists in a group before "show all". */
const RAIL_LIMIT = 12;


/** The rail's shelves, in the order she reads them. */
const GROUPS: { key: PondKind | 'front'; label: string }[] = [
  { key: 'front', label: 'Fronts' },
  { key: 'thread', label: 'Threads' },
  { key: 'person', label: 'People' },
  { key: 'topic', label: 'Loose' },
];

/** The window presets — how far back the pond reaches. Server-side (`from=`),
 * so the payload stays bounded as the journal grows: the API truncates at
 * 4,000 cards, and "All" will cross that line eventually. */
const RANGES = [
  { key: 'all', label: 'All', days: null as number | null },
  { key: '90', label: '90d', days: 90 },
  { key: '30', label: '30d', days: 30 },
];

/**
 * The working half, as three switchable layers.
 *
 * They are separate switches rather than one because they answer three
 * different questions and she won't always want all three: "when was I at the
 * keyboard", "when did files change", "how long did I leave that open". All
 * three ride TIME mode only — words mode has no clock, so there is nowhere
 * honest to put a moment.
 *
 * One colour between them (`--ongoing`, the teal already in her palette), not
 * one each. The pond's standing rule is that the page carries exactly one
 * saturated colour and it belongs to whatever is LIT; the working half gets
 * the second and last hue in the system, and tells its three parts apart by
 * SHAPE — dot, tick, hairline — the way the journal tells hers from the
 * Keeper's without a second colour.
 */
const WORK_LAYERS: { key: WorkLayer; label: string; hint: string }[] = [
  { key: 'turns', label: 'Messages', hint: 'When you were talking to an agent' },
  { key: 'writes', label: 'Files', hint: 'When files were written, deleted, or moved' },
  { key: 'sessions', label: 'Open', hint: 'How long each session sat open' },
];

/** All on. She asked for this half of the page to exist; shipping it hidden
 * behind three switches she'd have to find is shipping it off. */
const WORK_DEFAULT: Record<WorkLayer, boolean> = {
  turns: true, writes: true, sessions: true,
};

// How the pond was left lives in savedView.ts, not here — the pond landmark
// floating on the terrain map reads the same settings to label itself, and one
// localStorage key read by hand in two places is two copies free to drift.

/** What the hover popup needs from a card — a plain slice of PondCard. */
interface PondCardHover {
  id: string;
  day: string;
  ts: string | null;
  who: string;
  tags: string[];
  body: string;
}

/** What's currently lit — a label to say so, and the set of tags it covers.
 * A front covers many tags; a thread or a person covers one. */
interface Lit {
  key: string;
  label: string;
  tags: Set<string>;
  /** The words a long card's excerpt centres on — every lit tag's, pooled. */
  terms: string[];
}

/** What a message mark says when you point at it. The session's own title is
 * the only context a bare moment has — without it a dot is just "something
 * happened here". */
function workTitle(turn: PondTurn, sessions: Map<string, PondSession>): string {
  const clock = clockOf(turn.ts) ?? '';
  const session = sessions.get(turn.session);
  return `${clock} — you wrote to ${session?.title || turn.session}`;
}

/**
 * What a file mark says. It names its own limit out loud: the footprints
 * harvest keeps one row per session per file, so this is the LAST time that
 * session touched that file, not every time it did. A drawing that implied a
 * complete edit history would be claiming more than the data knows.
 */
function writeTitle(write: PondWrite, sessions: Map<string, PondSession>): string {
  const clock = clockOf(write.ts) ?? '';
  const session = sessions.get(write.session);
  const count = write.writes === 1 ? '1 write' : `${write.writes} writes`;
  const born = write.creates > 0 ? ', created' : '';
  return `${clock} — ${write.repo}/${write.path} (${count}${born}, last touch)`
    + `\n${session?.title || write.session}`;
}

/** What a delete or move mark says. No session to name — commits don't line
 * up with sessions — so the commit subject is the only context it has. */
function eventTitle(event: PondFileEvent): string {
  const clock = clockOf(event.ts) ?? '';
  const verb = event.kind === 'delete' ? 'deleted' : 'moved to';
  return `${clock} — ${verb} ${event.repo}/${event.path} (at commit time)`
    + `\n${event.commit}`;
}

/**
 * WorkDetail — what one tap on the working lane opens.
 *
 * A mark on that lane is a moment with almost no text on it, so the panel's job
 * is to answer the two questions the mark can't: WHAT was touched, and WHICH
 * session did it. Both are already in the payload — this reads it, it doesn't
 * fetch — except the file's own contents, which come from the terrain file
 * endpoint through FileCodeBody, the same viewer the map's tap-a-node modal
 * and the /code page use.
 *
 * THE HONEST LIMIT, and it's printed on the panel rather than buried here: the
 * code shown is the file AS IT IS NOW, not the change that session made. No
 * diff exists to show. `session_files` records which file was touched, how many
 * times, and when it was last touched — not what the text became. Git has
 * diffs but its commits don't line up with sessions (that's why commits were
 * left off this page in the first place). A panel that opened a file under the
 * heading "what was edited" and quietly showed today's version would be the
 * most plausible-looking lie on the page.
 */
function WorkDetail({
  open,
  sessions,
  sessionFiles,
  onClose,
  onPickFile,
}: {
  open:
    | { kind: 'write'; write: PondWrite }
    | { kind: 'turn'; turn: PondTurn }
    | { kind: 'event'; event: PondFileEvent };
  sessions: Map<string, PondSession>;
  sessionFiles: Map<string, PondWrite[]>;
  onClose: () => void;
  onPickFile: (w: PondWrite) => void;
}) {
  if (open.kind === 'event') {
    const e = open.event;
    return (
      <>
        <div className={styles.detailHead}>
          <span className={styles.detailMeta}>
            {dayLabel(e.ts.slice(0, 10))}
            {clockOf(e.ts) ? ` · ${clockOf(e.ts)}` : ''}
            {` · file ${e.kind === 'delete' ? 'deleted' : 'moved'}`}
          </span>
          <button
            type="button"
            className={styles.detailClose}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className={styles.workFileLine}>
          <span className={styles.workRepo}>{e.repo}</span>
          <span className={styles.workPath}>
            {e.kind === 'move' ? `now at ${e.path}` : e.path}
          </span>
        </div>
        {e.commit ? <p className={styles.workCounts}>{e.commit}</p> : null}
        {/* The two honest limits, printed where they apply — same policy as
            the no-diff caveat below. */}
        <p className={styles.workCaveat}>
          Stamped at the commit that recorded it — the vault commits hourly, so
          the act may be up to an hour earlier. No session is named: commits
          don&apos;t line up with sessions.
        </p>
      </>
    );
  }

  const sessionId = open.kind === 'write' ? open.write.session : open.turn.session;
  const session = sessions.get(sessionId);
  const files = sessionFiles.get(sessionId) ?? [];
  const when = open.kind === 'write' ? open.write.ts : open.turn.ts;

  return (
    <>
      <div className={styles.detailHead}>
        <span className={styles.detailMeta}>
          {dayLabel(when.slice(0, 10))}
          {clockOf(when) ? ` · ${clockOf(when)}` : ''}
          {` · ${open.kind === 'write' ? 'file written' : 'you wrote to an agent'}`}
        </span>
        <button
          type="button"
          className={styles.detailClose}
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Which session. The title is the session's own, and the two clocks are
          different facts: how long it sat open, and it is not the same as how
          long it worked. */}
      <div className={styles.workSession}>
        <div className={styles.workSessionName}>{session?.title || sessionId}</div>
        <div className={styles.workSessionMeta}>
          {session ? (
            <>
              {session.is_keeper ? 'keeper · ' : ''}
              {session.lane ? `${session.lane} · ` : ''}
              open {clockOf(session.started)}–{clockOf(session.last_at)}
              {session.worked_from && session.worked_to
                ? ` · wrote files ${clockOf(session.worked_from)}–${clockOf(session.worked_to)}`
                : ' · wrote no files'}
            </>
          ) : (
            'session not in this window'
          )}
        </div>
      </div>

      {open.kind === 'write' ? (
        <>
          <div className={styles.workFileLine}>
            <span className={styles.workRepo}>{open.write.repo}</span>
            <span className={styles.workPath}>{open.write.path}</span>
          </div>
          <p className={styles.workCounts}>
            {open.write.writes} {open.write.writes === 1 ? 'write' : 'writes'}
            {open.write.creates > 0 ? ' · created here' : ''}
            {' · last touched by this session at '}
            {clockOf(open.write.ts)}
          </p>
          {/* Said plainly, every time, because the heading invites the opposite
              reading. */}
          <p className={styles.workCaveat}>
            The file as it is now — not the change made at this moment. Nothing
            records the diff.
          </p>
          <div className={styles.workCode}>
            <FileCodeBody repo={open.write.repo} path={open.write.path} />
          </div>
        </>
      ) : null}

      {/* Everything else that session worked on — the context a single mark
          can't carry. Heaviest first: the file it wrote forty times is what it
          was really doing. */}
      {files.length > 0 ? (
        <div className={styles.workFiles}>
          <div className={styles.workFilesLabel}>
            {files.length} {files.length === 1 ? 'file' : 'files'} in this session
          </div>
          {files.map((f) => (
            <button
              key={`${f.repo}:${f.path}`}
              type="button"
              className={
                open.kind === 'write' && f.path === open.write.path && f.repo === open.write.repo
                  ? styles.workFileRowOn
                  : styles.workFileRow
              }
              onClick={() => onPickFile(f)}
            >
              <span className={styles.workFileName}>{f.path}</span>
              <span className={styles.workFileWrites}>{f.writes}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.workCaveat}>This session wrote no files.</p>
      )}
    </>
  );
}

export function PondView() {
  // Read once; the states below seed from it so the pond comes back up the
  // way she left it.
  const [saved] = useState(loadPondView);
  const [mode, setMode] = useState<PondMode>(saved.mode === 'words' ? 'words' : 'clock');
  const [zoom, setZoom] = useState(() =>
    saved.zoom != null ? Math.max(0, Math.min(ZOOMS.length - 1, saved.zoom)) : DEFAULT_ZOOM,
  );
  const [range, setRange] = useState(() =>
    RANGES.some((r) => r.key === saved.range) ? (saved.range as string) : 'all',
  );
  const [onlyLit, setOnlyLit] = useState(false);
  const [hideKeeper, setHideKeeper] = useState(saved.hideKeeper === true);
  const [group, setGroup] = useState<PondKind | 'front'>(
    GROUPS.some((g) => g.key === saved.group) ? saved.group! : 'front',
  );
  const [lit, setLit] = useState<Lit | null>(null);
  const [layers, setLayers] = useState<Record<WorkLayer, boolean>>(() => ({
    ...WORK_DEFAULT, ...(saved.layers ?? {}),
  }));

  const rangeDays = RANGES.find((r) => r.key === range)?.days ?? null;
  const from = useMemo(
    () =>
      rangeDays === null
        ? null
        : new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 10),
    [rangeDays],
  );
  const threads = usePondThreads(from);
  const cards = usePondCards(from);
  // Only fetched for the arrangement that can draw it, and only while at
  // least one layer is on — a switched-off half of the page shouldn't cost a
  // 300KB request.
  const anyLayer = layers.turns || layers.writes || layers.sessions;
  const working = usePondWorking(from, mode === 'clock' && anyLayer);
  const [openId, setOpenId] = useState<string | null>(null);
  // A tapped working mark. Mutually exclusive with an open card — one detail
  // panel, one subject, so a tap always replaces rather than stacking.
  const [openWork, setOpenWork] = useState<
    | { kind: 'write'; write: PondWrite }
    | { kind: 'turn'; turn: PondTurn }
    | { kind: 'event'; event: PondFileEvent }
    | null
  >(null);
  const [showAll, setShowAll] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');
  // The dot under the pointer, and where to hang its popup (viewport coords —
  // the popup is position:fixed so the scroller can't clip it at the edges).
  const [hover, setHover] = useState<{
    card: PondCardHover;
    x: number;
    y: number;
    flip: boolean;
  } | null>(null);
  const detail = usePondCard(openId);
  const retag = useRetagCard();
  const gutterRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Auto-fit runs once per visit (and again when the window changes); after
  // that the view is hers. A restored zoom skips the zoom-pick but still gets
  // the centering.
  const fitted = useRef(false);
  const fitTarget = useRef<number | null>(null);
  const skipZoomPick = useRef(saved.zoom != null);
  const litRestored = useRef(false);
  // Where the eye was, as fractions of the canvas, carried across a zoom step.
  const keepCentre = useRef<{ fx: number; fy: number } | null>(null);

  const z = ZOOMS[zoom];
  const geom = mode === 'clock' ? z.clock : z.words;
  const litTags = lit?.tags ?? null;
  // Hiding only bites when something is actually lit — otherwise the toggle
  // would blank the page and read as a bug rather than a filter.
  const hiding = onlyLit && litTags !== null;

  // The Keeper's turns, toggleable out of the water entirely. Different move
  // from lighting a thread: dimming is emphasis, this is subtraction — with it
  // off the pond is only her own voice, and everything downstream (the line,
  // the walk, the counts) follows because it all derives from this list.
  const visibleCards = useMemo(() => {
    const all = cards.data?.cards ?? [];
    return hideKeeper ? all.filter((c) => c.who !== 'K') : all;
  }, [cards.data?.cards, hideKeeper]);

  // How far the journal steps left of centre to make room for the working
  // lane. A fraction of a dot, so the two lanes touch and overlap rather than
  // reading as two charts sharing an axis — her call. Zero when no layer is
  // on, which is what keeps the pond pixel-identical to how it drew before.
  const laneShift = mode === 'clock' && anyLayer ? Math.max(1.25, z.clock.dotSize * 0.38) : 0;
  const workingData = working.data ?? null;
  // Days she built on but never wrote on. Doesn't arise yet — the journal has
  // covered every day so far — but the columns have to be able to exist or the
  // marks would land nowhere and silently vanish.
  const extraDays = useMemo(
    () => (anyLayer ? workingDays(workingData) : []),
    [workingData, anyLayer],
  );

  const layout = useMemo(
    () =>
      layoutPond(visibleCards, {
        mode,
        ...geom,
        only: hiding ? litTags : null,
        // A long card windows onto whatever's lit, so lighting a thread
        // re-cuts every long card to the passage that's about it.
        terms: lit?.terms ?? null,
        laneShift,
        extraDays,
      }),
    [visibleCards, mode, geom, hiding, litTags, lit?.terms, laneShift, extraDays],
  );

  // The working half, placed against the SAME columns the journal just got —
  // so a filter, a zoom or a closed day carries both halves together and they
  // can never disagree about which column is which day.
  const work = useMemo(
    () =>
      layoutWorking(layout, anyLayer ? workingData : null, {
        mode,
        ...geom,
        laneShift,
      }),
    [layout, workingData, anyLayer, mode, geom, laneShift],
  );
  const sessionFiles = useMemo(() => filesBySession(workingData), [workingData]);
  const sessionById = useMemo(() => {
    const m = new Map<string, PondSession>();
    for (const s of workingData?.sessions ?? []) m.set(s.id, s);
    return m;
  }, [workingData]);
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
  // How far past the dot the invisible button reaches. Capped at 6px so it
  // never becomes a slab up close, and squeezed toward the dot's own size once
  // the columns get narrow enough that a fat target would spill into its
  // neighbours and make tapping a coin-flip.
  const hitPad =
    mode === 'clock'
      ? Math.max(2, Math.min(6, (z.clock.colWidth - z.clock.dotSize) / 2 + 2))
      : 0;

  // Opening the pond frames the WHOLE of it: pick the widest zoom whose days
  // all fit the viewport at once, then centre. "Where does my journal sit"
  // should be answered by the first paint, not by panning around looking for
  // it. Once only — after that the view is hers to steer.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const n = cards.data?.cards.length ?? 0;
    if (fitted.current || !el || n === 0) return;
    fitted.current = true;
    let best = zoom;
    if (skipZoomPick.current) {
      // A restored zoom is a choice she already made — honour it, centre only.
      skipZoomPick.current = false;
    } else {
      const dayCount = new Set(cards.data!.cards.map((c) => c.day)).size;
      best = fitZoom(dayCount, el.clientWidth);
    }
    fitTarget.current = best;
    setZoom(best);
  }, [cards.data, zoom]);

  // The second half of the fit, once the chosen zoom's layout is on screen:
  // centre the days horizontally, and vertically sit over the mean of the
  // dots — where the journal actually lives (her evenings), not midnight.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && fitTarget.current !== null && zoom === fitTarget.current) {
      fitTarget.current = null;
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
      const ys = layout.columns.flatMap((c) => c.cards.map((p) => p.y));
      const meanY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
      el.scrollTop = Math.max(0, meanY - el.clientHeight / 2);
    }
    // A manual zoom step keeps the view trained on the same spot — zooming
    // is meant to change the grain, not fling her somewhere else.
    const k = keepCentre.current;
    if (el && k) {
      keepCentre.current = null;
      el.scrollLeft = Math.max(0, k.fx * el.scrollWidth - el.clientWidth / 2);
      el.scrollTop = Math.max(0, k.fy * el.scrollHeight - el.clientHeight / 2);
    }
  }, [zoom, layout]);

  // How she left it, written through on every change of the pieces worth
  // keeping. Not the scroll position — that's where she WAS, not how she
  // looks at things — and not the filter, which is a moment's reading, not a
  // setting.
  useEffect(() => {
    try {
      localStorage.setItem(
        POND_VIEW_KEY,
        // The lit row's NAME rides along with its key, so the landmark on the
        // terrain map can say "Long COVID" without fetching the whole thread
        // rail just to translate `tag:long-covid` back into words.
        JSON.stringify({
          mode, zoom, group, hideKeeper, range,
          litKey: lit?.key ?? null,
          litLabel: lit?.label ?? null,
          layers,
        }),
      );
    } catch {
      // Storage full or blocked — the pond just won't remember, which is fine.
    }
  }, [mode, zoom, group, hideKeeper, range, lit?.key, lit, layers]);

  function changeRange(next: string) {
    if (next === range) return;
    setRange(next);
    // A new window is a new picture — frame it again.
    fitted.current = false;
  }

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

  // The path prev/next walks from the open card: the lit thread's cards in
  // time order when the open card is on it, the whole pond otherwise.
  const walk = useMemo(() => {
    const onThread = openId !== null && litIds.has(openId);
    const seq =
      onThread && litTags
        ? threadPoints(layout, litTags)
        : layout.columns.flatMap((c) => c.cards);
    return seq.map((p) => p.card.id);
  }, [layout, litTags, litIds, openId]);
  const walkAt = openId ? walk.indexOf(openId) : -1;
  const walkingThread = openId !== null && litIds.has(openId) && lit !== null;

  // A fresh card starts with a clean slate — no half-armed remove, no
  // half-typed tag carried over from the last one.
  useEffect(() => {
    setConfirmRemove(null);
    setNewTag('');
  }, [openId]);

  /** Fixed width the popup is clamped against; must match the CSS. */
  const POPUP_W = 272;
  function showHover(el: Element, card: PondCardHover) {
    const r = el.getBoundingClientRect();
    const flip = r.right + POPUP_W + 16 > window.innerWidth;
    setHover({ card, x: flip ? r.left : r.right, y: r.top, flip });
  }

  const TAG_OK = /^[a-z0-9-]{1,40}$/;
  function addTag() {
    const slug = newTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (!openId || !TAG_OK.test(slug) || retag.isPending) return;
    retag.mutate({ id: openId, tag: slug, verb: 'tag' });
    setNewTag('');
  }

  const allThreads = threads.data?.threads ?? [];
  const allFronts = threads.data?.fronts ?? [];

  // The rail's current shelf. Fronts are their own kind of row (they hold
  // threads); the other three are just the tags filed under that kind.
  const termsByTag = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of allThreads) m.set(t.tag, t.terms ?? []);
    return m;
  }, [allThreads]);

  const rows = useMemo(() => {
    if (group === 'front') {
      return allFronts.map((f: PondFront) => ({
        key: `front:${f.id}`,
        name: f.name,
        days: f.days,
        cards: f.cards,
        note: `${f.tags.length} threads`,
        tags: new Set(f.tags),
        // A front's excerpt anchors on any of its threads' words — you're
        // reading the domain, not one thread inside it.
        terms: [...new Set(f.tags.flatMap((t) => termsByTag.get(t) ?? []))],
      }));
    }
    return allThreads
      .filter((t: PondThread) => t.kind === group)
      .map((t: PondThread) => ({
        key: `tag:${t.tag}`,
        name: t.name,
        days: t.days,
        cards: t.cards,
        note: null as string | null,
        tags: new Set([t.tag]),
        terms: t.terms ?? [],
      }));
  }, [group, allFronts, allThreads, termsByTag]);

  const shown = showAll ? rows : rows.slice(0, RAIL_LIMIT);
  const totalCards = visibleCards.length;
  const dayCount = layout.columns.length;

  // The cards that belong to NO thread — a quarter of the journal, invisible
  // to every tag-based row. Counted from the visible cards so the Keeper
  // toggle and this row always agree about what's in the water.
  const unfiled = useMemo(() => {
    const hits = visibleCards.filter((c) => c.tags.length === 0);
    return { cards: hits.length, days: new Set(hits.map((c) => c.day)).size };
  }, [visibleCards]);

  function unfiledRow(): { key: string; name: string; tags: Set<string>; terms: string[] } {
    return { key: 'unfiled', name: 'Unfiled', tags: new Set([UNFILED]), terms: [] };
  }

  // Relight what was lit last visit, once the rail's data is here to
  // reconstruct it from. A thread that no longer exists (retired, window
  // narrowed) simply stays unlit rather than erroring.
  useEffect(() => {
    if (litRestored.current) return;
    const key = saved.litKey;
    if (!key) {
      litRestored.current = true;
      return;
    }
    if (key === 'unfiled') {
      litRestored.current = true;
      setLit({ key: 'unfiled', label: 'Unfiled', tags: new Set([UNFILED]), terms: [] });
      return;
    }
    if (!threads.data) return;
    litRestored.current = true;
    if (key.startsWith('front:')) {
      const f = allFronts.find((x) => `front:${x.id}` === key);
      if (f) {
        setLit({
          key,
          label: f.name,
          tags: new Set(f.tags),
          terms: [...new Set(f.tags.flatMap((t) => termsByTag.get(t) ?? []))],
        });
      }
    } else if (key.startsWith('tag:')) {
      const t = allThreads.find((x) => `tag:${x.tag}` === key);
      if (t) setLit({ key, label: t.name, tags: new Set([t.tag]), terms: t.terms ?? [] });
    }
  }, [threads.data, allFronts, allThreads, termsByTag, saved.litKey]);

  function toggle(row: { key: string; name: string; tags: Set<string>; terms: string[] }) {
    setLit((cur) =>
      cur?.key === row.key
        ? null
        : { key: row.key, label: row.name, tags: row.tags, terms: row.terms },
    );
  }

  return (
    <section className={styles.view} aria-label="The pond">
      <header className={styles.head}>
        <div className={styles.heading}>
          <h2 className={styles.title}>The pond</h2>
          <p className={styles.sub}>
            {totalCards > 0
              ? `${totalCards.toLocaleString()} cards across ${dayCount} days${
                  lit ? ` — ${lit.label} lit` : ''
                }`
              : 'Where the journal sits.'}
          </p>
        </div>

        <div className={styles.controls}>
          {/* The two axes of a day. Not a display preference — a different
              question each. */}
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

          {/* How far back the water reaches. Server-side, so the payload stays
              bounded however long the journal runs. */}
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

          {/* One scale for both arrangements — out to the whole record as a
              single picture, in to type you can read. */}
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
              {ZOOMS.map((_, i) => (
                <span key={i} className={i === zoom ? styles.pipOn : styles.pip} />
              ))}
            </span>
            <button
              type="button"
              className={styles.seg}
              disabled={zoom === ZOOMS.length - 1}
              aria-label="Zoom in"
              onClick={() => changeZoom(Math.min(ZOOMS.length - 1, zoom + 1))}
            >
              +
            </button>
          </div>

          {/* The Keeper's voice, toggleable out of the water. Struck through
              when hidden — the label wears its own state. Not the same move as
              lighting a thread: dimming is emphasis, this is subtraction. */}
          <button
            type="button"
            className={hideKeeper ? styles.keeperOff : styles.keeperOn}
            aria-pressed={hideKeeper}
            aria-label={hideKeeper ? 'Show the Keeper’s cards' : 'Hide the Keeper’s cards'}
            onClick={() => setHideKeeper((v) => !v)}
          >
            Keeper
          </button>

          {/* The working half. Time mode only — words mode has no clock to
              hang a moment on, so the switches go away rather than sitting
              there doing nothing. */}
          {mode === 'clock' ? (
            <div className={styles.segmented} role="group" aria-label="Working layers">
              {WORK_LAYERS.map((layer) => (
                <button
                  key={layer.key}
                  type="button"
                  className={layers[layer.key] ? styles.workOn : styles.work}
                  aria-pressed={layers[layer.key]}
                  title={layer.hint}
                  onClick={() =>
                    setLayers((cur) => ({ ...cur, [layer.key]: !cur[layer.key] }))
                  }
                >
                  {layer.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* Emphasis is the default — this is the other reading, where the
              pond drops away, the untouched days close up, and only the
              thread's own words are left. Labelled for what it DOES rather
              than for what's lit: a label carrying the thread name changed
              width every time she picked a different one, so the whole header
              shuffled sideways on each tap. */}
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

          <Link to="/terrain/files" className={styles.back} aria-label="Back to the terrain map">
            ← Terrain
          </Link>
        </div>
      </header>

      {cards.isLoading ? <p className={styles.note}>Reading the pond…</p> : null}
      {cards.isError ? <p className={styles.note}>Couldn&rsquo;t read the pond.</p> : null}
      {cards.data && totalCards === 0 ? (
        <p className={styles.note}>No cards in the pool yet.</p>
      ) : null}
      {cards.data?.truncated ? (
        <p className={styles.note}>
          Showing the first {totalCards.toLocaleString()} cards — the pond holds more than
          one screen can carry.
        </p>
      ) : null}

      {totalCards > 0 ? (
        <div className={styles.body}>
          <nav className={styles.rail} aria-label="Threads">
            {/* The vault's own filing, offered as shelves. */}
            <div className={styles.groups} role="group" aria-label="Sort threads by">
              {GROUPS.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className={group === g.key ? styles.groupOn : styles.group}
                  aria-pressed={group === g.key}
                  onClick={() => {
                    setGroup(g.key);
                    setShowAll(false);
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>

            <div className={styles.railList}>
              <button
                type="button"
                className={[styles.thread, lit === null ? styles.threadOn : '']
                  .filter(Boolean)
                  .join(' ')}
                aria-pressed={lit === null}
                onClick={() => setLit(null)}
              >
                <span className={styles.threadName}>Everything</span>
                <span className={styles.threadMeta}>{dayCount} days</span>
              </button>
              {/* The cards no thread claims — pinned above the shelves because
                  it's the pile curation starts from: light it, walk it with
                  ‹ ›, file each card or consciously leave it loose. */}
              {unfiled.cards > 0 ? (
                <button
                  type="button"
                  className={[styles.thread, lit?.key === 'unfiled' ? styles.threadOn : '']
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={lit?.key === 'unfiled'}
                  onClick={() => toggle(unfiledRow())}
                >
                  <span className={styles.threadName}>Unfiled</span>
                  <span className={styles.threadMeta}>
                    {unfiled.days} {unfiled.days === 1 ? 'day' : 'days'} · {unfiled.cards} to file
                  </span>
                </button>
              ) : null}
              {shown.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className={[styles.thread, lit?.key === row.key ? styles.threadOn : '']
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={lit?.key === row.key}
                  onClick={() => toggle(row)}
                >
                  <span className={styles.threadName}>{row.name}</span>
                  <span className={styles.threadMeta}>
                    {row.days} {row.days === 1 ? 'day' : 'days'} · {row.cards}
                    {row.note ? ` · ${row.note}` : ''}
                  </span>
                </button>
              ))}
              {rows.length === 0 ? (
                <p className={styles.railEmpty}>Nothing filed here yet.</p>
              ) : null}
              {rows.length > RAIL_LIMIT ? (
                <button
                  type="button"
                  className={styles.moreThreads}
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? 'Show fewer' : `${rows.length - RAIL_LIMIT} more`}
                </button>
              ) : null}
            </div>
          </nav>

          <div className={styles.stage}>
            {/* The clock gutter sits OUTSIDE the horizontal scroller so the
                hours stay put while the days pan — but it's inside the SAME
                vertical scroll as the cards, so the labels can't drift away
                from the rows they name. Words mode has no clock to rule. */}
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
              /* The gutter is a sibling, so it doesn't inherit this scroller's
                 vertical position — without this it would sit still while the
                 cards slid past, and every hour label would end up naming a row
                 it isn't beside. Cheaper and steadier than nesting scrollers. */
              onScroll={(e) => {
                const g = gutterRef.current;
                if (g) g.scrollTop = e.currentTarget.scrollTop;
                // The popup hangs at fixed viewport coords — a scroll moves the
                // dot out from under it, so it lets go rather than pointing at
                // the wrong water.
                setHover(null);
              }}
            >
              <div
                className={styles.canvas}
                style={{ width: layout.width, height: layout.height }}
                role="group"
                aria-label={
                  lit
                    ? `The pond, with ${lit.label} lit`
                    : 'The pond — every card by day'
                }
              >
                {/* Rules and the lit line, under the cards. An overlay rather
                    than a container so the cards above it stay real elements
                    that hold real text. */}
                <svg
                  className={styles.underlay}
                  width={layout.width}
                  height={layout.height}
                  aria-hidden="true"
                >
                  {gridLines.map((l) => (
                    <line
                      key={l.label}
                      x1={0}
                      x2={layout.width}
                      y1={l.y}
                      y2={l.y}
                      className={styles.hourLine}
                    />
                  ))}
                  {/* One point per DAY, not per card — ten cards in a day used
                      to draw ten stacked points and the line came out a comb.
                      The day-to-day wandering is the shape worth seeing. */}
                  {/* How long each session sat OPEN — a hairline down the
                      day, with the stretch that actually wrote files drawn
                      solid inside it. Two different facts about the same
                      conversation: one is how long a window was left up, the
                      other is when work happened in it, and a third of her
                      sessions make those numbers very far apart. In the SVG
                      so they sit UNDER everything: this is the ground the
                      day's marks stand on, not a mark itself. */}
                  {layers.sessions
                    ? work.spans.map((span) => (
                        <g key={`${span.session.id}:${span.day}`}>
                          <line
                            x1={span.x}
                            x2={span.x}
                            y1={span.y}
                            y2={span.y + span.h}
                            className={styles.sessionOpen}
                          />
                          {span.worked ? (
                            <line
                              x1={span.x}
                              x2={span.x}
                              y1={span.worked.y}
                              y2={span.worked.y + span.worked.h}
                              className={styles.sessionWorked}
                            />
                          ) : null}
                        </g>
                      ))
                    : null}
                  {line.length > 1 ? (
                    <polyline points={polylinePoints(line)} className={styles.threadLine} />
                  ) : null}
                </svg>

                {/* The dates ride a sticky strip so they stay readable however
                    far down a long day you've scrolled. */}
                <div className={styles.dayHeader} style={{ width: layout.width }}>
                  {layout.columns.map((col, i) =>
                    // Zoomed out there's no room for a date on every column, so
                    // only every Nth is drawn — a readable axis beats a smear.
                    i % step === 0 ? (
                      <span
                        key={col.day}
                        className={styles.dayLabel}
                        style={{
                          left: col.x,
                          width: Math.max(layout.colWidth, 30),
                        }}
                      >
                        {dayLabel(col.day, step === 1 ? layout.columns[i - 1]?.day : undefined)}
                      </span>
                    ) : null,
                  )}
                </div>

                {layout.columns.map((col) =>
                  col.cards.map((placed) => {
                    const isLit = litIds.has(placed.card.id);
                    const isOpen = placed.card.id === openId;
                    return (
                      <button
                        key={placed.card.id}
                        type="button"
                        className={[
                          mode === 'clock' ? styles.dot : styles.wordCard,
                          whoDotClass(placed.card.who),
                          lit && !isLit ? styles.dimmed : '',
                          // Once the rest is hidden, everything left IS the
                          // thread — marking each one says nothing.
                          isLit && !hiding ? styles.onThread : '',
                          isOpen ? styles.open : '',
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
                        title={
                          mode === 'words'
                            ? `${placed.card.day}${clockOf(placed.card.ts) ? ` ${clockOf(placed.card.ts)}` : ''}`
                            : undefined
                        }
                        onClick={() => {
                          setOpenWork(null);
                          setOpenId((cur) => (cur === placed.card.id ? null : placed.card.id));
                        }}
                        onMouseEnter={
                          mode === 'clock'
                            ? (e) => showHover(e.currentTarget, placed.card)
                            : undefined
                        }
                        onMouseLeave={mode === 'clock' ? () => setHover(null) : undefined}
                        onFocus={
                          mode === 'clock'
                            ? (e) => showHover(e.currentTarget, placed.card)
                            : undefined
                        }
                        onBlur={mode === 'clock' ? () => setHover(null) : undefined}
                      >
                        {placed.text ? (
                          <span className={styles.wordText}>
                            {/* The ellipses are the card admitting there's more
                                either side of what it's showing — never dressed
                                up as a whole entry. */}
                            {placed.text.clippedHead ? '… ' : ''}
                            {placed.text.text}
                            {placed.text.clippedTail ? ' …' : ''}
                          </span>
                        ) : null}
                      </button>
                    );
                  }),
                )}

                {/* Her messages to agents. A dot, like a card, because it is
                    the same kind of event — a moment she did something — just
                    in the other half of her day. Sat one lane over so a 2pm
                    message reads level with a 2pm journal entry. */}
                {layers.turns
                  ? work.turns.map((mark) => (
                      <button
                        key={`${mark.item.session}:${mark.item.ts}`}
                        type="button"
                        className={styles.turnDot}
                        style={{
                          left: mark.x, top: mark.y, width: mark.w, height: mark.h,
                          ['--hit' as string]: `${hitPad}px`,
                        }}
                        title={workTitle(mark.item, sessionById)}
                        aria-label={workTitle(mark.item, sessionById)}
                        onClick={() => {
                          setOpenId(null);
                          setOpenWork({ kind: 'turn', turn: mark.item });
                        }}
                      />
                    ))
                  : null}

                {/* Files written. A TICK, not a dot — wider than tall — so
                    that even at four pixels a day her afternoon and its
                    afternoon can't blur into one smear. Weight carries the
                    write count, on a log ramp with a floor: a one-write touch
                    stays visible rather than fading away to flatter a
                    forty-write one. */}
                {layers.writes
                  ? work.writes.map((mark) => (
                      <button
                        key={`${mark.item.session}:${mark.item.repo}:${mark.item.path}`}
                        type="button"
                        className={styles.writeTick}
                        style={{
                          left: mark.x,
                          top: mark.y,
                          width: mark.w,
                          height: mark.h,
                          opacity: writeWeight(mark.item.writes),
                          ['--hit' as string]: `${hitPad}px`,
                        }}
                        title={writeTitle(mark.item, sessionById)}
                        aria-label={writeTitle(mark.item, sessionById)}
                        onClick={() => {
                          setOpenId(null);
                          setOpenWork({ kind: 'write', write: mark.item });
                        }}
                      />
                    ))
                  : null}

                {/* Files deleted or moved — git's word, not the sessions'.
                    Same lane, same teal, told apart by SHAPE: a delete is a
                    HOLLOW tick (an absence, drawn as one), a move is a
                    SLANTED tick (a thing shifted sideways). Rare events, so
                    the slightly bigger boxes cost the page nothing. */}
                {layers.writes
                  ? work.events.map((mark) => (
                      <button
                        key={`${mark.item.ts}:${mark.item.repo}:${mark.item.path}:${mark.item.kind}`}
                        type="button"
                        className={
                          mark.item.kind === 'delete'
                            ? styles.eventDelete
                            : styles.eventMove
                        }
                        style={{
                          left: mark.x,
                          top: mark.y,
                          width: mark.w,
                          height: mark.h,
                          ['--hit' as string]: `${hitPad}px`,
                        }}
                        title={eventTitle(mark.item)}
                        aria-label={eventTitle(mark.item)}
                        onClick={() => {
                          setOpenId(null);
                          setOpenWork({ kind: 'event', event: mark.item });
                        }}
                      />
                    ))
                  : null}
              </div>
            </div>
          </div>

          {/* The hovercard, in the terrain map's own voice — same frost, same
              arrival, same uppercase labels — so pointing at a dot here feels
              like pointing at an orb there. A TOOLTIP, though, not a hovercard:
              it never takes the pointer, because the tap already opens the full
              panel and a popup you can wander into would fight it. Portaled to
              body so the scroller can't clip it at the edges. */}
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
                      {` · ${whoName(hover.card.who)}`}
                    </span>
                  </div>
                  <div className={styles.hoverBody}>{hover.card.body}</div>
                  {hover.card.tags.length > 0 ? (
                    <div className={styles.hoverThreads}>
                      <div className={styles.hoverLabel}>threads</div>
                      <div className={styles.hoverTags}>{hover.card.tags.join(' · ')}</div>
                    </div>
                  ) : null}
                </div>,
                document.body,
              )
            : null}

          {openWork ? (
            <aside className={styles.detail} aria-label="Work">
              <WorkDetail
                open={openWork}
                sessions={sessionById}
                sessionFiles={sessionFiles}
                onClose={() => setOpenWork(null)}
                onPickFile={(w) => setOpenWork({ kind: 'write', write: w })}
              />
            </aside>
          ) : null}

          {openId ? (
            <aside className={styles.detail} aria-label="Card">
              <div className={styles.detailHead}>
                <span className={styles.detailMeta}>
                  {detail.data?.card
                    ? `${detail.data.card.day}${clockOf(detail.data.card.ts) ? ` · ${clockOf(detail.data.card.ts)}` : ''} · ${whoName(
                        detail.data.card.who,
                      )}`
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

              {/* Walking the thread card by card — reading it as a sequence
                  rather than a scatter of taps, which is also how membership
                  gets curated: step, read, keep or remove, step. Falls back to
                  walking the whole pond when the open card isn't on the lit
                  thread. */}
              {walkAt !== -1 && walk.length > 1 ? (
                <div className={styles.detailNav}>
                  <button
                    type="button"
                    className={styles.navBtn}
                    disabled={walkAt <= 0}
                    aria-label={walkingThread ? 'Previous card in thread' : 'Previous card'}
                    onClick={() => setOpenId(walk[walkAt - 1])}
                  >
                    ‹
                  </button>
                  <span className={styles.navWhere}>
                    {walkAt + 1} of {walk.length}
                    {walkingThread ? ` in ${lit!.label}` : ''}
                  </span>
                  <button
                    type="button"
                    className={styles.navBtn}
                    disabled={walkAt >= walk.length - 1}
                    aria-label={walkingThread ? 'Next card in thread' : 'Next card'}
                    onClick={() => setOpenId(walk[walkAt + 1])}
                  >
                    ›
                  </button>
                </div>
              ) : null}

              {detail.isError ? <p className={styles.note}>Couldn&rsquo;t read that card.</p> : null}
              {detail.data?.card ? (
                <>
                  <p className={styles.detailBody}>{detail.data.card.body}</p>

                  {/* Membership, editable in place. The chip lights the
                      thread; its × takes this card out of it — armed on the
                      first tap, done on the second, so a stray touch near a
                      chip never silently edits the journal. Writes go through
                      /api/cards/untag → the vault's stream.py; the pond just
                      redraws what comes back. */}
                  <div className={styles.detailTags}>
                    {detail.data.card.tags.map((tag) => (
                      <span key={tag} className={styles.chipPair}>
                        <button
                          type="button"
                          className={[
                            styles.tagChip,
                            lit?.key === `tag:${tag}` ? styles.tagChipOn : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() =>
                            toggle({
                              key: `tag:${tag}`,
                              name: tag,
                              tags: new Set([tag]),
                              terms: termsByTag.get(tag) ?? [],
                            })
                          }
                        >
                          {tag}
                        </button>
                        <button
                          type="button"
                          className={
                            confirmRemove === tag ? styles.chipRemoveArmed : styles.chipRemove
                          }
                          disabled={retag.isPending}
                          aria-label={
                            confirmRemove === tag
                              ? `Really remove ${tag} from this card`
                              : `Remove ${tag} from this card`
                          }
                          onClick={() => {
                            if (confirmRemove === tag) {
                              setConfirmRemove(null);
                              retag.mutate({ id: openId, tag, verb: 'untag' });
                            } else {
                              setConfirmRemove(tag);
                            }
                          }}
                        >
                          {confirmRemove === tag ? 'sure?' : '×'}
                        </button>
                      </span>
                    ))}
                  </div>

                  {/* The other direction: put this card INTO a thread. Typing
                      offers every tag the pond knows; a new slug mints a new
                      thread, same as tagging anywhere else. */}
                  <form
                    className={styles.addTag}
                    onSubmit={(e) => {
                      e.preventDefault();
                      addTag();
                    }}
                  >
                    <input
                      type="text"
                      className={styles.addTagInput}
                      list="pond-known-tags"
                      value={newTag}
                      placeholder="add to thread…"
                      aria-label="Add this card to a thread"
                      onChange={(e) => setNewTag(e.target.value)}
                    />
                    <datalist id="pond-known-tags">
                      {allThreads.map((t) => (
                        <option key={t.tag} value={t.tag}>
                          {t.name}
                        </option>
                      ))}
                    </datalist>
                    <button
                      type="submit"
                      className={styles.addTagBtn}
                      disabled={
                        retag.isPending ||
                        !TAG_OK.test(newTag.trim().toLowerCase().replace(/\s+/g, '-'))
                      }
                    >
                      Add
                    </button>
                  </form>
                  {retag.isError ? (
                    <p className={styles.note}>Couldn&rsquo;t change that — try again.</p>
                  ) : null}

                  {/* The door out — this card, in the day it belongs to. The
                      pond is where the journal SITS; the journal page is where
                      it's read and written. */}
                  <Link
                    to="/journal"
                    search={{ date: detail.data.card.day }}
                    className={styles.journalLink}
                  >
                    Open in journal
                  </Link>
                </>
              ) : null}
            </aside>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
