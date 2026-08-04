/**
 * sseFrames.test.ts — pins the stream-cutting contract streamSend leans on:
 * a frame only exists once its blank-line separator has arrived (everything
 * after the last separator is carried, not parsed), non-`data:` frames (the
 * server's keepalive comments) vanish silently, and torn JSON skips one frame
 * without poisoning the ones after it. These are the failure modes a live
 * fetch stream would make invisible.
 */
import { describe, expect, it } from 'vitest';
import { parseSseChunk } from './sseFrames';

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe('parseSseChunk', () => {
  it('parses complete frames and carries the trailing partial', () => {
    const buffer = frame({ type: 'a' }) + frame({ type: 'b' }) + 'data: {"type":"c"';
    const { events, rest } = parseSseChunk(buffer);
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(rest).toBe('data: {"type":"c"');
  });

  it('finishes a carried partial once the rest of the frame arrives', () => {
    const first = parseSseChunk('data: {"type":"a"');
    expect(first.events).toEqual([]);
    const second = parseSseChunk(first.rest + '}\n\ndata: {"type":"b"}\n\n');
    expect(second.events).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(second.rest).toBe('');
  });

  it('drops keepalive comments and other non-data frames without ceremony', () => {
    const { events, rest } = parseSseChunk(': keepalive\n\n' + frame({ type: 'a' }));
    expect(events).toEqual([{ type: 'a' }]);
    expect(rest).toBe('');
  });

  it('skips a torn-JSON frame and resyncs on the next one', () => {
    const buffer = 'data: {"type":"br\n\n' + frame({ type: 'after' });
    const { events } = parseSseChunk(buffer);
    expect(events).toEqual([{ type: 'after' }]);
  });

  it('an empty or separator-only buffer yields nothing and no carry', () => {
    expect(parseSseChunk('')).toEqual({ events: [], rest: '' });
    expect(parseSseChunk('\n\n')).toEqual({ events: [], rest: '' });
  });
});
