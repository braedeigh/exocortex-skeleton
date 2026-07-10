import { useEffect } from 'react';
import { deactivateFrames } from './frameStore';

/**
 * Historical note: routes used to activate legacy Flask iframes here (the
 * strangler-fig bridge, removed 2026-07-09 once every page went native).
 * useDeactivateFrames stays as the mount hook every route calls — today it
 * just clears any lingering frame-store state.
 */
export function useDeactivateFrames(): void {
  useEffect(() => {
    deactivateFrames();
  }, []);
}
