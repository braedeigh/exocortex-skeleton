import { useEffect, useRef, useState } from 'react';
import { getActivity } from './api';
import { emptyActivity, foldEvents, type ActivityState } from './activityMath';

/**
 * useActivityFeed.ts — keeps one session's activity current while the pane
 * is open.
 *
 * It polls the activity route, and each poll asks only for the bytes written
 * since the last one (`from` = the `next` the server gave back). So a busy
 * session costs one small read per tick rather than the whole transcript.
 * New events are folded onto the list already on screen (activityMath.ts).
 *
 * The pace follows the session: every 1.5s while it's running, every 8s once
 * it's idle (a new turn can start at any time), and nothing while the tab is
 * hidden. When the server says the read started somewhere other than where
 * we asked (the file was rewritten, or the first read of a long session was
 * clipped to its end), the list starts over.
 *
 * `lastGrowth` is when the transcript last got longer, in browser time. It's
 * how the pane can say "nothing new for 3 minutes" about a running session.
 *
 * Touches: api.ts, activityMath.ts, ActivityPage.tsx.
 */

const LIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 8000;

export interface ActivityFeed {
  state: ActivityState;
  title: string | null;
  running: boolean;
  clipped: boolean;
  /** Browser time (ms) when the transcript last grew; null before the first read. */
  lastGrowth: number | null;
  error: string | null;
  loaded: boolean;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

const blank: ActivityFeed = {
  state: emptyActivity(),
  title: null,
  running: false,
  clipped: false,
  lastGrowth: null,
  error: null,
  loaded: false,
};

export function useActivityFeed(convId: string | undefined): ActivityFeed {
  const visible = usePageVisible();
  const [feed, setFeed] = useState<ActivityFeed>(blank);
  // The resume point survives re-renders without causing them.
  const offset = useRef(0);

  // A different session is a fresh start.
  useEffect(() => {
    offset.current = 0;
    setFeed(blank);
  }, [convId]);

  // The polling loop: one request at a time, then wait, then ask again.
  useEffect(() => {
    if (!convId || !visible) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let stopped = false;

    const tick = async () => {
      let running = false;
      try {
        const from = offset.current;
        const page = await getActivity(convId, from, controller.signal);
        running = page.running;
        const restarted = page.start !== from;
        const grew = page.next !== from || restarted;
        offset.current = page.next;
        setFeed((cur) => {
          const base = restarted ? emptyActivity() : cur.state;
          // On the very first read, the file's own mtime is the best guess
          // at when it last grew; after that, a poll that brought bytes is.
          const firstGrowth = page.mtime ? Date.parse(page.mtime) : Date.now();
          return {
            state: foldEvents(base, page.events),
            title: page.title,
            running: page.running,
            clipped: restarted ? page.clipped : cur.clipped || page.clipped,
            lastGrowth: !cur.loaded ? firstGrowth : grew ? Date.now() : cur.lastGrowth,
            error: null,
            loaded: true,
          };
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'could not reach the server';
        setFeed((cur) => ({ ...cur, error: message, loaded: true }));
      }
      if (stopped) return;
      timer = window.setTimeout(() => void tick(), running ? LIVE_POLL_MS : IDLE_POLL_MS);
    };
    void tick();

    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [convId, visible]);

  return feed;
}
