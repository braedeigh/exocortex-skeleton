/**
 * QuestionsCard — every question this session is waiting on her for, in one
 * orange card that floats at the bottom of its chat. It stays pinned above the
 * composer while she scrolls back through the conversation, so she can read
 * what's being asked and look for the answer at the same time.
 *
 * Where the questions come from: the session files them itself with
 * scripts/request_input.py (routes/observatory.py request_input), and they
 * ride the roster as `awaiting_questions`. Read through the shared roster
 * query (useSessionRoster), the same fetch ChatApprovalCard uses, so this adds
 * no poll. Her next message is the answer: it clears the questions
 * server-side, and the card goes with the next poll. The roster's orange card
 * (SessionCard.tsx AwaitingCard) prints the same list with an answer box.
 *
 * Mounted by ObservatoryPage.tsx, after the transcript's other end-of-chat
 * cards.
 *
 * Prompt: "if there are questions, i want them all summarized into a card at
 * the bottom of the session that floats at the bottom of the session".
 */
import { openQuestions, useSessionRoster } from './api';
import styles from './QuestionsCard.module.css';

export function QuestionsCard({ convId }: { convId: string }) {
  const { data } = useSessionRoster(true);
  const mine = (data?.sessions ?? []).find((s) => s.id === convId);
  const questions = openQuestions(mine);
  if (questions.length === 0) return null;
  const many = questions.length > 1;
  return (
    <div className={styles.card} role="group" aria-label="Questions waiting on you">
      <div className={styles.head}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.eyebrow}>
          {many ? `${questions.length} questions for you` : 'A question for you'}
        </span>
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
      <div className={styles.hint}>Answer in the box below — it picks up from there.</div>
    </div>
  );
}
