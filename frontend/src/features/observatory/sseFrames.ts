/**
 * sseFrames.ts — the pure center of streamSend's SSE handling: cut a growing
 * byte-buffer into complete frames, parse the `data: ` ones as JSON, and hand
 * back the trailing partial so the next network chunk can finish it.
 *
 * Extracted from api.ts's streamSend loop so the one place a protocol bug
 * would be silent — partial-frame carry, torn-JSON resync — is plain string
 * work with its own tests (sseFrames.test.ts), instead of logic reachable
 * only through a live fetch stream.
 *
 * The contract, exactly as the send loop needs it:
 *   - frames are blank-line separated (`\n\n`); the text after the last
 *     separator is NOT a frame yet — it comes back as `rest`, to be prepended
 *     to the next chunk.
 *   - only `data: `-prefixed frames carry events; anything else (the server's
 *     `: keepalive` comments) is dropped without ceremony.
 *   - a frame whose JSON won't parse is skipped, not fatal — the next frame
 *     resyncs the stream.
 *   - when the stream closes, whatever is still carried is the last frame,
 *     separator or not — flushSseRest parses it so it isn't dropped.
 */

/** Parse everything complete in `buffer`; `rest` is the trailing partial
 * frame to carry into the next call. */
export function parseSseChunk(buffer: string): {
  events: Record<string, unknown>[];
  rest: string;
} {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: Record<string, unknown>[] = [];
  for (const frame of frames) {
    const line = frame.trim();
    if (!line.startsWith('data: ')) continue;
    try {
      events.push(JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
    } catch {
      continue; // torn frame — the next one resyncs us
    }
  }
  return { events, rest };
}

/** Parse the carry left over when the stream ends. A server that closes
 * without a final blank line still meant that last frame. */
export function flushSseRest(rest: string): Record<string, unknown>[] {
  return rest.trim() ? parseSseChunk(rest + '\n\n').events : [];
}
