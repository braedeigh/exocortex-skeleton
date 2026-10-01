/**
 * QuestionsCard.tsx — the questions a session files for her, drawn in its chat.
 *
 * Every set the agent files (scripts/request_input.py → routes/observatory.py
 * request_input) is written into the transcript as a `questions` line, and the
 * chat draws it as a QuestionsBlock in its place in the timeline — so the block
 * stays in the conversation, above the message she answers with, instead of
 * vanishing when the questions are cleared. What it looks like depends on what
 * came after it (events.ts questionsState):
 *   - open: orange, waiting on her. It sits in its place and scrolls with the
 *     chat like any message. Tapping it floats it (see below);
 *   - answered: she's replied since — it settles into the transcript, calmer;
 *   - elsewhere: her answer reached the agent by another route (a peer relayed
 *     it) and the agent took the set down itself (request_input.py --answered)
 *     — settled the same way, with where the answer came from printed under it;
 *   - replaced: the agent filed a newer set before she replied.
 *
 * FLOATING is a switch she flips, never a default. Tap the open block and it
 * comes up over the chat, just above the message box, and stays there while
 * she scrolls back through the conversation; a one-line marker holds its place
 * in the chat. Tap the floating card (or the marker) and it goes back. When
 * the block's place has scrolled out of sight there is nothing to tap, so
 * QuestionsChip stands in above the message box and floats the card. The
 * switch itself lives in ObservatoryPage.tsx, which also works out which set is
 * the open one (events.ts openQuestionSet) and hands each piece here a
 * QuestionsFloat. It is not remembered across a reload.
 *
 * QuestionsCard is the fallback for a set with no transcript line — one filed
 * before sets were logged. The page reads that set off the shared roster query
 * (useSessionRoster, the same fetch ChatApprovalCard uses, so no extra poll)
 * and this draws it as an open block at the end of the chat. Her next message
 * clears the set server-side and the fallback goes with the next poll. The
 * roster's orange card (SessionCard.tsx AwaitingCard) prints the same list with
 * an answer box.
 *
 * Mounted by ObservatoryPage.tsx: QuestionsBlock inside the transcript,
 * QuestionsCard after the other end-of-chat cards, QuestionsChip and
 * QuestionsFloating in the strip just above the message box.
 *
 * Prompts: "when an agent sends up a question block, for it to persist in the
 * chat above what i send", then "Need different floating question UI. Wanting
 * to be able to tap to bring up the card floating around and tap again to send
 * it back to where it sits in the chat. Don't want it constantly scrolling with
 * the chat."
 */
import type { OpenQuestionSet, QuestionsState } from './events';
import styles from './QuestionsCard.module.css';

const HEADINGS: Record<QuestionsState, (count: number) => string> = {
  open: (n) => (n > 1 ? `${n} questions for you` : 'A question for you'),
  answered: (n) => (n > 1 ? `${n} questions · answered` : 'Question · answered'),
  elsewhere: (n) => (n > 1 ? `${n} questions · answered elsewhere` : 'Question · answered elsewhere'),
  replaced: (n) => (n > 1 ? `${n} questions · replaced by a later set` : 'Question · replaced by a later set'),
};

/** What the open set's pieces need to float it and send it back. */
export interface QuestionsFloat {
  /** The card is up over the chat right now. */
  floated: boolean;
  /** Flip it: float the card, or send it back to its place. */
  onToggle: () => void;
  /** Handed whatever element marks the set's place in the chat, so the page
   * can tell when that place is out of view (usePlaceInView.ts). */
  placeRef: (element: HTMLElement | null) => void;
}

/** Run a tap on the card, unless the tap was the end of selecting text. The
 * whole card is the tap target, and its words are also ones she may highlight
 * into the journal, so a drag that leaves a selection must not flip the card. */
function tapUnlessSelecting(onTap: () => void): () => void {
  return () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    onTap();
  };
}

/** The questions themselves: a numbered list, or one paragraph for a single. */
function QuestionList({ questions }: { questions: string[] }) {
  if (questions.length === 1) return <p className={styles.single}>{questions[0]}</p>;
  return (
    <ol className={styles.list}>
      {questions.map((q, i) => (
        <li key={i}>{q}</li>
      ))}
    </ol>
  );
}

