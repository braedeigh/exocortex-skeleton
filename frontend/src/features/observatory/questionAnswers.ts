/**
 * questionAnswers.ts — turning her answers to a question set into the one
 * message the session receives.
 *
 * A session files several questions at once, each maybe with tappable options
 * (request_input.py --option). On the roster's orange card and in the chat she
 * answers each one by tapping an option or typing her own words
 * (QuestionChoices.tsx). The PARENT holds those answers, one per question,
 * and uses composeAnswers to make the message Send puts into the session's
 * mailbox: numbered to match the questions, so the agent can tell which
 * answer belongs to which question. A single question sends just its answer.
 *
 * recommendedAnswers is the "Go with your recommendations" button: it picks
 * the first (recommended) option on every question that has options.
 *
 * Pure, so it's tested on its own (questionAnswers.test.ts). Used by
 * SessionCard.tsx (AwaitingCard) and ObservatoryPage.tsx (the chat's open set).
 */
import type { QuestionOption } from './api';

/** Her answer to one question: an option she tapped (by its place in the
 * list), or words she typed. */
export type QuestionAnswer = { kind: 'option'; index: number } | { kind: 'typed'; text: string };

/** The line sent for a question nobody recommended anything for. */
export const NO_RECOMMENDATION = '(no recommendation — you decide)';

/** One answer as words: the option's label, or what she typed. Empty when
 * she hasn't answered this one. */
function answerText(answer: QuestionAnswer | undefined, options: QuestionOption[]): string {
  if (!answer) return '';
  if (answer.kind === 'typed') return answer.text.trim();
  return options[answer.index]?.label ?? '';
}

/** The message Send sends: "1. <answer>" per question she answered, in
 * question order, or just the answer when there's only one question. Empty
 * when she has answered nothing — the Send button stays off then. */
export function composeAnswers(
  questions: string[],
  options: QuestionOption[][],
  answers: (QuestionAnswer | undefined)[],
): string {
  const said = questions.map((_, i) => answerText(answers[i], options[i] ?? []));
  if (questions.length === 1) return said[0];
  return said
    .map((text, i) => (text ? `${i + 1}. ${text}` : ''))
    .filter(Boolean)
    .join('\n');
}

/** Go with the recommendations: the recommended option on every question
 * that has options, and NO_RECOMMENDATION on every one that doesn't. */
export function recommendedAnswers(questions: string[], options: QuestionOption[][]): string {
  const said = questions.map((_, i) => {
    const offered = options[i] ?? [];
    const pick = offered.find((o) => o.recommended) ?? offered[0];
    return pick ? pick.label : NO_RECOMMENDATION;
  });
  if (questions.length === 1) return said[0];
  return said.map((text, i) => `${i + 1}. ${text}`).join('\n');
}

/** True when at least one question offers options — the only time the
 * "Go with your recommendations" button is shown. */
export function hasRecommendations(options: QuestionOption[][]): boolean {
  return options.some((offered) => offered.length > 0);
}
