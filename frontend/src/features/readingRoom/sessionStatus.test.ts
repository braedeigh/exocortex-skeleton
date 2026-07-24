/**
 * sessionStatus — busy beats everything, ready needs fresh activity she
 * hasn't opened, idle is the quiet default.
 */
import { describe, expect, it } from 'vitest';
import { sessionStatus } from './sessionStatus';

describe('busy', () => {
  it('wins outright when a turn is running, regardless of last_at/openedAt', () => {
    expect(sessionStatus({ running: true, last_at: '2026-07-23T10:00:00' }, '2026-07-23T12:00:00')).toBe('busy');
  });
});

describe('ready', () => {
  it('flags activity newer than the last time she opened the session', () => {
    expect(sessionStatus({ last_at: '2026-07-23T12:00:00' }, '2026-07-23T10:00:00')).toBe('ready');
  });

  it('treats never-opened as ready when there is any activity', () => {
    expect(sessionStatus({ last_at: '2026-07-23T12:00:00' }, undefined)).toBe('ready');
  });

  it('treats a corrupt openedAt as never-opened rather than crashing', () => {
    expect(sessionStatus({ last_at: '2026-07-23T12:00:00' }, 'not-a-date')).toBe('ready');
  });
});

describe('idle', () => {
  it('is idle once she has opened the session after its last activity', () => {
    expect(sessionStatus({ last_at: '2026-07-23T10:00:00' }, '2026-07-23T12:00:00')).toBe('idle');
  });

  it('is idle with no last_at at all (a session that never had a reply)', () => {
    expect(sessionStatus({}, undefined)).toBe('idle');
  });

  it('is idle for a corrupt last_at rather than reading as ready forever', () => {
    expect(sessionStatus({ last_at: 'not-a-date' }, undefined)).toBe('idle');
  });

  it('running: false is not busy — falls through to the ready/idle check', () => {
    expect(sessionStatus({ running: false, last_at: '2026-07-23T12:00:00' }, '2026-07-23T10:00:00')).toBe('ready');
  });
});
