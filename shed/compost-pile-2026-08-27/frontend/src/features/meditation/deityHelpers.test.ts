import { describe, expect, it } from 'vitest';
import { deityDisplayName, parseDeityMantra, parseDeityName, sortProfiles } from './deityHelpers';

describe('parseDeityName', () => {
  it('takes the first # H1 heading', () => {
    expect(parseDeityName('intro\n# Medicine Buddha\n# Second')).toBe('Medicine Buddha');
  });

  it('ignores deeper headings and trims whitespace', () => {
    expect(parseDeityName('## Not me\n#   Tārā  ')).toBe('Tārā');
  });

  it('returns empty when there is no H1', () => {
    expect(parseDeityName('just text')).toBe('');
    expect(parseDeityName('')).toBe('');
    expect(parseDeityName('#no-space-heading')).toBe('');
  });
});

describe('parseDeityMantra', () => {
  it('takes the first non-empty line after a "Romanized text" label', () => {
    const body = '# X\n\n**Romanized text:**\n\noṃ tāre tuttāre ture svāhā\nmore';
    expect(parseDeityMantra(body)).toBe('oṃ tāre tuttāre ture svāhā');
  });

  it('matches the label case-insensitively and through bold markers', () => {
    expect(parseDeityMantra('ROMANIZED TEXT\nom mani padme hum')).toBe('om mani padme hum');
  });

  it('handles CRLF bodies', () => {
    expect(parseDeityMantra('**Romanized text:**\r\nom ah hum')).toBe('om ah hum');
  });

  it('returns empty when the label is absent', () => {
    expect(parseDeityMantra('# X\nno mantra here')).toBe('');
  });
});

describe('deityDisplayName / sortProfiles', () => {
  it('prefers stored name, then parsed H1, then Untitled', () => {
    expect(deityDisplayName({ id: '1', name: 'Chenrezig' })).toBe('Chenrezig');
    expect(deityDisplayName({ id: '2', body: '# Vajrasattva' })).toBe('Vajrasattva');
    expect(deityDisplayName({ id: '3' })).toBe('Untitled');
  });

  it('sorts alphabetically by display name without mutating input', () => {
    const profiles = [
      { id: '1', name: 'Tārā' },
      { id: '2', body: '# Amitābha' },
      { id: '3', name: 'Manjushri' },
    ];
    expect(sortProfiles(profiles).map((p) => p.id)).toEqual(['2', '3', '1']);
    expect(profiles[0].id).toBe('1');
  });
});
