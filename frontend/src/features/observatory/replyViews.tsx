import { memo, useLayoutEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react';
import { mdToHtml } from '../journal/markdown';
import { assistantText, type ClosedSwarm, type Highlight, type Turn } from './events';
import { paintMarks, resolveAll } from './highlightMarks';
import { EMBER_SPREAD_MS, emberDelay, quantizeHeat, tailWords, wordHeat } from './streamPacing';
import { SwarmClosingFold } from './SwarmClosingFold';
import styles from './ObservatoryPage.module.css';

/** Re-light saved highlights inside a rendered block. Runs after layout so the
 * markdown is on the page to walk, and re-runs whenever the text or the
 * highlight list changes — the marks are painted into the DOM rather than
 * rendered by React, so React replacing the innerHTML wipes them and this is
 * what puts them back. Offsets are measured against `textContent`, which is
 * exactly what they were counted in when she made the selection. */
function useHighlightMarks(
  ref: RefObject<HTMLElement | null>,
  highlights: Highlight[] | undefined,
  dep: string,
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    paintMarks(el, highlights?.length ? resolveAll(el.textContent ?? '', highlights) : [], styles.journalMark);
  }, [ref, highlights, dep]);
}

/** One assistant reply, memoized: a closed turn's props never change during
 * streaming, so it skips both the re-render and the markdown re-parse (the
 * useMemo) that used to run per token delta across the whole transcript. */
