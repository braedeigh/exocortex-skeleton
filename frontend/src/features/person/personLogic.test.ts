import { describe, expect, it } from 'vitest';
import {
  RESERVED_FACT_KEYS,
  buildFactsPayload,
  capitalizeKey,
  factRows,
  mentionNav,
  monthYear,
  storyText,
} from './personLogic';

describe('factRows', () => {
  it('always shows the four seed fields, empty when unset', () => {
    expect(factRows({})).toEqual([
      { key: 'relationship', value: '' },
      { key: 'age', value: '' },
      { key: 'lives', value: '' },
      { key: 'work', value: '' },
    ]);
  });

  it('appends non-seed facts after the seeds, in file order', () => {
    const rows = factRows({ pets: 'two cats', lives: 'Austin', met: 'yoga class' });
    expect(rows.map((r) => r.key)).toEqual(['relationship', 'age', 'lives', 'work', 'pets', 'met']);
    expect(rows[2]).toEqual({ key: 'lives', value: 'Austin' });
  });
});

describe('buildFactsPayload', () => {
  it('sends every displayed non-empty fact, missing seeds as empty strings', () => {
    expect(buildFactsPayload({ lives: 'Austin', pets: 'two cats' }, {})).toEqual({
      lives: 'Austin',
      pets: 'two cats',
      relationship: '',
      age: '',
      work: '',
    });
  });

  it('applies the edit on top, including clearing a value', () => {
    const payload = buildFactsPayload({ lives: 'Austin' }, { lives: '', age: '44' });
    expect(payload.lives).toBe('');
    expect(payload.age).toBe('44');
  });

  it('can introduce a brand-new key', () => {
    expect(buildFactsPayload({}, { met: 'yoga class' }).met).toBe('yoga class');
  });
});

describe('capitalizeKey / monthYear', () => {
  it('capitalizes only the first letter', () => {
    expect(capitalizeKey('relationship')).toBe('Relationship');
  });

  it('formats "Mon YYYY"', () => {
    expect(monthYear('2026-02-14')).toBe('Feb 2026');
  });

  it('passes garbage through unformatted', () => {
    expect(monthYear('not-a-date')).toBe('not-a-date');
  });
});

describe('storyText', () => {
  it('strips the "## Referenced In" tail (any case), keeping the narrative', () => {
    const body = 'She fixes bikes.\n\n## Referenced in\n- [[2026-05-10]] (note)\n';
    expect(storyText(body)).toBe('She fixes bikes.');
  });

  it('returns the trimmed body when there is no Referenced In section', () => {
    expect(storyText('\nJust a story.\n')).toBe('Just a story.');
  });

  it('is empty for a missing body', () => {
    expect(storyText(undefined)).toBe('');
  });
});

describe('mentionNav', () => {
  it('routes dated daily-journal files to the journal', () => {
    expect(mentionNav({ file: 'Journal/Daily/2026-07-03.md', date: '2026-07-03' })).toEqual({
      kind: 'journal',
      date: '2026-07-03',
    });
  });

  it('routes everything else (and undated journal files) to the keeper', () => {
    expect(mentionNav({ file: 'THREADS.md', date: '' })).toEqual({ kind: 'keeper', path: 'THREADS.md' });
    expect(mentionNav({ file: 'Journal/Daily/undated.md', date: '' })).toEqual({
      kind: 'keeper',
      path: 'Journal/Daily/undated.md',
    });
  });
});

describe('RESERVED_FACT_KEYS', () => {
  it('blocks tags and aliases, same as the server', () => {
    expect(RESERVED_FACT_KEYS.has('tags')).toBe(true);
    expect(RESERVED_FACT_KEYS.has('aliases')).toBe(true);
  });
});
