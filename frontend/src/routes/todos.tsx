import { createFileRoute } from '@tanstack/react-router';
import { TodosPage } from '../features/todos/TodosPage';
import { useDeactivateFrames } from '../shell/useIframeView';

export const Route = createFileRoute('/todos')({
  component: TodosRoute,
});

function TodosRoute() {
  useDeactivateFrames();
  return <TodosPage />;
}
