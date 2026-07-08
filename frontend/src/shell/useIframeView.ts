import { useEffect } from 'react';
import { activateFrame, deactivateFrames } from './frameStore';

/**
 * Mounts (lazily, once) and activates the iframe view identified by `key`,
 * for routes that render legacy Flask content full-bleed (see FrameHost).
 */
export function useActivateFrame(key: string, src: string, title: string): void {
  useEffect(() => {
    activateFrame({ key, src, title });
  }, [key, src, title]);
}

/** For native (non-iframe) routes — hides whatever legacy frame was showing. */
export function useDeactivateFrames(): void {
  useEffect(() => {
    deactivateFrames();
  }, []);
}
