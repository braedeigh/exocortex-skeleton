/**
 * SummaryLines — a helper's summary drawn as its labelled lines, one under
 * the other, with each label in bold.
 *
 * What this is, in plain English: the swarm helper writes every summary as a
 * few short lines that each start with a label — "Now: …", "Done: …",
 * "Waiting on: …" for a session; "Goal: …", "Where it stands: …", "Next: …",
 * "Waiting on: …" for the swarm (swarm_helper.py, tidy_summary). This draws
 * them apart instead of as one run of text. An older summary that is still
 * one paragraph has no labels and is drawn as the plain paragraph it is.
 *
 * Touches: SwarmPage.tsx and SwarmStack.tsx (where it is drawn),
 * SummaryLines.module.css.
 *
 * Prompt that produced this: "Make the helper summaries more separated and
 * succinct ... Labeled lines."
 */
import styles from './SummaryLines.module.css';

// A label is a few words at the start of a line, ending in a colon.
const LABEL = /^([A-Z][A-Za-z ]{1,20}):\s+(.*)$/;

export function SummaryLines({ text }: { text: string }) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return (
    <span className={styles.lines}>
      {lines.map((line, index) => {
        const found = LABEL.exec(line);
        return (
          <span key={index} className={styles.line}>
            {found ? (
              <>
                <strong className={styles.label}>{found[1]}:</strong> {found[2]}
              </>
            ) : (
              line
            )}
          </span>
        );
      })}
    </span>
  );
}
