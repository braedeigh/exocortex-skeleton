import { describe, expect, it } from 'vitest';
import { barWidth, orderTerms, residueWords, shareWords, termBand, yearsWords } from './exposureMath';
import type { ExposureTerm } from './types';
import type { OrganicVerdict } from '../kitchen/types';

const BANDS: [number, OrganicVerdict][] = [
  [0.1, 'organic'],
  [0.01, 'some'],
];

function term(over: Partial<ExposureTerm>): ExposureTerm {
  return {
    pesticide_code: '001', pesticide: 'X', hazard_id: 1, samples_tested: 10, samples_detected: 1,
    mean_ppb: 1, max_ppb: 1, dose: 0.01, dose_fact_id: 1, dri: 0.001, ...over,
  };
}

describe('shareWords', () => {
  it('says multiples above the safe dose and percents below', () => {
    expect([shareWords(2.07), shareWords(0.2), shareWords(0.017), shareWords(0.00001), shareWords(null)]).toEqual([
      '2.1× the safe daily dose',
      '20% of the safe daily dose',
      '1.7% of the safe daily dose',
      'under 0.1% of the safe daily dose',
      'no EPA safe dose to compare',
    ]);
  });
});

describe('residueWords', () => {
  it('switches to ppm from 1000 ppb', () => {
    expect([residueWords(2918.75), residueWords(48.4), residueWords(0.25), residueWords(0)]).toEqual([
      '2.9 ppm', '48 ppb', '0.3 ppb', '0 ppb',
    ]);
  });
});

describe('termBand', () => {
  it('puts a found pesticide with no dose in the open band and a never-found one in the clear', () => {
    expect([
      termBand(term({ dri: 0.5 }), BANDS),
      termBand(term({ dri: 0.05 }), BANDS),
      termBand(term({ dri: null, dose: null }), BANDS),
      termBand(term({ samples_detected: 0, dri: null }), BANDS),
    ]).toEqual(['organic', 'some', 'open', 'conventional']);
  });
});

describe('orderTerms', () => {
  it('lists scored finds by share, then undosed finds, then the never-found', () => {
    const ordered = orderTerms([
      term({ pesticide: 'never', samples_detected: 0, dri: null }),
      term({ pesticide: 'undosed', dri: null }),
      term({ pesticide: 'small', dri: 0.001 }),
      term({ pesticide: 'big', dri: 2 }),
    ]);
    expect(ordered.map((each) => each.pesticide)).toEqual(['big', 'small', 'undosed', 'never']);
  });
});

describe('barWidth and yearsWords', () => {
  it('draws on a log scale and joins years', () => {
    expect([barWidth(0.001), barWidth(10), barWidth(0.1), barWidth(null)]).toEqual([0, 100, 50, 0]);
    expect(yearsWords('2017,2018')).toBe('2017 + 2018');
  });
});
