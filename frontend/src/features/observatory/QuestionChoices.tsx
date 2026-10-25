/**
 * QuestionChoices.tsx — how she answers one question a session filed: tap one
 * of the options it offers, or type her own answer underneath.
 *
 * A session files each question with up to four options (request_input.py
 * --option), the one it recommends first. They're drawn as full-width buttons,
 * each with its label, what it means and what it costs or gains, and the
 * recommended one tagged "recommended". Under them sits an "Other — type your
 * own" box; a question with no options gets only the box. Tapping an option
 * picks it (filled orange, with a tick), tapping it again lets it go; typing
 * in the box replaces a pick.
 *
 * It is CONTROLLED and keeps no state of its own: the answer comes in as
 * `answer` and every change goes out through `onChange`. The parent holds the
 * answers for the whole set and composes the one message Send sends
 * (questionAnswers.ts) — AwaitingCard in SessionCard.tsx on the roster, and
 * ObservatoryPage.tsx for the open set in the chat. That's so whatever arranges
 * the questions (all at once today, one at a time later) is the only chooser.
 *
 * OptionsText is the same options as plain text, for a set that's settled
 * (answered, replaced, or answered elsewhere): part of the record, nothing to
 * tap.
 *
 * Prompt: "similar to Claude planning mode where I can click options it
 * presents or else type in my response"
 */
import type { QuestionOption } from './api';
import type { QuestionAnswer } from './questionAnswers';
import styles from './QuestionChoices.module.css';

export function QuestionChoices({
  options,
  answer,
  onChange,
  onSubmit,
  disabled = false,
  label,
}: {
  options: QuestionOption[];
  /** Her answer so far: a tapped option, typed words, or nothing. */
  answer: QuestionAnswer | undefined;
  onChange: (answer: QuestionAnswer | undefined) => void;
  /** Ctrl/Cmd+Enter in the box: send the whole set, like the chat. */
  onSubmit?: () => void;
  disabled?: boolean;
  /** What a screen reader calls the typing box ("Answer to question 2"). */
  label: string;
}) {
  const typed = answer?.kind === 'typed' ? answer.text : '';
  return (
    <div className={styles.choices}>
      {/* The options, the recommended one first, each a button she taps. */}
      {options.length > 0 ? (
        <div className={styles.options} role="group" aria-label={`Options — ${label}`}>
          {options.map((option, i) => {
            const picked = answer?.kind === 'option' && answer.index === i;
            return (
              <button
                key={i}
                type="button"
                className={[styles.option, picked ? styles.picked : ''].filter(Boolean).join(' ')}
                aria-pressed={picked}
                disabled={disabled}
                onClick={() => onChange(picked ? undefined : { kind: 'option', index: i })}
              >
                <span className={styles.optionLine}>
                  {/* A tick on the one she picked, so it reads at a glance. */}
                  {picked ? (
                    <span className={styles.check} aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.recommended ? <span className={styles.recommended}>recommended</span> : null}
                </span>
                {option.detail ? <span className={styles.optionDetail}>{option.detail}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {/* Her own words: "Other" beside options, the only way to answer
          without them. Enter makes a new line; Ctrl/Cmd+Enter sends. */}
      <textarea
        className={styles.other}
        value={typed}
        rows={options.length > 0 ? 1 : 2}
        placeholder={options.length > 0 ? 'Other — type your own…' : 'Your answer…'}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? { kind: 'typed', text: e.target.value } : undefined)}
        onKeyDown={(e) => {
          if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}

/** A settled set's options, as plain text: what was offered, nothing to tap. */
export function OptionsText({ options }: { options: QuestionOption[] }) {
  if (options.length === 0) return null;
  return (
    <ul className={styles.optionsText}>
      {options.map((option, i) => (
        <li key={i}>
          <strong>{option.label}</strong>
          {option.recommended ? ' (recommended)' : ''}
          {option.detail ? ` — ${option.detail}` : ''}
        </li>
      ))}
    </ul>
  );
}
