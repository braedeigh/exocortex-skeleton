/**
 * sendFailure.test.ts — pins the rule that a send which doesn't start a turn
 * never loses her message: each way it can fail names where the words go.
 * The case that was broken: a refusal because a turn the app started (a watch
 * firing) was already running was handled like a dropped connection, and the
 * re-read of the record wiped her message off the page.
 */
import { describe, expect, it } from 'vitest';
import { SendError } from './api';
import { turnsFromHistory } from './events';
import { messageWasRecorded, sendFailureKind } from './sendFailure';

describe('sendFailureKind', () => {
  it('sends her message to the mailbox when a turn she did not start is running', () => {
    const refusal = new SendError('a turn is already running in this conversation', 409, { busy: true });
    expect(sendFailureKind(refusal)).toBe('busy');
  });

  it('gives her words back for every other answer from the server', () => {
    // A 409 that is not "busy" (a night session with nowhere to put a reply)
    // must not be put in the mailbox: no turn would ever take it.
    expect(sendFailureKind(new SendError('a reply has nowhere to go', 409))).toBe('refused');
    expect(sendFailureKind(new SendError('not found', 404))).toBe('refused');
    expect(sendFailureKind(new SendError('send failed (500)', 500))).toBe('refused');
  });

  it('treats a dropped connection as unknown, to be checked against the record', () => {
    expect(sendFailureKind(new TypeError('Failed to fetch'))).toBe('unknown');
  });
});

describe('messageWasRecorded', () => {
  // The record of the chat this came from: her message, its reply, then the
  // turn a fired watch started. She sent "one more thing" at place 2.
  const watchTurn = [
    { type: 'user', text: 'spin up the swarm' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'reminder', text: 'Watch fired — #168: asked her something', source: 'helper-watch' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'It asked you five things.' }] } },
  ];

  it('says no when the record holds only the turn that got in first', () => {
    expect(messageWasRecorded(turnsFromHistory(watchTurn), 2, 'one more thing')).toBe(false);
  });

  it('says yes once the server has her words, wherever they landed after that place', () => {
    const record = turnsFromHistory([...watchTurn, { type: 'user', text: 'one more thing' }]);
    expect(messageWasRecorded(record, 2, 'one more thing')).toBe(true);
  });

  it('does not mistake the same words said much earlier for this send', () => {
    const earlier = [{ type: 'user', text: 'ok' }, ...Array(6).fill(watchTurn[1]), ...watchTurn];
    const turns = turnsFromHistory(earlier);
    expect(messageWasRecorded(turns, turns.length, 'ok')).toBe(false);
  });
});
