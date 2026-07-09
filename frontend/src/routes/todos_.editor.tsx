import { createFileRoute } from '@tanstack/react-router';
import { TodoEditorPage } from '../features/todos/TodoEditorPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Full-page to-do manager (search / filter / bulk actions). The `todos_.`
// filename un-nests it from /todos — todos.tsx renders no <Outlet/>, so a
// nested child would never appear.
export const Route = createFileRoute('/todos_/editor')({
  component: TodoEditorRoute,
});

function TodoEditorRoute() {
  useDeactivateFrames();
  return <TodoEditorPage />;
}
