import { useCallback, useState, type MutableRefObject } from 'react';
import { getConversation } from './api';
import { turnsFromHistory, type Turn } from './events';

/**
 * useReattach.ts — re-attach to a turn that's still running server-side:
 * poll the log every couple of seconds and re-render from history
 * (message-granular — token deltas aren't logged, and that's fine for a
 * window that just came back). Ends when the index says the turn is over,
 * she leaves the page, or ten minutes pass without an ending (then it's
 * honest about giving up).
 */
export function useReattach(args: {
  convRef: MutableRefObject<string | undefined>;
  mountedRef: MutableRefObject<boolean>;
  onTurns: (turns: Turn[]) => void;
  onStart: () => void;
  onGiveUp: (msg: string) => void;
}): {
  reattaching: boolean;
  reattach: (conv: string) => Promise<void>;
} {
  const { convRef, mountedRef, onTurns, onStart, onGiveUp } = args;
  const [reattaching, setReattaching] = useState(false);

  const reattach = useCallback(
    async (conv: string) => {
      setReattaching(true);
      onStart();
      try {
        const deadline = Date.now() + 600_000;
        while (Date.now() < deadline) {
          if (!mountedRef.current || convRef.current !== conv) return;
          try {
            const data = await getConversation(conv);
            if (!mountedRef.current || convRef.current !== conv) return;
            onTurns(turnsFromHistory(data.events));
            if (data.meta?.running !== true) return;
          } catch {
            // transient (offline, worker restart) — keep polling
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        onGiveUp('Lost sight of the reply — it may still be finishing. Reload to check.');
      } finally {
        if (mountedRef.current) setReattaching(false);
      }
    },
    [convRef, mountedRef, onTurns, onStart, onGiveUp],
  );

  return { reattaching, reattach };
}
