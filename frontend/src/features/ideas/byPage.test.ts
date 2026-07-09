import { describe, expect, it } from 'vitest';
import { ideasTabLabel, visibleIdeaTabs } from './byPage';

const note = { id: 'x', text: 't', created: '' };

describe('visibleIdeaTabs', () => {
  it('always shows general, even with no data at all', () => {
    expect(visibleIdeaTabs(undefined)).toEqual(['general']);
    expect(visibleIdeaTabs({})).toEqual(['general']);
  });

  it('hides known tabs with no notes and shows the ones with notes, in canonical order', () => {
    const tabs = visibleIdeaTabs({ kitchen: [note], today: [note], map: [] });
    expect(tabs).toEqual(['general', 'today', 'kitchen']);
  });

  it('appends unknown tabs with notes after the canonical order', () => {
    const tabs = visibleIdeaTabs({ journal: [note], today: [note] });
    expect(tabs).toEqual(['general', 'today', 'journal']);
  });

  it('hides an empty general-like known tab but never general itself', () => {
    expect(visibleIdeaTabs({ general: [] })).toEqual(['general']);
  });
});

describe('ideasTabLabel', () => {
  it('uses the known label map', () => {
    expect(ideasTabLabel('today')).toBe('To Do');
    expect(ideasTabLabel('map')).toBe('Life Map');
    expect(ideasTabLabel('ideas')).toBe('Ideas page');
    expect(ideasTabLabel('global')).toBe('Global');
  });

  it('capitalizes unknown tab names', () => {
    expect(ideasTabLabel('journal')).toBe('Journal');
  });
});
