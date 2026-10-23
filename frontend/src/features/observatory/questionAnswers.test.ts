import { describe, expect, it } from 'vitest';
import type { QuestionOption } from './api';
import { composeAnswers, NO_RECOMMENDATION, recommendedAnswers, type QuestionAnswer } from './questionAnswers';

const opt = (label: string, recommended = false): QuestionOption => ({ label, detail: `${label} because`, recommended });

const questions = ['Where should lint run?', 'Keep the old config?', 'Anything else?'];
const options = [[opt('In CI only', true), opt('Pre-commit')], [opt('Keep it', true), opt('Delete it')], []];

describe('composeAnswers', () => {
  it('numbers a mix of tapped and typed answers in question order, skipping unanswered ones', () => {
    const answers: (QuestionAnswer | undefined)[] = [
      { kind: 'option', index: 1 },
      undefined,
      { kind: 'typed', text: '  ship it after lunch  ' },
    ];
    expect(composeAnswers(questions, options, answers)).toBe('1. Pre-commit\n3. ship it after lunch');
  });

  it('sends a lone question its answer alone, and nothing when nothing is answered', () => {
    expect(composeAnswers(['Public repo?'], [[opt('Yes', true), opt('No')]], [{ kind: 'option', index: 0 }])).toBe('Yes');
    expect(composeAnswers(questions, options, [undefined, { kind: 'typed', text: '   ' }])).toBe('');
  });
});

describe('recommendedAnswers', () => {
  it('takes the recommended option everywhere there is one and says so where there is none', () => {
    expect(recommendedAnswers(questions, options)).toBe(`1. In CI only\n2. Keep it\n3. ${NO_RECOMMENDATION}`);
  });
});
