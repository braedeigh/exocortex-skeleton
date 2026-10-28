/**
 * OwnerWords.tsx — her own words, quoted above a question set. When a session
 * files questions about work that started from one of her journal cards
 * (scripts/request_input.py --card), the card's text is copied verbatim onto
 * the set, and this shows it under the about line and above the questions —
 * so she meets her own reason for the work before she has to answer about it.
 *
 * Quiet on purpose: muted text with a thin rule, not orange, because it's a
 * reminder, not a call to act. Folded to three lines (ClampedText.tsx) with a
 * tap to read the rest.
 *
 * Used by the roster's orange card (SessionCard.tsx AwaitingCard) and the
 * chat's question block (QuestionsCard.tsx), in every state.
 *
 * Prompt: "it's hard to answer a bunch of build questions in a row and I have
 * to be ready to comb through and understand them… Feeling like I need more
 * of an on ramp."
 */
import { ClampedText } from './ClampedText';
import styles from './OwnerWords.module.css';

export function OwnerWords({ words }: { words?: string | null }) {
  if (!words?.trim()) return null;
  return (
    <figure className={styles.words}>
      <figcaption className={styles.label}>Your words</figcaption>
      {/* Curly quotes as real text, inside the fold (see ClampedText.module.css). */}
      <ClampedText className={styles.quote}>
        {'“'}
        {words.trim()}
        {'”'}
      </ClampedText>
    </figure>
  );
}
