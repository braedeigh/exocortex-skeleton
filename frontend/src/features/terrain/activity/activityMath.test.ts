import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from './api';
import {
  callStatus,
  emptyActivity,
  foldEvents,
  formatDuration,
  readableInput,
  stallWarning,
  tally,
  type CallStep,
} from './activityMath';

const call = (id: string, at = '2026-09-24T12:00:00.000'): ActivityEvent => ({
  kind: 'call', at, parent: null, id, name: 'Bash', target: 'ls',
  input: '{"command": "ls"}', input_cut: false,
});
const result = (id: string, isError = false): ActivityEvent => ({
  kind: 'result', at: '2026-09-24T12:00:02.000', parent: null, id,
  output: 'out', output_cut: false, chars: 3, is_error: isError,
});

describe('foldEvents', () => {
  it('pairs a result that arrives in a later poll with its call', () => {
    const first = foldEvents(emptyActivity(), [call('a')]);
    const second = foldEvents(first, [result('a')]);
    expect((second.steps[0] as CallStep).result?.output).toBe('out');
  });

  it('keeps one row when the same call is read twice', () => {
    const state = foldEvents(emptyActivity(), [call('a'), call('a')]);
    expect(state.steps).toHaveLength(1);
  });

  it('gives an orphan result its own placeholder row', () => {
    const state = foldEvents(emptyActivity(), [result('lost')]);
    expect((state.steps[0] as CallStep).name).toBe('?');
  });

  it('dates an undated event with the last clock seen', () => {
    const state = foldEvents(emptyActivity(), [call('a'), { kind: 'error', text: 'claude exited 1' }]);
    expect(state.steps[1].at).toBe('2026-09-24T12:00:00.000');
  });

  it('records a heartbeat as the running call’s elapsed time', () => {
    const state = foldEvents(emptyActivity(), [call('a'), { kind: 'progress', id: 'a', elapsed: 30 }]);
    expect((state.steps[0] as CallStep).elapsed).toBe(30);
  });

  it('leaves the old state untouched', () => {
    const first = foldEvents(emptyActivity(), [call('a')]);
    foldEvents(first, [result('a')]);
    expect((first.steps[0] as CallStep).result).toBeNull();
  });
});

describe('callStatus', () => {
  it('calls an unanswered call in a stopped session cut off', () => {
    const state = foldEvents(emptyActivity(), [call('a')]);
    expect(callStatus(state.steps[0] as CallStep, false)).toBe('cut off');
  });

  it('puts a refusal ahead of everything else', () => {
    const state = foldEvents(emptyActivity(), [
      call('a'),
      { kind: 'denied', id: 'a', tool: 'Bash', reason: 'nope', text: null },
      result('a', true),
    ]);
    expect(callStatus(state.steps[0] as CallStep, true)).toBe('denied');
  });
});

describe('tally', () => {
  it('counts calls, failures and retries', () => {
    const state = foldEvents(emptyActivity(), [
      call('a'), result('a', true), call('b'),
      { kind: 'retry', attempt: 1, max: 10, error: 'overloaded', status: 529, delay_ms: 500 },
    ]);
    expect(tally(state.steps, true)).toEqual({ calls: 2, running: 1, errors: 1, retries: 1, denied: 0 });
  });
});

describe('stallWarning', () => {
  it('names the tool a quiet running session is waiting on', () => {
    const state = foldEvents(emptyActivity(), [call('a')]);
    expect(stallWarning(state.steps, true, 180_000)).toBe('Waiting on Bash — nothing new written for 3m 00s.');
  });

  it('stays quiet for a short silence', () => {
    expect(stallWarning([], true, 10_000)).toBeNull();
  });
});

describe('formatDuration', () => {
  it.each([
    [340, '340ms'],
    [12_000, '12s'],
    [185_000, '3m 05s'],
    [3_720_000, '1h 02m'],
  ])('%i ms reads as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('readableInput', () => {
  it('shows a Bash call as its command', () => {
    expect(readableInput({ name: 'Bash', input: '{"command": "git status"}' })).toBe('git status');
  });

  it('shows a cut input as it came', () => {
    expect(readableInput({ name: 'Edit', input: '{"file_path": "a.py", "old' })).toBe('{"file_path": "a.py", "old');
  });
});
