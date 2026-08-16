import { describe, expect, it } from 'vitest';
import { cardMoment, todoDoneFromChange } from './todoDoneApproval';

describe('todoDoneFromChange', () => {
  it('reads the staged payload into a display draft', () => {
    expect(
      todoDoneFromChange({
        payload: {
          id: 'desk_assembly',
          text: 'assemble the desk',
          card_id: '2026-08-12.2142b',
          quote: 'built the whole thing tonight',
        },
      }),
    ).toEqual({
      todoId: 'desk_assembly',
      text: 'assemble the desk',
      cardId: '2026-08-12.2142b',
      quote: 'built the whole thing tonight',
    });
  });

  it('degrades missing fields to empty strings instead of crashing', () => {
    expect(todoDoneFromChange({ payload: null }).quote).toBe('');
  });
});

describe('cardMoment', () => {
  it('renders the card id as day · minute', () => {
    expect(cardMoment('2026-08-12.2142b')).toBe('2026-08-12 · 21:42');
    expect(cardMoment('2026-08-12.2142b2')).toBe('2026-08-12 · 21:42');
  });

  it('leaves a malformed id as-is rather than inventing a moment', () => {
    expect(cardMoment('not-a-card')).toBe('not-a-card');
  });
});
