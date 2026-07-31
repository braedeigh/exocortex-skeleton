import { memo, useMemo, useRef, type CSSProperties } from 'react';
import { mdToHtml } from '../journal/markdown';
import { assistantText, type Turn } from './events';
import { EMBER_SPREAD_MS, emberDelay, quantizeHeat, tailWords, wordHeat } from './streamPacing';
import styles from './ObservatoryPage.module.css';

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
  armed: boolean;
  onBodyTap: (i: number) => void;
  onJournalTap: (i: number) => void;
}) {
  const html = useMemo(
    () => mdToHtml(buffer ? (text ? `${text}\n\n${buffer}` : buffer) : text),
    [text, buffer],
  );
  return (
    <div className={styles.reply}>
      {/* Tap a finished reply to arm the journal pill; tap again to disarm. */}
      <div
        className={styles.replyBody}
        onClick={() => onBodyTap(index)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
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

/** Within one tick's release-batch, successive LETTERS start their fades
 * this far apart — the ember front glides through words instead of hopping
 * between them. */
const LETTER_STAGGER_MS = 12;
/** Cascade cap, so a big catch-up batch doesn't trail forever. */
const STAGGER_MAX_MS = 600;

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
              // word rather than as the band moving over it.
              const heat = quantizeHeat(wordHeat(w.key + w.text.length, frost));
              return (
                <span
                  key={w.key}
                  className={styles.emberWord}
                  style={{ '--heat': heat } as CSSProperties}
                >
                  {[...w.text].map((ch, j) => (
                    <span
                      key={j}
                      className={styles.fadeWord}
                      style={{
                        animationDelay: `${Math.min(base + j * LETTER_STAGGER_MS, delayCap)}ms`,
                      }}
                    >
                      {ch}
                    </span>
                  ))}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      {t.tool ? <div className={styles.toolNote}>{t.tool}</div> : null}
    </div>
  );
}
