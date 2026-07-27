import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ApiError } from '../../api/client';
import { getKeeperRolloverStatus, getSessions, startKeeperRollover } from './api';

export type RolloverPhase = 'idle' | 'confirming' | 'rolling' | 'error';

/**
 * useKeeperRollover.ts — the "Roll over" control's whole life cycle, for the
 * one session that ever shows it: the pinned Keeper session. Tapping it runs
 * the nightly rollover on demand (POST kicks it off; /endsession writing the
 * diary takes minutes, so completion is polled rather than awaited on the
 * connection). Mirrors useReattach.ts's shape (a phase + a poll loop) more
 * than it shares code with it — this tracks a detached background job, not a
 * live stream.
 */
export function useKeeperRollover(args: {
  botId: string;
  pinned: boolean;
  /** Docked mode (the desktop split pane): swap the pane's conversation
   * instead of routing the whole app to it — see ObservatoryPage's prop of
   * the same name. */
  onOpenConversation?: (convId: string) => void;
}): {
  phase: RolloverPhase;
  errorMsg: string | null;
  requestConfirm: () => void;
  cancelConfirm: () => void;
  confirm: () => Promise<void>;
} {
  const { botId, pinned, onOpenConversation } = args;
  const navigate = useNavigate();
  const [phase, setPhase] = useState<RolloverPhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Resume-on-reopen (07-24 ask): if she closed and reopened the PWA mid-roll,
  // one status fetch picks the "Rolling over…" state back up. Only pinned
  // sessions ever show this control, so this only ever fires for the Keeper
  // session — `pinned` starts false (meta hasn't loaded yet) and flips true
  // once ObservatoryPage's history load resolves it, which is effectively
  // "on mount" for the one session that matters.
  useEffect(() => {
    if (!pinned) return;
    let cancelled = false;
    getKeeperRolloverStatus()
      .then((s) => {
        if (cancelled || !mountedRef.current) return;
        if (s.running) setPhase('rolling');
      })
      .catch(() => {
        // transient — she can still tap the button herself
      });
    return () => {
      cancelled = true;
    };
  }, [pinned]);

  // The poll loop: every 3s while a run's in flight, until `running` clears.
  useEffect(() => {
    if (phase !== 'rolling') return;
    let cancelled = false;
    const id = setInterval(() => {
      void (async () => {
        let status;
        try {
          status = await getKeeperRolloverStatus();
        } catch {
          return; // transient — try again next tick
        }
        if (cancelled || !mountedRef.current) return;
        if (status.running) return; // still writing the diary

        // Done — refresh the roster's data (even though this page doesn't
        // render it, the next roster visit shouldn't show stale state) and
        // route based on how the run landed.
        void getSessions().catch(() => {});
        const outcome = status.registry?.last_status;
        if (outcome === 'ok' && status.pinned_conv_id) {
          setPhase('idle');
          if (onOpenConversation) onOpenConversation(status.pinned_conv_id);
          else
            void navigate({
              to: '/observatory/$botId',
              params: { botId },
              search: { conv: status.pinned_conv_id },
            });
        } else {
          setErrorMsg('Rollover failed — check keeper_rollover.log');
          setPhase('error');
        }
      })();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, navigate, botId, onOpenConversation]);

  const requestConfirm = useCallback(() => {
    setErrorMsg(null);
    setPhase('confirming');
  }, []);

  const cancelConfirm = useCallback(() => {
    setPhase('idle');
  }, []);

  const confirm = useCallback(async () => {
    setErrorMsg(null);
    try {
      await startKeeperRollover();
      setPhase('rolling');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // One's already running (the nightly cron, or another tab) — that's
        // not a failure, just a reason to start tracking it instead.
        setPhase('rolling');
        return;
      }
      setErrorMsg(e instanceof Error ? e.message : 'Could not start the rollover.');
      setPhase('error');
    }
  }, []);

  return { phase, errorMsg, requestConfirm, cancelConfirm, confirm };
}
