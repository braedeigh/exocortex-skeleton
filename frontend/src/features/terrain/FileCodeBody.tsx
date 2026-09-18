import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { subscribeTheme } from '../../theme';
import { useTerrainFile, useTerrainFileEdits } from './api';
import { setCodeHeatOn, useCodeHeatOn } from './codeHeatPref';
import { lineEditHeat } from './lineEditHeat';
import { EMBER_HOT, glowAlpha, heatColor, heatRamps, readThemeInk, type ThemeInk } from './terrainCanvas';
import { heatKeyTicks } from './terrainGraph';
import styles from './FileCodeBody.module.css';

/**
 * FileCodeBody — one file's actual contents, fetched from the terrain file
 * endpoint (GET /api/observatory/terrain/file) and laid out identically in
 * every place it's shown: the map's tap-a-node modal (FileCodeModal), the
 * file pane beside the map (FileCodeWindow), and the /code page a session card's
 * file list opens into (FileCodePage). One fetch, one layout, three frames
 * around it.
 *
 * The summary above the code is the file's OWN leading docblock, lifted
 * server-side (routes/observatory.py `_terrain_file_summary`), not a generated
 * description. This codebase explains itself at the top of nearly every file,
 * so the honest answer to "what is this" was already written; when a file
 * doesn't say, this says nothing rather than guessing.
 *
 * Text files render line-by-line (gutter number + text, the pattern lifted
 * from workshop/WorkshopPage.tsx's HeroPanel) rather than one bare `<pre>` —
 * every text file gets numbered lines, and an optional `highlight` range
 * lights a band of them and scrolls the first one to center once on mount.
 * That's what makes /code?...&lines=140-162 (routes/code.tsx →
 * FileCodePage.tsx) work: this component doesn't parse the URL, it just
 * renders whatever range it's handed.
 *
 * Three frames now wrap it, and two layout props tell them apart.
 *
 * `fill` is PAGE mode, and it does two things:
 *
 *   - The code block grows to take the pane instead of being capped at 55vh
 *     (the modal caps it so a long file can't push the close button off top).
 *   - The summary card is DROPPED. On the page it was the same text twice —
 *     the docblock in the card, then the identical docblock at the top of the
 *     code right below it — and because that card won't shrink below its own
 *     content, a long one ate the whole pane and squeezed the code block to
 *     nothing, so the page clipped instead of scrolling. In the modal the
 *     summary still earns its keep: the point there is to read what a file IS
 *     without reading the file.
 *
 * `uncapCode` is WINDOW mode (FileCodeWindow, the file pane on the map).
 * It keeps the summary — same reason the modal does — but drops the code
 * block's own vertical scroll so the whole file flows into the window's one
 * scroll region. It also drops the path line, because that frame prints the
 * path in its header rather than at the top of the body.
 *
 * THE RED: an "edits" toggle on the meta line (every frame has it) paints
 * each line by when it was last edited, on the map's own ember ramp — a
 * line changed just now is fully red, the colour decays across the window
 * and is gone at its edge, exactly as a file's dot does on the terrain
 * (lineEditHeat.ts). The stamps come from git blame through
 * GET /api/observatory/terrain/file/edits, fetched only while the toggle is
 * on. The toggle is one setting for every file (codeHeatPref.ts): flip it
 * once and every file opens lit until it's flipped back. `windowSeconds`
 * is the window to decay across — the map's pane passes its live heat
 * window (breath included, so the pane breathes with the map); frames with
 * no window of their own get a week. The row wash is the hot ember at an
 * alpha scaled by the heat, so text stays legible under it, and the line
 * NUMBER wears the ramp colour itself — the same colour the dot would.
 *
 * Prompt that produced it: "can those displays show when the most recent
 * code was edited by a toggleable red color like on the terrain map".
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
  /** Page mode: let the code block grow instead of capping it at 55vh. */
  fill?: boolean;
  /** Window mode: no vertical cap or scroll on the code — the frame scrolls. */
  uncapCode?: boolean;
  /** Lines to highlight and scroll to on mount, 1-based inclusive. Optional —
   * every existing caller that omits it looks exactly as it did before,
   * apart from the line-number gutter that now always shows on text files. */
  highlight?: LineHighlight;
  /** The heat window the red decays across, in seconds. The map's pane
   * hands in its live one; anything else gets a week. */
  windowSeconds?: number;
  /** The theme's ink, for the ember ramp. The map already tracks it and
   * passes it in; other frames read it themselves (useThemeInk). */
  ink?: ThemeInk;
}) {
  const { data, isLoading, isError, error } = useTerrainFile(repo, path);

  // The red-edits toggle and what it needs: the stamps (only fetched while
  // it's on) and the ramp (only built while it's on).
  const heatOn = useCodeHeatOn();
  const edits = useTerrainFileEdits(repo, path, heatOn && !!data && !data.binary);
  const ownInk = useThemeInk(ink === undefined && heatOn);
  const liveInk = ink ?? ownInk;
  const ramp = useMemo(() => (heatOn && liveInk ? heatRamps(liveInk).ember : null), [heatOn, liveInk]);
  // "now" is the moment the stamps were fetched, not this render: the breath
  // re-renders this several times a second, and a line's age moving by a
  // fraction of a second between frames is nothing the eye can see. (Zero
  // until the first fetch lands — then there are no stamps to age anyway.)
  const nowSeconds = edits.dataUpdatedAt > 0 ? edits.dataUpdatedAt / 1000 : Date.now() / 1000;
  const stamps = heatOn ? (edits.data?.edits ?? null) : null;

  // Split once per fetch, not per render. null for binaries/no-content-yet —
  // that's what tells the JSX below to fall back to nothing rendered rather
  // than a stray empty code block.
  const lines = useMemo(() => (data?.content != null ? data.content.split('\n') : null), [data?.content]);

  // Scroll the first highlighted line to center ONCE per mount, guarded by a
  // ref rather than keyed on data so a background refetch of the same file
  // never yanks her scroll position back — same guard shape as the workshop
  // hero panel, just without the "a new edit landed" trigger to re-arm it.
  const hotRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || !hotRef.current) return;
    hotRef.current.scrollIntoView({ block: 'center' });
    scrolledRef.current = true;
  }, [lines]);

  return (
    <div className={[styles.body, fill ? styles.bodyFill : ''].filter(Boolean).join(' ')}>
      {/* The modal's header is only the filename, so the full path goes here.
          The /code page and the file page both have room for it in their own
          headers — in those frames this line would just say it twice. */}
      {!fill && !uncapCode ? <div className={styles.path}>{path}</div> : null}

      {isLoading ? <div className={styles.hint}>Reading the file…</div> : null}

      {/* 403 is the server's visitor lock (routes/terrain.py _visitor_may_read):
          the file exists on the map, its text stays on the server. A state,
          not a failure — so it reads as one. */}
      {isError && (error as { status?: number } | null)?.status === 403 ? (
        <div className={styles.hint}>Private &mdash; this file&rsquo;s contents stay on the server.</div>
      ) : isError ? (
        <div className={styles.hint}>
          Couldn&rsquo;t read this one
          {error instanceof Error && error.message ? ` — ${error.message.toLowerCase()}` : '.'}
        </div>
      ) : null}

      {!fill && data?.summary ? (
        <div className={styles.summary}>
          {data.summary.split('\n\n').map((para, i) => (
            <p key={i} className={styles.summaryPara}>
              {para}
            </p>
          ))}
        </div>
      ) : null}

      {/* Only meaningful next to the summary card — on the page, where there's
          no card, "doesn't describe itself" is a note about nothing. */}
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
          {/* The red-edits toggle. A pill like the heat bar's presets, lit
              the same way when on. It's one setting for every file
              (codeHeatPref.ts), so it reads as a mode, not a per-file
              option. Hidden for binaries — nothing to paint. */}
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

      {/* The key, only while the red is on: the ramp laid hot-to-cold with
          the same three ticks the map's key uses — now, the window's
          midpoint, its edge — so "how old is that shade" has one answer
          across the pane and the map. A file git has no history for says so
          instead, rather than sitting there uncoloured for no stated reason. */}
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

      {lines ? (
        <div
          className={[styles.code, fill ? styles.codeFill : '', uncapCode ? styles.codeFlow : '']
            .filter(Boolean)
            .join(' ')}
        >
          {lines.map((line, i) => {
            const n = i + 1; // 1-based, to match `highlight` and the URL.
            const hot = highlight !== undefined && n >= highlight.start && n <= highlight.end;
            // The red, per line: the row gets a wash of the hot ember at an
            // alpha that follows the heat (glowAlpha, the dots' own curve),
            // and the number gets the ramp colour outright — the exact
            // shade this line's age would wear as a dot on the map. A cold
            // line (0) gets neither, so the plain look is untouched.
            const t = stamps && ramp ? lineEditHeat(stamps[i], nowSeconds, windowSeconds) : 0;
            const paint: CSSProperties | undefined =
              t > 0 && ramp
                ? {
                    background: `color-mix(in srgb, ${EMBER_HOT} ${Math.round(EMBER_WASH_MAX * glowAlpha(t) * 100)}%, transparent)`,
                    ['--edit-ink' as string]: heatColor(t, ramp),
                  }
                : undefined;
            return (
              <div
                key={i}
                ref={hot && n === highlight?.start ? hotRef : undefined}
                className={[styles.codeLine, hot ? styles.codeLineHot : '', t > 0 ? styles.codeLineEdited : '']
                  .filter(Boolean)
                  .join(' ')}
                style={paint}
              >
                <span className={styles.codeLineNo}>{n}</span>
                <span className={styles.codeLineText}>{line === '' ? ' ' : line}</span>
              </div>
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

/** A week — the window frames with no live heat bar decay the red across. */
const DEFAULT_WINDOW_SECONDS = 7 * 24 * 3600;

/** How much of the hot ember a fully-red row's wash carries. Strong enough
 * to be unmistakably red behind the text, weak enough to keep the text
 * legible on both surfaces. */
const EMBER_WASH_MAX = 0.32;

/**
 * The theme's ink for frames the map isn't feeding — read on mount and again
 * on every theme commit (the /code page can sit open across the Auto mode's
 * sunset). Only subscribed while `active`, so a pane with the red off pays
 * nothing for it.
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
