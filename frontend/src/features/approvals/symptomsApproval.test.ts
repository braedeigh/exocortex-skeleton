import { describe, expect, it } from 'vitest';
import {
  buildSymptomsLog,
  symptomsDraftFromPayload,
  symptomsUndoValues,
} from './symptomsApproval';
import type { HealthDay } from '../todos/types';

const TODAY = '2026-07-09';

describe('symptomsDraftFromPayload', () => {
  it('preselects only the fields the cricket sent', () => {
    const d = symptomsDraftFromPayload(
      { date: '2026-07-08', brain_fog: 2, energy: 0, histamine_flare: 'yes', flare_trigger: 'onions' },
      TODAY,
    );
    expect(d.levels).toEqual({ brain_fog: 2, energy: 0 });
    expect(d.flare).toBe('yes');
    expect(d.trigger).toBe('onions');
    expect(d.date).toBe('2026-07-08');
  });

  it('ignores null/empty field values and defaults flare to no, date to today', () => {
    const d = symptomsDraftFromPayload({ brain_fog: null, headache: '' }, TODAY);
    expect(d.levels).toEqual({});
    expect(d.flare).toBe('no');
    expect(d.date).toBe(TODAY);
  });

  it('coerces numeric strings ("2" from JSON round-trips)', () => {
    expect(symptomsDraftFromPayload({ headache: '2' }, TODAY).levels).toEqual({ headache: 2 });
  });
});

describe('buildSymptomsLog', () => {
  it('requires a date', () => {
    expect(buildSymptomsLog({ date: '', levels: {}, flare: 'no', trigger: '' }).ok).toBe(false);
  });

  it('commits only selected fields, always includes histamine_flare, and the trigger only when non-empty', () => {
    const r = buildSymptomsLog({
      date: TODAY,
      levels: { brain_fog: 2, energy: 0 },
      flare: 'yes',
      trigger: ' onions ',
    });
    expect(r).toEqual({
      ok: true,
      value: {
        date: TODAY,
        symptoms: { brain_fog: 2, energy: 0, histamine_flare: 'yes', flare_trigger: 'onions' },
      },
    });
  });

  it('with nothing selected still posts histamine_flare (legacy default "no")', () => {
    const r = buildSymptomsLog({ date: TODAY, levels: {}, flare: 'no', trigger: '' });
    expect(r.ok && r.value.symptoms).toEqual({ histamine_flare: 'no' });
  });

  it('keeps a selected 0 (energy 0 "Crashed" is signal, not falsiness)', () => {
    const r = buildSymptomsLog({ date: TODAY, levels: { energy: 0 }, flare: 'no', trigger: '' });
    expect(r.ok && r.value.symptoms.energy).toBe(0);
  });
});

describe('symptomsUndoValues', () => {
  it('is null when no prior row existed (caller falls back to reopen)', () => {
    expect(symptomsUndoValues(null)).toBeNull();
  });

  it('keeps the legacy column set from the prior row, dropping empty values', () => {
    const prev: HealthDay = {
      date: TODAY,
      brain_fog: 1,
      energy: 0,
      headache: null,
      hand_pain: undefined,
      histamine_flare: 'no',
      flare_trigger: '',
      nose_spray: 1,
      food_notes: 'not a symptom column', // outside the column set — never restored
    };
    expect(symptomsUndoValues(prev)).toEqual({
      brain_fog: 1,
      energy: 0,
      histamine_flare: 'no',
      nose_spray: 1,
    });
  });

  it('returns an empty record for a row with no symptom signal (legacy re-POSTed it anyway)', () => {
    expect(symptomsUndoValues({ date: TODAY })).toEqual({});
  });
});
