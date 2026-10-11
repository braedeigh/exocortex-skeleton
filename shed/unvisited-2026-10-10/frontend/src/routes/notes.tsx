import { createFileRoute } from '@tanstack/react-router';
import { NotesBrowserPage } from '../features/notes/NotesBrowserPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// All dev notes + ideas across every tab, in one scrollable page — the
// review surface for what NotesPill (mounted on /todos) captures.
export const Route = createFileRoute('/notes')({
  component: NotesRoute,
});

function NotesRoute() {
  useDeactivateFrames();
  return <NotesBrowserPage />;
}