/** The top line of an open card, as a real button: the heading on the left and
 * what a tap does on the right. It has no handler of its own — its click
 * bubbles to the card, which is the one place the tap is handled — but it is
 * what a keyboard or a screen reader lands on. */
function OpenHead({ count, action, label }: { count: number; action: string; label: string }) {
  return (
    <button type="button" className={styles.headButton} aria-label={label}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.eyebrow}>{HEADINGS.open(count)}</span>
      <span className={styles.action}>{action}</span>
    </button>
  );
}

export function QuestionsBlock({
  questions,
  state,
  answeredElsewhere,
  float,
}: {
  questions: string[];
  state: QuestionsState;
  /** Where the agent said her answer came from, for a set it withdrew. */
  answeredElsewhere?: string;
  /** Only for the set still open: lets a tap float it. */
  float?: QuestionsFloat;
}) {
  // A set that isn't open (or has no switch) is part of the record: no taps.
  if (state !== 'open' || !float) {
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
        <QuestionList questions={questions} />
        {state === 'elsewhere' && answeredElsewhere ? (
          <div className={styles.hint}>Taken down by the agent — her answer came from: {answeredElsewhere}</div>
        ) : null}
      </div>
    );
  }

  // Floated: the card itself is up over the chat, so its place holds a
  // one-line marker. Tapping the marker sends the card back here.
  if (float.floated) {
    return (
      <button type="button" ref={float.placeRef} className={styles.away} onClick={float.onToggle}>
        <span className={styles.dot} aria-hidden="true" />
        <span>
          {questions.length > 1 ? `${questions.length} questions are` : 'The question is'} floating over the chat
          — tap to put {questions.length > 1 ? 'them' : 'it'} back here
        </span>
      </button>
    );
  }

  // Open and in its place: scrolls with the chat. A tap anywhere floats it.
  return (
    <div
      ref={float.placeRef}
      className={[styles.card, styles.open, styles.tappable].join(' ')}
      role="group"
      aria-label="Questions waiting on you"
      onClick={tapUnlessSelecting(float.onToggle)}
    >
      <OpenHead count={questions.length} action="Float" label="Float the questions over the chat" />
      <QuestionList questions={questions} />
      <div className={styles.hint}>
        Answer in the box below — it picks up from there. Tap this card to keep it in view while you scroll.
      </div>
    </div>
  );
}

/** The open set with no transcript line, drawn at the end of the chat. Same
 * block, same switch — its place just isn't a turn. */
export function QuestionsCard({ set, float }: { set: OpenQuestionSet; float: QuestionsFloat }) {
  return <QuestionsBlock questions={set.questions} state="open" float={float} />;
}

/** The small "questions" chip above the message box. Floats the card when the
 * block's own place is out of sight and so can't be tapped. */
export function QuestionsChip({ count, onFloat }: { count: number; onFloat: () => void }) {
  return (
    <button type="button" className={styles.chip} onClick={onFloat}>
      <span className={styles.dot} aria-hidden="true" />
      {count > 1 ? `${count} questions` : '1 question'}
    </button>
  );
}

/** The open set, floated: over the chat, just above the message box. The
 * heading stays put and a long list scrolls underneath it, so the way back is
 * always on screen. A tap anywhere sends it back to its place. */
export function QuestionsFloating({ questions, onPutBack }: { questions: string[]; onPutBack: () => void }) {
  return (
    <div
      className={[styles.card, styles.open, styles.tappable, styles.floated].join(' ')}
      role="group"
      aria-label="Questions waiting on you, floating over the chat"
      onClick={tapUnlessSelecting(onPutBack)}
    >
      <OpenHead
        count={questions.length}
        action="Put back"
        label="Send the questions back to their place in the chat"
      />
      <div className={styles.floatedBody}>
        <QuestionList questions={questions} />
        <div className={styles.hint}>Tap this card to send it back to its place in the chat.</div>
      </div>
    </div>
  );
}
