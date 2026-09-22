import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { subscribeTheme } from '../../theme';
import { useTerrainFile, useTerrainFileEdits, useTerrainFileRuns } from './api';
import { setCodeHeatOn, setCodeRunOn, useCodeHeatOn, useCodeRunOn } from './codeHeatPref';
import { lineEditHeat } from './lineEditHeat';
import { langForPath, tokenizeCode, type SyntaxLines, type SyntaxToken } from './syntax';
import { glowAlpha, heatColor, heatRamps, readThemeInk, type ThemeInk } from './terrainCanvas';
import { heatKeyTicks, RUN_WINDOW_SECONDS } from './terrainGraph';
import { stepMention, type CodeMentions } from './codeMentions';
import styles from './FileCodeBody.module.css';

/**
 * FileCodeBody — one file's actual contents, fetched from the terrain file
 * endpoint (GET /api/observatory/terrain/file) and laid out the same way in
 * every place it's shown. One fetch, one layout, three frames around it:
 *
 *   - the pond's work panel (pond/PondView.tsx WorkDetail) — the default look
 *   - the file pane beside the map (FileCodeWindow) — passes `uncapCode`
 *   - the /code page a session card's file list opens into (routes/code.tsx →
 *     FileCodePage.tsx) — passes `fill` and a `highlight` range
 *
 * Top to bottom it shows: the path, the file's own summary, a size line with
 * the "edits" and "ran" toggles, a key for each colour that's on, then the
 * code — one numbered row per line, in syntax colour. In the gutter, while
 * its toggle is on: a red mark by how recently each line was edited, and a
 * gold mark by how recently the function around it ran.
 *
 * THE MENTION STRIP sits between those and the code, and only when the file
 * was opened asking about something: a SQL table's card on the Terrain map
 * hands over every line this file names that table on (`mentions`). Then all
 * of them are marked down the gutter, one is lit and scrolled to the middle
 * of the pane, and a sticky strip says how many there are with an arrow each
 * way to walk them.
 *
 * Touches: api.ts (the three fetches), syntax.ts (the colour tokens),
 * codeHeatPref.ts (the two toggles' settings), lineEditHeat.ts (an age
 * turned into heat), codeMentions.ts (the mention shape and the step
 * arithmetic), terrainCanvas.ts and terrainGraph.ts (the map's ramp and
 * key labels), FileCodeBody.module.css (the look).
 */
export interface LineHighlight {
  /** 1-based, inclusive — matches how people say line numbers out loud and
   * the /code?lines= URL contract, not array indices. */
  start: number;
  end: number;
}


