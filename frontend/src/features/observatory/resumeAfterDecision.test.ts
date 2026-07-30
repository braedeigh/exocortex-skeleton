/**
 * The rule these pin down: a 409 from the send door means "the blocked turn is
 * still winding down", so the resume waits and asks again; anything else is a
 * real failure and must surface immediately rather than being retried into a
 * silent dead end. The bug this came from — tapping Approve did nothing —
 * was the first case being treated as the second.
 */
import { describe, it, expect, vi } from 'vitest';
import { SendError } from './api';
import { resumeAfterDecision } from './resumeAfterDecision';

const busy = () => new SendError('a turn is already running in this conversation', 409);
const noSleep = () => Promise.resolve();

describe('resumeAfterDecision', () => {
  it('sends once when the conversation is already idle', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await resumeAfterDecision(send, { sleep: noSleep });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying while the turn is still winding down, then succeeds', async () => {
    // The real shape of the bug: the Approve card appears mid-turn, so the
    // first few resumes land on a conversation that is still busy.
    const send = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue(undefined);
    await resumeAfterDecision(send, { sleep: noSleep });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('waits between attempts so it is not a spin loop', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue(undefined);
    await resumeAfterDecision(send, { sleep, delayMs: 1500 });
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('gives up and reports when the turn never releases', async () => {
    // An agent that ignored the stop and kept working. She must get a visible
    // failure she can act on, not a button that quietly did nothing.
    const send = vi.fn().mockRejectedValue(busy());
    await expect(
      resumeAfterDecision(send, { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow(/already running/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that is not a busy turn', async () => {
    const send = vi.fn().mockRejectedValue(new SendError('not found', 404));
    await expect(resumeAfterDecision(send, { sleep: noSleep })).rejects.toThrow(/not found/);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