export const Reply = memo(function Reply({
  index,
  text,
  buffer,
  open,
  tool,
  journaled,
  highlights,
  closedSwarms,
  armed,
  onBodyTap,
  onJournalTap,
}: {
  index: number;
  text: string;
  buffer: string;
  open: boolean;
  tool: string | null;
  journaled: boolean;
  highlights?: Highlight[];
  closedSwarms?: ClosedSwarm[];
  armed: boolean;
  onBodyTap: (i: number) => void;
  onJournalTap: (i: number) => void;
}) {
  const html = useMemo(
    () => mdToHtml(buffer ? (text ? `${text}\n\n${buffer}` : buffer) : text),
    [text, buffer],
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  useHighlightMarks(bodyRef, highlights, html);
  return (
    <div className={styles.reply}>
      {/* Tap a finished reply to arm the journal pill; tap again to disarm.
          `data-turn`/`data-who` are how the page's one selection listener works
          out which turn a highlight landed in, and in whose voice — see
          ObservatoryPage's selection effect. */}
      <div
        ref={bodyRef}
        className={styles.replyBody}
        data-turn={index}
        data-who="K"
        onClick={() => onBodyTap(index)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {/* Open a "swarm closed" line into its whole summary: one fold under
          the reply for each swarm the reply says closed. Outside the body, so
          a tap on it doesn't arm the journal pill and highlights still count
          the body's own text. */}
      {closedSwarms?.map((closed) => (
        <SwarmClosingFold key={`${closed.swarmId}:${closed.at}`} swarmId={closed.swarmId} at={closed.at} />
      ))}
      {open && tool ? <div className={styles.toolNote}>{tool}</div> : null}
      {journaled ? <div className={styles.journaledNote}>✦ in the journal</div> : null}
      {armed && !journaled && !open ? (
        <button type="button" className={styles.journalBtn} onClick={() => onJournalTap(index)}>
          ✦ put this in the journal
        </button>
      ) : null}
    </div>
  );
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  ));
}

/** Her own message — the epigraph above a reply. Its own component now because
 * highlights have to be painted into it, and painting means splitting text
 * nodes. React can't be the one holding that text: it tracks the node it
 * rendered, so a mark that splits the node leaves React's reference pointing at
 * a fragment, and the next update writes the whole message back into it. So the
 * text goes in through innerHTML (escaped — it's raw text she typed, and a
 * message containing `<b>` has to read as `<b>`), which React replaces
 * wholesale and never reaches inside. Same arrangement the rendered markdown in
 * `Reply` already has, which is why marks are safe there. */
export function UserMessage({
  index,
  text,
  offRecord,
  highlights,
  onTap,
}: {
  index: number;
  text: string;
  offRecord: boolean;
  highlights?: Highlight[];
  /** Given for an off-the-record message: a tap on it arms the pill that puts
   * it back in the journal (ObservatoryPage's tapOffRecord). */
  onTap?: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => escapeHtml(text), [text]);
  useHighlightMarks(ref, highlights, html);
  return (
    <div
      ref={ref}
      data-turn={index}
      data-who="B"
      className={[styles.userMsg, offRecord ? styles.userOffRecord : '', onTap ? styles.userTappable : '']
        .filter(Boolean)
        .join(' ')}
      onClick={onTap ? () => onTap(index) : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Within one tick's release-batch, successive LETTERS start their fades
 * this far apart — the ember front glides through words instead of hopping
 * between them. */
const LETTER_STAGGER_MS = 12;
/** Cascade cap, so a big catch-up batch doesn't trail forever. */
const STAGGER_MAX_MS = 600;

/** One word in the warm band, with its letters as separate spans so each can
 * ignite a beat after the one before.
 *
 * Memoised, and that's the point rather than a nicety. The tail re-renders
 * every PACE_TICK_MS (20x a second) for as long as a turn is streaming, and
 * the band holds COOL_DISTANCE_CHARS of text — so without this, React walks
 * every letter span in the tail, twenty times a second, to discover that
 * almost none of them changed. Heat is already quantized to HEAT_STEPS for
 * exactly this reason; memoising here is what lets that quantization actually
 * pay, because a word whose step hasn't moved is now skipped whole instead of
 * re-reconciled letter by letter.
 *
 * Every prop is a primitive, so the default shallow compare is the right one.
 * `base` comes from the caller's frozen delay map and never changes for a
 * mounted word — a changed delay would restart the fade.
 *
 * Prompt that produced this shape: "the printing of text with the red from the
 * bots is laggy" — the output is unchanged, only the work to arrive at it. */
const EmberWord = memo(function EmberWord({
  text,
  heat,
  base,
  delayCap,
}: {
  text: string;
  heat: number;
  base: number;
  delayCap: number;
}) {
  return (
    <span className={styles.emberWord} style={{ '--heat': heat } as CSSProperties}>
      {[...text].map((ch, j) => (
        <span
          key={j}
          className={styles.fadeWord}
          style={{ animationDelay: `${Math.min(base + j * LETTER_STAGGER_MS, delayCap)}ms` }}
        >
          {ch}
        </span>
      ))}
    </span>
  );
});

/** The turn currently being written, rendered through the word flow
 * (streamPacing.ts): only the first `shown` characters are visible.
 * Completed paragraphs settle into parsed markdown; the live tail renders
 * as word spans keyed by offset, so each word mounts exactly once. A word
 * still in the warm band renders its letters as individual spans, each
 * fading in a beat after the one before — letter-grain smoothness; once
 * fully cooled (behind the `cooled` frontier) it collapses to plain text, so
 * the number of live animations stays bounded no matter how long the reply
 * gets. The tail shows raw markdown until its paragraph settles — the price
 * of spans that hold still.
 *
 * The HEAT is painted per word from `frost`, not animated per word on a
 * timer. Each word mixes the ember toward the theme's ink by how far it sits
 * inside the band, so the colour is a function of where the text is rather
 * than how old it is — which is what makes the warmth travel with the words
 * as they climb the page instead of draining out from under them. */
export function StreamingReply({
  t,
  shown,
  cooled,
  frost,
  ember = false,
}: {
  t: Turn;
  shown: number;
  cooled: number;
  /** Trailing edge of the warm band, in characters (useWordFlow's frostChars). */
  frost: number;
  /** Step-back view: words ignite scattered rather than in reading order, so
   * the block fills in like a fire taking. See EMBER_SPREAD_MS. */
  ember?: boolean;
}) {
  const full = assistantText(t);
  const visible = full.slice(0, Math.min(shown, full.length));
  // A paragraph settles only once every word in it has finished cooling
  // (cooled = the frontier COOL_LINGER_MS ago) — settling earlier unmounts
  // spans mid-ember and snaps them to ink. The tail may span paragraphs.
  const cut = visible.lastIndexOf('\n\n', Math.min(cooled, visible.length));
  const settled = cut > 0 ? visible.slice(0, cut) : '';
  // The paragraph break itself is neither settled nor tail — the settled
  // block's own bottom margin is the gap.
  let tailStart = cut > 0 ? cut : 0;
  while (tailStart < visible.length && visible[tailStart] === '\n') tailStart++;
  const html = useMemo(() => mdToHtml(settled), [settled]);
  const words = tailWords(visible.slice(tailStart), tailStart);
  // Each word's base delay is assigned once, at first sight — its letter
  // position in its batch, in stagger beats. Frozen in a ref so re-renders
  // can never change a mounted span's animation (a changed delay restarts
  // the fade). Letters within the word step from the base.
  // In ember mode the base is a scattered draw from the word's own offset
  // instead of its place in the batch — reading order stops governing ignition
  // order, which is the whole effect. Still assigned once and frozen, for the
  // same reason: a changed delay restarts a mounted span's fade.
  const delayRef = useRef(new Map<number, number>());
  let batchLetters = 0;
  for (const w of words) {
    if (!delayRef.current.has(w.key)) {
      delayRef.current.set(
        w.key,
        ember ? emberDelay(w.key) : Math.min(batchLetters * LETTER_STAGGER_MS, STAGGER_MAX_MS),
      );
      batchLetters += w.text.length;
    }
  }
  // The cascade cap has to clear the scatter window in ember mode, or every
  // late-drawn word would be clamped back down to the same instant and the
  // scatter would flatten into a single flash.
  const delayCap = ember ? EMBER_SPREAD_MS + STAGGER_MAX_MS : STAGGER_MAX_MS;
  return (
    <div className={styles.reply}>
      <div className={styles.replyBody}>
        {settled ? <div dangerouslySetInnerHTML={{ __html: html }} /> : null}
        {words.length ? (
          <div className={styles.tail}>
            {words.map((w) => {
              // Fully cooled: animations are complete, so plain text renders
              // identically — and frees the letter spans.
              if (w.key + w.text.length <= cooled) {
                return <span key={w.key}>{w.text}</span>;
              }
              const base = delayRef.current.get(w.key) ?? 0;
              // One heat for the whole word, stepped — letters inside a word
              // cooling at different rates would read as a gradient across the
              // word rather than as the band moving over it. Stepped is also
              // what makes EmberWord's memo bite: the value only moves a
              // handful of times over a word's life, so most ticks skip it.
              const heat = quantizeHeat(wordHeat(w.key + w.text.length, frost));
              return (
                <EmberWord
                  key={w.key}
                  text={w.text}
                  heat={heat}
                  base={base}
                  delayCap={delayCap}
                />
              );
            })}
          </div>
        ) : null}
      </div>
      {t.tool ? <div className={styles.toolNote}>{t.tool}</div> : null}
    </div>
  );
}
