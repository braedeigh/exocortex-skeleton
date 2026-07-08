import { useEffect, useState } from 'react';
import { getNeedsInput } from './shellApi';

const POLL_MS = 4000;

/**
 * "A terminal that needs input that's not the chat [should] turn a different
 * color until I open it and send another message into it." Polls
 * /api/terminal/needs-input (routes/terminal.py), which reuses the same
 * confirmation-prompt heuristic terminal_send() already checks before typing
 * — so the flag clears itself on the next poll once the prompt is answered
 * (terminal_send() auto-accepts it and the pane content moves on), no extra
 * "seen" bookkeeping needed here.
 */
export function useNeedsInput(enabled: boolean): Record<string, boolean> {
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!enabled) {
      setFlags({});
      return;
    }
    let cancelled = false;
    const poll = () => {
      getNeedsInput()
        .then((data) => {
          if (!cancelled) setFlags(data.sessions || {});
        })
        .catch(() => {
          // best-effort — next poll will retry
        });
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  return flags;
}
