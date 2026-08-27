import { describe, expect, it } from 'vitest';
import { agentLabel, originLine, refTarget, stampLabel } from './provenance';

const fmt = (d: string) => `D(${d})`;

describe('agentLabel', () => {
  it('names the known agents and humanises the rest', () => {
    expect(agentLabel('triage')).toBe('Triage');
    expect(agentLabel('cricket:todos')).toBe('Todos cricket');
    expect(agentLabel('session:job-hunt')).toBe('Job hunt session');
  });
});

describe('refTarget', () => {
  it('sends a card to its journal day', () => {
    expect(refTarget('card:2026-08-20.1432a')).toEqual({
      kind: 'route', label: 'journal 2026-08-20', to: '/journal', search: { date: '2026-08-20' },
    });
  });
  it('sends a conversation to the observatory', () => {
    expect(refTarget('conv:abc')).toMatchObject({ kind: 'route', to: '/observatory/abc' });
  });
  it('shows a url by host and a file as text', () => {
    expect(refTarget('url:https://example.org/x')).toEqual({ kind: 'external', label: 'example.org', href: 'https://example.org/x' });
    expect(refTarget('file:tulku/notes.md')).toEqual({ kind: 'text', label: 'tulku/notes.md' });
  });
  it('never links something it does not understand', () => {
    expect(refTarget('vibes').kind).toBe('text');
  });
});

describe('originLine', () => {
  it('says unrecorded rather than guessing for pre-stamp items', () => {
    expect(originLine(undefined, '2026-07-01', fmt)).toBe('Added D(2026-07-01) · author unrecorded');
  });
  it('names you or the agent', () => {
    expect(originLine({ by: 'owner', at: '2026-08-27T10:00' }, null, fmt)).toBe('Added by you · D(2026-08-27)');
    expect(originLine({ by: 'triage', at: '2026-08-27T10:00' }, null, fmt)).toBe('Added by Triage · D(2026-08-27)');
  });
});

describe('stampLabel', () => {
  it('keeps the minute when there is one', () => {
    expect(stampLabel('2026-08-27T10:05', fmt)).toBe('D(2026-08-27), 10:05');
    expect(stampLabel('2026-08-27', fmt)).toBe('D(2026-08-27)');
  });
});