export function FileCodeBody({
  repo,
  path,
  fill = false,
  uncapCode = false,
  highlight,
  mentions,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
  runWindowSeconds = RUN_WINDOW_SECONDS,
  ink,
}: {
  repo: string | null;
  path: string | null;
  /** Page mode (FileCodePage). The code block grows to take the pane instead
   * of stopping at 55vh, and the path line and the summary card are dropped. */
  fill?: boolean;
  /** Window mode (FileCodeWindow). No height cap and no vertical scroll on
   * the code — the whole file flows into the frame's one scroll region — and
   * the path line is dropped. The summary stays. */
  uncapCode?: boolean;
  /** Lines to light up and scroll to on mount, 1-based inclusive. Optional —
   * without it no line is lit and nothing scrolls. This component doesn't
   * parse the URL; it renders whatever range it's handed. */
  highlight?: LineHighlight;
  /** Every place one thing is named in this file — what a SQL table's card
   * hands over when she opens one of the files that touches it. All of them
   * get a soft mark down the gutter, ONE of them is lit and scrolled to, and
   * a strip above the code steps between them. `highlight` wins over this
   * when both are given: an explicit range was asked for by name.
   *
   * Prompt that produced it: "when i click those files in the popup for each
   * data table, it highlights where the table was mentioned in the code file
   * when i open it up and i can hop between them if there are multiple". */
  mentions?: CodeMentions;
  /** The heat window the red decays across, in seconds. The map's pane
   * hands in its live one (breath included, so the pane breathes with the
   * map); anything else gets a week. */
  windowSeconds?: number;
  /** The window the gold decays across, in seconds. The map's pane hands in
   * its live one, so a function is gold in the pane exactly as long as its
   * file's dot is gold outside; anything else gets a day, the map's own
   * resting window for "this ran". */
  runWindowSeconds?: number;
  /** The theme's ink, for the two ramps and the dark-or-light syntax
   * palette. The map already tracks it and passes it in; other frames read
   * it themselves (useThemeInk). */
  ink?: ThemeInk;
}) {
  const { data, isLoading, isError, error } = useTerrainFile(repo, path);

  // Get what the red-edits toggle needs: its setting, and the stamps.
  // The toggle is one setting for every file (codeHeatPref.ts): flip it once
  // and every file opens lit until it's flipped back. The stamps say when
  // each line was last edited — git blame, through
  // GET /api/observatory/terrain/file/edits — and are fetched only while the
  // toggle is on, and only once a text file has loaded.
  // Prompt that produced it: "can those displays show when the most recent
  // code was edited by a toggleable red color like on the terrain map".
  const heatOn = useCodeHeatOn();
  const edits = useTerrainFileEdits(repo, path, heatOn && !!data && !data.binary);
  // Get what the gold-ran toggle needs: its setting, and the stamps.
  // The same shape as the red above, from a different source. The stamps say
  // when the function around each line last ran — the runtime sensor, through
  // GET /api/observatory/terrain/file/runs — fetched only while the toggle
  // is on, and again every minute, so code she just used turns gold while
  // the file is still open. A visitor gets it too: the endpoint sits behind
  // the same app-code-only lock as the file's text.
  // Prompt that produced it: "see which function in a file ran, not just
  // that the file ran".
  const runOn = useCodeRunOn();
  const runs = useTerrainFileRuns(repo, path, runOn && !!data && !data.binary);
  // Read the theme's ink, and build the red's ramp from it.
  // The ink is wanted whenever there's code on screen, not only for the
  // red: the syntax palette is per surface (.codeDark below). The map hands
  // its own in; other frames read it themselves (useThemeInk). The ramp is
  // the map's own ember ramp (terrainCanvas.ts heatRamps), built only while
  // the toggle is on.
  const ownInk = useThemeInk(ink === undefined && data?.content != null);
  const liveInk = ink ?? ownInk;
  const ramp = useMemo(() => (heatOn && liveInk ? heatRamps(liveInk).ember : null), [heatOn, liveInk]);
  const goldRamp = useMemo(() => (runOn && liveInk ? heatRamps(liveInk).gold : null), [runOn, liveInk]);
  // Fix "now" at the moment the stamps were fetched, not at this render.
  // The breath re-renders this several times a second, and a line's age
  // moving by a fraction of a second between frames is nothing the eye can
  // see. Until the first fetch lands it falls back to the clock — there are
  // no stamps to age then anyway. With the toggle off there are no stamps.
  const nowSeconds = edits.dataUpdatedAt > 0 ? edits.dataUpdatedAt / 1000 : Date.now() / 1000;
  const stamps = heatOn ? (edits.data?.edits ?? null) : null;
  const runNowSeconds = runs.dataUpdatedAt > 0 ? runs.dataUpdatedAt / 1000 : Date.now() / 1000;
  const runStamps = runOn ? (runs.data?.runs ?? null) : null;

  // Split the text into lines once per fetch, not per render (memoized).
  // null for a binary, or while there's no content yet — that's what tells
  // the JSX below to render no code block at all rather than a stray empty
  // one. The syntax tokens arrive separately (useSyntaxLines below).
  const lines = useMemo(() => (data?.content != null ? data.content.split('\n') : null), [data?.content]);
  const syntax = useSyntaxLines(data?.content ?? null, path);

  // Which mention she's standing on, of however many. Reset to the first
  // whenever the file or the list changes, so opening a second file from the
  // same table's card starts at the top of THAT file rather than at whatever
  // number she had reached in the last one.
  const mentionLines = mentions?.lines ?? EMPTY_LINES;
  // Keyed on the lines' VALUE, not the array's identity: the /code page
  // re-parses them out of the URL on every render, so a fresh array arrives
  // each time and an identity-keyed reset would snap her back to the first
  // mention the instant she pressed the arrow.
  const mentionKey = mentionLines.join(',');
  const [mentionAt, setMentionAt] = useState(0);
  useEffect(() => {
    setMentionAt(0);
  }, [path, mentionKey]);
  const at = Math.min(mentionAt, Math.max(0, mentionLines.length - 1));

  // What is actually lit. An explicit `highlight` wins: a range asked for by
  // name (the /code?lines= contract) beats a mention the page found for her.
  // Otherwise the mention she's standing on is a one-line range.
  const litLine = mentionLines.length > 0 ? mentionLines[at] : undefined;
  const lit: LineHighlight | undefined =
    highlight ?? (litLine !== undefined ? { start: litLine, end: litLine } : undefined);
  // The soft marks: every OTHER place the thing is named, so the ones she
  // hasn't walked to yet are visible in the gutter as she scrolls past.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mentionKey IS the lines
  const marks = useMemo(() => new Set(mentionLines), [mentionKey]);

  // Scroll the lit line to centre — on arrival, and again each time it MOVES.
  // The ref remembers which line it last scrolled to rather than a bare "have
  // I scrolled", so a background refetch of the same file never yanks her
  // position back, while stepping to the next mention does take her there.
  const hotRef = useRef<HTMLDivElement | null>(null);
  const scrolledToRef = useRef<number | null>(null);
  const litStart = lit?.start ?? null;
  useEffect(() => {
    if (litStart === null || scrolledToRef.current === litStart || !hotRef.current) return;
    hotRef.current.scrollIntoView({ block: 'center' });
    scrolledToRef.current = litStart;
  }, [lines, litStart]);

  /** Step to the next mention, or the previous one. The wrap arithmetic is
   * `stepMention` in codeMentions.ts, where it can be tested. */
  const step = (by: number) => setMentionAt((was) => stepMention(was, by, mentionLines.length));

  return (
    <div className={[styles.body, fill ? styles.bodyFill : ''].filter(Boolean).join(' ')}>
      {/* Print the full path — in the default frame only. The /code page and
          the map's file pane both print the path in their own headers, so in
          those frames this line would just say it twice. */}
      {!fill && !uncapCode ? <div className={styles.path}>{path}</div> : null}

      {isLoading ? <div className={styles.hint}>Reading the file…</div> : null}

      {/* Say why the file can't be shown. A 403 is the server's visitor lock
          (routes/terrain.py _visitor_may_read): the file exists on the map,
          its text stays on the server. A state, not a failure — so it reads
          as one. Any other error shows its own message. */}
      {isError && (error as { status?: number } | null)?.status === 403 ? (
        <div className={styles.hint}>Private &mdash; this file&rsquo;s contents stay on the server.</div>
      ) : isError ? (
        <div className={styles.hint}>
          Couldn&rsquo;t read this one
          {error instanceof Error && error.message ? ` — ${error.message.toLowerCase()}` : '.'}
        </div>
      ) : null}

      {/* Show the file's own summary, or say it has none — not in page mode.
          The summary is the file's OWN leading docblock, lifted server-side
          (routes/terrain.py `_terrain_file_summary`), not a generated
          description. This codebase explains itself at the top of nearly
          every file, so the honest answer to "what is this" is already
          written; when a file doesn't say, the hint under the card says so
          rather than guessing. Page mode drops both: there the card would be
          the same text twice — the docblock in the card, then the identical
          docblock at the top of the code right below it — and a long card,
          which won't shrink below its own content, would squeeze the code
          block to nothing. Without the card, "doesn't describe itself" is a
          note about nothing. */}
      {!fill && data?.summary ? (
        <div className={styles.summary}>
          {data.summary.split('\n\n').map((para, i) => (
            <p key={i} className={styles.summaryPara}>
              {para}
            </p>
          ))}
        </div>
      ) : null}

      {!fill && data && !data.binary && data.summary === null ? (
        <div className={styles.hint}>This file doesn&rsquo;t describe itself.</div>
      ) : null}

      {data ? (
        <div className={styles.metaRow}>
          <div className={styles.meta}>
            {formatBytes(data.size)}
            {!data.binary ? ` · ${data.lines.toLocaleString()} lines` : null}
            {data.truncated ? ' · showing the first part only' : null}
          </div>
          {/* The red-edits toggle: turn the per-line edit colour on or off.
              A pill like the heat bar's presets, lit the same way when on.
              It's one setting for every file (codeHeatPref.ts), so it reads
              as a mode, not a per-file option. Hidden for binaries — nothing
              to paint. */}
          {!data.binary ? (
            <button
              type="button"
              className={[styles.heatToggle, heatOn ? styles.heatToggleOn : ''].filter(Boolean).join(' ')}
              aria-pressed={heatOn}
              title={heatOn ? 'Stop colouring lines by when they were last edited' : 'Colour lines by when they were last edited'}
              onClick={() => setCodeHeatOn(!heatOn)}
            >
              <span className={styles.heatToggleDot} aria-hidden="true" />
              edits
            </button>
          ) : null}
          {/* The gold-ran toggle: turn the per-function run colour on or
              off. The same pill as "edits", lit gold. One setting for every
              file (codeHeatPref.ts). Hidden for binaries. */}
          {!data.binary ? (
            <button
              type="button"
              className={[styles.heatToggle, runOn ? styles.runToggleOn : ''].filter(Boolean).join(' ')}
              aria-pressed={runOn}
              title={runOn ? 'Stop marking functions by when they last ran' : 'Mark functions by when they last ran'}
              onClick={() => setCodeRunOn(!runOn)}
            >
              <span className={styles.heatToggleDot} aria-hidden="true" />
              ran
            </button>
          ) : null}
        </div>
      ) : null}

      {/* The key for the red, only while the toggle is on. The ramp laid
          hot-to-cold between two labels taken from the map's own key
          (terrainGraph.ts heatKeyTicks) — "now" and the window's edge — so
          "how old is that shade" has one answer across the pane and the map.
          A file git has no history for says so instead, rather than sitting
          there uncoloured for no stated reason. */}
      {heatOn && data && !data.binary ? (
        edits.data && edits.data.edits === null ? (
          <div className={styles.hint}>No edit history for this file &mdash; git doesn&rsquo;t track it.</div>
        ) : ramp ? (
          <div className={styles.heatKey} aria-label="Edit recency key">
            <span className={styles.heatKeyTick}>{heatKeyTicks(windowSeconds)[0]}</span>
            <span
              className={styles.heatKeyRamp}
              style={{ background: `linear-gradient(to right, ${[...ramp].reverse().join(', ')})` }}
            />
            <span className={styles.heatKeyTick}>{heatKeyTicks(windowSeconds)[2]}</span>
            {edits.isLoading ? <span className={styles.heatKeyNote}>reading history…</span> : null}
          </div>
        ) : null
      ) : null}

      {/* The key for the gold, only while the toggle is on. The same strip
          as the red's key, in the gold ramp, from "now" to the edge of the
          gold window. When the sensor has nothing for this file it says
          which kind of nothing: it only watches Python, and only sees what
          has run. Under the key, one line on what gold can't mean — a whole
          function lights, never single lines. */}
      {runOn && data && !data.binary ? (
        runs.isError ? (
          <div className={styles.hint}>Couldn&rsquo;t read what ran in this file.</div>
        ) : runs.data && runs.data.runs === null ? (
          <div className={styles.hint}>
            {path?.endsWith('.py')
              ? 'Nothing in this file has been seen running.'
              : 'No run marks for this file — the sensor only sees Python on the server.'}
          </div>
        ) : goldRamp ? (
          <div className={styles.heatKey} aria-label="Run recency key">
            <span className={styles.heatKeyTick}>{heatKeyTicks(runWindowSeconds)[0]}</span>
            <span
              className={styles.heatKeyRamp}
              style={{ background: `linear-gradient(to right, ${[...goldRamp].reverse().join(', ')})` }}
            />
            <span className={styles.heatKeyTick}>{heatKeyTicks(runWindowSeconds)[2]}</span>
            <span className={styles.heatKeyNote}>
              {runs.isLoading ? 'reading what ran…' : 'a whole function lights when it ran — not single lines'}
            </span>
          </div>
        ) : null
      ) : null}

      {data?.binary ? <div className={styles.hint}>Binary file — nothing to read here.</div> : null}

      {/* THE MENTION STRIP — where this file names the thing she came here
          for, and a way to walk them. Opened from a table's card, "which
          files touch this table" has already been answered; the question
          left is WHERE in the file, and a file can answer it a dozen times.
          So: how many there are, which one she's standing on, and an arrow
          each way that scrolls the next one to the middle of the pane.
          Sticky to the top of whichever frame is scrolling, because the
          whole point is stepping to a line four hundred rows down and still
          having the arrow under her thumb when she lands. */}
      {mentionLines.length > 0 && lines ? (
        <div className={styles.mentions}>
          {/* Say what was looked for when it's known. A link that lost the
              name still knows the lines, and "7 mentions" is true where "7
              mentions of " would be a sentence with a hole in it. */}
          <span className={styles.mentionCount}>
            {mentionLines.length} {mentionLines.length === 1 ? 'mention' : 'mentions'}
            {mentions?.label ? (
              <>
                {' of '}
                <span className={styles.mentionLabel}>{mentions.label}</span>
              </>
            ) : null}
          </span>
          {mentionLines.length > 1 ? (
            <div className={styles.mentionStep}>
              <button
                type="button"
                className={styles.mentionArrow}
                aria-label="Previous mention"
                title="Previous mention"
                onClick={() => step(-1)}
              >
                &lsaquo;
              </button>
              <span className={styles.mentionAt}>
                {at + 1} / {mentionLines.length}
              </span>
              <button
                type="button"
                className={styles.mentionArrow}
                aria-label="Next mention"
                title="Next mention"
                onClick={() => step(1)}
              >
                &rsaquo;
              </button>
            </div>
          ) : null}
          <span className={styles.mentionLine}>line {litLine}</span>
        </div>
      ) : null}

      {/* The code: one numbered row per line (CodeLine below) rather than one
          bare <pre>, so every text file gets line numbers and a highlight
          has a row to land on — the same row pattern as
          workshop/WorkshopPage.tsx's HeroPanel. .codeDark switches the
          syntax palette when the theme's ink is dark. */}
      {lines ? (
        <div
          className={[
            styles.code,
            fill ? styles.codeFill : '',
            uncapCode ? styles.codeFlow : '',
            liveInk?.dark ? styles.codeDark : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {lines.map((line, i) => {
            const n = i + 1; // 1-based, to match `highlight` and the URL.
            const hot = lit !== undefined && n >= lit.start && n <= lit.end;
            // A mention she hasn't stepped to yet: marked, not lit. The one
            // she IS standing on is already `hot` above and doesn't need the
            // fainter mark underneath it.
            const marked = !hot && marks.has(n);
            // Work out this line's red. Rounded to the nearest 1/64 so the
            // breath only re-renders a row when its shade visibly moves.
            const raw = stamps && ramp ? lineEditHeat(stamps[i], nowSeconds, windowSeconds) : 0;
            const t = Math.round(raw * 64) / 64;
            // Work out this line's gold. The same decay and the same
            // rounding as the red, read off the run stamps and the gold
            // window.
            const rawRun = runStamps && goldRamp ? lineEditHeat(runStamps[i], runNowSeconds, runWindowSeconds) : 0;
            const runHeat = Math.round(rawRun * 64) / 64;
            return (
              <CodeLine
                key={i}
                n={n}
                text={line}
                tokens={syntax ? syntax[i] : undefined}
                hot={hot}
                marked={marked}
                heat={t}
                heatInk={t > 0 && ramp ? heatColor(t, ramp) : null}
                runHeat={runHeat}
                runInk={runHeat > 0 && goldRamp ? heatColor(runHeat, goldRamp) : null}
                hotRef={hot && n === lit?.start ? hotRef : undefined}
              />
            );
          })}
        </div>
      ) : null}

      {data?.truncated ? (
        <div className={styles.hint}>
          Truncated at {formatBytes(data.content?.length ?? 0)} — open it in the editor for the rest.
        </div>
      ) : null}
    </div>
  );
}

/**
 * One line of code: its number, its red and gold marks, its coloured text.
 *
 * A memoized component. The body re-renders on every breath tick — several
 * times a second under Dynamic — and a row only repaints when its own red
 * moved, its highlight changed, or its tokens arrived. A long file is tens
 * of thousands of spans, and redrawing them all at that rate would stutter.
 *
 * The red lives in the gutter, not across the row: a strip down the left
 * edge and the line number itself, both in the ramp colour (`heatInk`, the
 * map's ember ramp read at this line's heat), with the strip's opacity
 * following the heat (glowAlpha, the dots' own curve) so an old line fades
 * to nothing rather than to a grey bar. The text is left alone, so the code
 * reads the same lit or not. A cold line (heat 0) gets neither mark.
 *
 * The gold is a second strip just inside the red one, in the map's gold ramp
 * read at this line's run heat (`runInk`), fading the same way. So a line
 * can wear both: edited lately AND ran lately. The number goes gold only
 * when it isn't already red — an edit is the rarer news.
 *
 * The text is the syntax tokens, each with a role (keyword, string,
 * comment…) wearing that role's class — the .syn_* rules in
 * FileCodeBody.module.css; a token with no role stays plain. While there
 * are no tokens it is the raw line.
 *
 * Her ask, for the red: "instead of the whole block being red, could it be
 * like a strip on the side of the numbers and the numbers themselves are
 * red".
 */
const CodeLine = memo(function CodeLine({
  n,
  text,
  tokens,
  hot,
  marked = false,
  heat,
  heatInk,
  runHeat,
  runInk,
  hotRef,
}: {
  n: number;
  text: string;
  tokens: SyntaxToken[] | undefined;
  hot: boolean;
  /** One of the mentions, but not the one she's standing on — a quiet bar in
   * the gutter so the rest are visible as she scrolls past them. */
  marked?: boolean;
  heat: number;
  heatInk: string | null;
  runHeat: number;
  runInk: string | null;
  hotRef: Ref<HTMLDivElement> | undefined;
}) {
  const edited = heat > 0 && heatInk !== null;
  const ran = runHeat > 0 && runInk !== null;
  const paint: CSSProperties | undefined =
    edited || ran
      ? {
          ...(edited
            ? { ['--edit-ink' as string]: heatInk, ['--edit-alpha' as string]: glowAlpha(heat).toFixed(3) }
            : {}),
          ...(ran
            ? { ['--run-ink' as string]: runInk, ['--run-alpha' as string]: glowAlpha(runHeat).toFixed(3) }
            : {}),
        }
      : undefined;
  return (
    <div
      ref={hotRef}
      className={[
        styles.codeLine,
        hot ? styles.codeLineHot : '',
        marked ? styles.codeLineMarked : '',
        edited ? styles.codeLineEdited : '',
        ran ? styles.codeLineRan : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={paint}
    >
      <span className={styles.codeLineNo}>{n}</span>
      <span className={styles.codeLineText}>
        {tokens && tokens.length > 0
          ? tokens.map((tok, j) =>
              tok.role ? (
                <span key={j} className={styles[`syn_${tok.role}`]}>
                  {tok.content}
                </span>
              ) : (
                tok.content
              ),
            )
          : text === ''
            ? ' '
            : text}
      </span>
    </div>
  );
});

/**
 * Get the file's syntax tokens — null while they're loading, or when there
 * are none to have.
 *
 * A file whose path has a grammar (syntax.ts `langForPath`) is tokenized by
 * Shiki (syntax.ts `tokenizeCode`), again whenever the content or the path's
 * language changes. Until the tokens arrive, or when there is no grammar,
 * the rows show plain text: the colour never delays the text. A result that
 * lands after the file has already changed under it is dropped, so a fast
 * file switch can't paint the wrong colours.
 */
function useSyntaxLines(content: string | null, path: string | null): SyntaxLines | null {
  const [lines, setLines] = useState<SyntaxLines | null>(null);
  const lang = langForPath(path);
  useEffect(() => {
    setLines(null);
    if (content === null || lang === null) return;
    let live = true;
    void tokenizeCode(content, lang).then((result) => {
      if (live) setLines(result);
    });
    return () => {
      live = false;
    };
  }, [content, lang]);
  return lines;
}

/** A week — the window frames with no live heat bar decay the red across. */
const DEFAULT_WINDOW_SECONDS = 7 * 24 * 3600;

/** One shared empty array for "no mentions", so the effect that resets the
 * step counter isn't re-run by a fresh `[]` on every render. */
const EMPTY_LINES: readonly number[] = [];

/**
 * Read the theme's ink, for frames the map isn't feeding.
 *
 * A subscription: read once when it turns on, and again every time the theme
 * engine announces a change (theme/engine.ts subscribeTheme) — the /code
 * page can sit open across the Auto mode's sunset. Only subscribed while
 * `active`; the caller sets that once there is code on screen and no ink
 * was handed in.
 */
function useThemeInk(active: boolean): ThemeInk | null {
  const [ink, setInk] = useState<ThemeInk | null>(null);
  useEffect(() => {
    if (!active) return;
    const apply = () => setInk(readThemeInk());
    apply();
    return subscribeTheme(apply);
  }, [active]);
  return active ? ink : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
