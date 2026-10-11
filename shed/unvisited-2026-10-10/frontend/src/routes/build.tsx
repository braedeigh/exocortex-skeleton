import { createFileRoute } from '@tanstack/react-router';
import { BuildPage } from '../features/build/BuildPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// /build — the build queue as one card per item (routes/buildtodo.py), with
// the pre-split dev_todo.md rendered read-only underneath.
export const Route = createFileRoute('/build')({
  component: BuildRoute,
});

function BuildRoute() {
  useDeactivateFrames();
  return <BuildPage />;
}
