import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { subscribeTheme } from '../../theme';
import { useTerrainFile, useTerrainFileEdits } from './api';
import { setCodeHeatOn, useCodeHeatOn } from './codeHeatPref';
import { lineEditHeat } from './lineEditHeat';
import { langForPath, tokenizeCode, type SyntaxLines, type SyntaxToken } from './syntax';
import { glowAlpha, heatColor, heatRamps, readThemeInk, type ThemeInk } from './terrainCanvas';
import { heatKeyTicks } from './terrainGraph';
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
 * the "edits" toggle, the key for the red, then the code — one numbered row
 * per line, in syntax colour, with a red mark in the gutter by how recently
 * each line was edited while the toggle is on.
 *
 * Touches: api.ts (the two fetches), syntax.ts (the colour tokens),
 * codeHeatPref.ts (the toggle's one setting), lineEditHeat.ts (a line's age
 * turned into heat), terrainCanvas.ts and terrainGraph.ts (the map's ramp and
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
  windowSeconds = DEFAULT_WINDOW_SECONDS,
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
  /** The heat window the red decays across, in seconds. The map's pane
   * hands in its live one (breath included, so the pane breathes with the
   * map); anything else gets a week. */
  windowSeconds?: number;
  /** The theme's ink, for the ember ramp and the dark-or-light syntax
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
  // Read the theme's ink, and build the red's ramp from it.
  // The ink is wanted whenever there's code on screen, not only for the
  // red: the syntax palette is per surface (.codeDark below). The map hands
  // its own in; other frames read it themselves (useThemeInk). The ramp is
  // the map's own ember ramp (terrainCanvas.ts heatRamps), built only while
  // the toggle is on.
  const ownInk = useThemeInk(ink === undefined && data?.content != null);
  const liveInk = ink ?? ownInk;
  const ramp = useMemo(() => (heatOn && liveInk ? heatRamps(liveInk).ember : null), [heatOn, liveInk]);
  // Fix "now" at the moment the stamps were fetched, not at this render.
  // The breath re-renders this several times a second, and a line's age
  // moving by a fraction of a second between frames is nothing the eye can
  // see. Until the first fetch lands it falls back to the clock — there are
  // no stamps to age then anyway. With the toggle off there are no stamps.
  const nowSeconds = edits.dataUpdatedAt > 0 ? edits.dataUpdatedAt / 1000 : Date.now() / 1000;
  const stamps = heatOn ? (edits.data?.edits ?? null) : null;

  // Split the text into lines once per fetch, not per render (memoized).
  // null for a binary, or while there's no content yet — that's what tells
  // the JSX below to render no code block at all rather than a stray empty
  // one. The syntax tokens arrive separately (useSyntaxLines below).
  const lines = useMemo(() => (data?.content != null ? data.content.split('\n') : null), [data?.content]);
  const syntax = useSyntaxLines(data?.content ?? null, path);

  // Scroll the first highlighted line to center, ONCE per mount.
  // A ref guards it, rather than keying on the data, so a background refetch
  // of the same file never yanks her scroll position back. Nothing here
  // re-arms it: FileCodePage remounts this body (its `key`) when a new range
  // should scroll.
  const hotRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || !hotRef.current) return;
    hotRef.current.scrollIntoView({ block: 'center' });
    scrolledRef.current = true;
  }, [lines]);

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

      {data?.binary ? <div className={styles.hint}>Binary file — nothing to read here.</div> : null}

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
            const hot = highlight !== undefined && n >= highlight.start && n <= highlight.end;
            // Work out this line's red. Rounded to the nearest 1/64 so the
            // breath only re-renders a row when its shade visibly moves.
            const raw = stamps && ramp ? lineEditHeat(stamps[i], nowSeconds, windowSeconds) : 0;
            const t = Math.round(raw * 64) / 64;
            return (
              <CodeLine
                key={i}
                n={n}
                text={line}
                tokens={syntax ? syntax[i] : undefined}
                hot={hot}
                heat={t}
                heatInk={t > 0 && ramp ? heatColor(t, ramp) : null}
                hotRef={hot && n === highlight?.start ? hotRef : undefined}
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
 * One line of code: its number, its red mark, its coloured text.
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
  heat,
  heatInk,
  hotRef,
}: {
  n: number;
  text: string;
  tokens: SyntaxToken[] | undefined;
  hot: boolean;
  heat: number;
  heatInk: string | null;
  hotRef: Ref<HTMLDivElement> | undefined;
}) {
  const paint: CSSProperties | undefined =
    heat > 0 && heatInk
      ? {
          ['--edit-ink' as string]: heatInk,
          ['--edit-alpha' as string]: glowAlpha(heat).toFixed(3),
        }
      : undefined;
  return (
    <div
      ref={hotRef}
      className={[styles.codeLine, hot ? styles.codeLineHot : '', heat > 0 ? styles.codeLineEdited : '']
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
