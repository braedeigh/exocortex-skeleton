/**
 * QuestionsCard.tsx — the questions a session files for her, drawn in its chat.
 *
 * Every set the agent files (scripts/request_input.py → routes/observatory.py
 * request_input) is written into the transcript as a `questions` line, and the
 * chat draws it as a QuestionsBlock in its place in the timeline — so the block
 * stays in the conversation, above the message she answers with, instead of
 * vanishing when the questions are cleared. What it looks like depends on what
 * came after it (events.ts questionsState):
 *   - open: orange and sticky — pinned to the bottom edge of the view while she
 *     scrolls back through the chat, so she can read the questions and look for
 *     the answer at the same time;
 *   - answered: she's replied since — it settles into the transcript, calmer;
 *   - replaced: the agent filed a newer set before she replied.
 *
 * QuestionsCard is the fallback for a set with no transcript line — one filed
 * before sets were logged. It reads the open set off the shared roster query
 * (useSessionRoster, the same fetch ChatApprovalCard uses, so no extra poll)
 * and draws it as an open block at the bottom of the chat, only when the
 * transcript doesn't already hold that set. Her next message clears the set
 * server-side and the fallback goes with the next poll. The roster's orange
 * card (SessionCard.tsx AwaitingCard) prints the same list with an answer box.
 *
 * Mounted by ObservatoryPage.tsx: QuestionsBlock inside the transcript,
 * QuestionsCard after the other end-of-chat cards.
 *
 * Prompts: "if there are questions, i want them all summarized into a card at
 * the bottom of the session that floats at the bottom of the session", then
 * "when an agent sends up a question block, for it to persist in the chat
 * above what i send."
 */
import type { QuestionsState, Turn } from './events';
import { openQuestions, useSessionRoster } from './api';
import styles from './QuestionsCard.module.css';

const HEADINGS: Record<QuestionsState, (count: number) => string> = {
  open: (n) => (n > 1 ? `${n} questions for you` : 'A question for you'),
  answered: (n) => (n > 1 ? `${n} questions · answered` : 'Question · answered'),
  replaced: (n) => (n > 1 ? `${n} questions · replaced by a later set` : 'Question · replaced by a later set'),
};

export function QuestionsBlock({ questions, state }: { questions: string[]; state: QuestionsState }) {
  const many = questions.length > 1;
  return (
    <div
      className={[styles.card, state === 'open' ? styles.open : styles.settled].join(' ')}
      role="group"
      aria-label={state === 'open' ? 'Questions waiting on you' : 'Questions the agent asked'}
    >
      <div className={styles.head}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.eyebrow}>{HEADINGS[state](questions.length)}</span>
      </div>
      {many ? (
        <ol className={styles.list}>
          {questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>
      ) : (
        <p className={styles.single}>{questions[0]}</p>
      )}
      {state === 'open' ? (
        <div className={styles.hint}>Answer in the box below — it picks up from there.</div>
      ) : null}
    </div>
  );
}

export function QuestionsCard({ convId, turns }: { convId: string; turns: Turn[] }) {
  const { data } = useSessionRoster(true);
  const mine = (data?.sessions ?? []).find((s) => s.id === convId);
  const questions = openQuestions(mine);
  if (questions.length === 0) return null;
  // Skip it when the transcript already holds this set — the in-chat block is
  // drawing it (open, or already answered while the poll catches up).
  const key = questions.join('\n');
  if (turns.some((t) => t.role === 'questions' && (t.questions ?? []).join('\n') === key)) return null;
  return <QuestionsBlock questions={questions} state="open" />;
}
