import { useActivateFrame } from './useIframeView';

interface IframeRouteProps {
  frameKey: string;
  src: string;
  title: string;
}

/** Shared body for the /journal, /research, /settings, /files routes — each just picks a key/src/title. */
export function IframeRoute({ frameKey, src, title }: IframeRouteProps) {
  useActivateFrame(frameKey, src, title);
  return null;
}
