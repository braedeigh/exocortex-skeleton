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
 * in the chat. Tap the floating card (or the marker) and it goes back. The
 * floating card grows to fit its questions, but never past the visible space
 * above the message box (useFloatRoom.ts measures it, keyboard open or not):
 * a longer list scrolls inside the card, under a heading that stays put. When
 * the block's place has scrolled out of sight there is nothing to tap, so
 * QuestionsChip stands in above the message box and floats the card. The
 * switch itself lives in ObservatoryPage.tsx, which also works out which set is
 * the open one (events.ts openQuestionSet) and hands each piece here a
 * QuestionsFloat. It is not remembered across a reload.
 *
 * EVERY SET CARRIES ITS CONTEXT. A set filed with an about line (what the
 * agent is building and where it stands) shows it above the questions, and a
 * question filed with options shows them. On the open set they are buttons
 * (QuestionChoices.tsx) with a box to type her own answer, and the card has
 * its own Send and a "Go with your recommendations" button, so she can answer
 * right here. The page holds the answers (QuestionsFloat), so they survive the
 * card being floated and put back, and sends them the way the chat's own box
 * does. A settled set shows its about line and options as plain text.
 *
 * A set about work that started from one of her journal cards also quotes
 * her own words from that card (request_input.py --card), under the about
 * line and above the questions, in every state, folded to three lines
 * (OwnerWords.tsx).
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
 * the chat.", then "i want it to size to the screen if it's that big, with the
 * extra going down at the bottom.", then "similar to Claude planning mode
 * where I can click options it presents or else type in my response", then
 * "Feeling like I need more of an on ramp." (her quoted words).
 */
import type { QuestionOption } from './api';
import type { OpenQuestionSet, QuestionsState } from './events';
import { OwnerWords } from './OwnerWords';
import { OptionsText, QuestionChoices } from './QuestionChoices';
import { composeAnswers, hasRecommendations, type QuestionAnswer } from './questionAnswers';
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
  /** Her answers so far, one per question — held by the page. */
  answers: (QuestionAnswer | undefined)[];
  onAnswer: (index: number, answer: QuestionAnswer | undefined) => void;
  /** Send her composed answers into the session. */
  onSend: (text: string) => void;
  /** Take every recommended option and send now, off the record. */
  onGoRecommended: () => void;
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

/** The about line: what the agent is building and where it stands. */
function About({ about }: { about?: string }) {
  return about ? <p className={styles.about}>{about}</p> : null;
}

/** A settled set's questions: a numbered list, or one paragraph for a single,
 * each with the options it offered as plain text. */
function QuestionList({ questions, options }: { questions: string[]; options?: QuestionOption[][] }) {
  if (questions.length === 1) {
    return (
      <div className={styles.single}>
        {questions[0]}
        <OptionsText options={options?.[0] ?? []} />
      </div>
    );
  }
  return (
    <ol className={styles.list}>
      {questions.map((q, i) => (
        <li key={i}>
          {q}
          <OptionsText options={options?.[i] ?? []} />
        </li>
      ))}
    </ol>
  );
}

/** The open set's questions, each with its options to tap and a box to type
 * in, then Send and "Go with your recommendations". Taps in here answer;
 * they never reach the card's own float/put-back tap. */
function AnswerList({
  questions,
  options,
  float,
}: {
  questions: string[];
  options: QuestionOption[][];
  float: QuestionsFloat;
}) {
  const composed = composeAnswers(questions, options, float.answers);
  const send = () => {
    if (composed) float.onSend(composed);
  };
  return (
    <div className={styles.answering} onClick={(e) => e.stopPropagation()}>
      <ol className={[styles.list, questions.length === 1 ? styles.listSingle : ''].filter(Boolean).join(' ')}>
        {questions.map((q, i) => (
          <li key={i}>
            {q}
            <QuestionChoices
              options={options[i] ?? []}
              answer={float.answers[i]}
              onChange={(answer) => float.onAnswer(i, answer)}
              onSubmit={send}
              label={questions.length > 1 ? `Answer to question ${i + 1}` : 'Your answer'}
            />
          </li>
        ))}
      </ol>
      <div className={styles.sendRow}>
        {hasRecommendations(options) ? (
          <button type="button" className={styles.goRecommended} onClick={float.onGoRecommended}>
            Go with your recommendations
          </button>
        ) : null}
        <button type="button" className={styles.send} disabled={!composed} onClick={send}>
          Send
        </button>
      </div>
    </div>
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
  about,
  words,
  options,
  state,
  answeredElsewhere,
  float,
}: {
  questions: string[];
  /** What the agent said it is building and where it stands. */
  about?: string;
  /** Her own words from the journal card the work started from. */
  words?: string;
  /** Each question's options, lined up with `questions`. */
  options?: QuestionOption[][];
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
        <About about={about} />
        <OwnerWords words={words} />
        <QuestionList questions={questions} options={options} />
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
      <About about={about} />
      <OwnerWords words={words} />
      <AnswerList questions={questions} options={questions.map((_, i) => options?.[i] ?? [])} float={float} />
      <div className={styles.hint}>
        Tap an option or type your own, here or in the box below. Tap the card&rsquo;s heading to keep it in view
        while you scroll.
      </div>
    </div>
  );
}

/** The open set with no transcript line, drawn at the end of the chat. Same
 * block, same switch — its place just isn't a turn. */
export function QuestionsCard({ set, float }: { set: OpenQuestionSet; float: QuestionsFloat }) {
  return (
    <QuestionsBlock
      questions={set.questions}
      about={set.about}
      words={set.words}
      options={set.options}
      state="open"
      float={float}
    />
  );
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

/** The open set, floated: over the chat, just above the message box, as tall
 * as the visible space allows. The heading stays put and a longer list scrolls
 * underneath it, so the way back is always on screen. A tap anywhere sends it
 * back to its place. */
export function QuestionsFloating({
  set,
  float,
  onPutBack,
}: {
  set: OpenQuestionSet;
  float: QuestionsFloat;
  onPutBack: () => void;
}) {
  const { questions } = set;
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
        <About about={set.about} />
        <OwnerWords words={set.words} />
        <AnswerList questions={questions} options={set.options} float={float} />
        <div className={styles.hint}>Tap the card&rsquo;s heading to send it back to its place in the chat.</div>
      </div>
    </div>
  );
}
