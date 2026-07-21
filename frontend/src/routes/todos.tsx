import { createFileRoute } from '@tanstack/react-router';
import { TodosPage } from '../features/todos/TodosPage';
import { useDeactivateFrames } from '../shell/useIframeView';

export const Route = createFileRoute('/todos')({
  // ?streak=<slug> — the journal's counter-chip deep link; TodosPage consumes
  // it (opens that counter's sheet) and immediately clears it.
  validateSearch: (search: Record<string, unknown>): { streak?: string } => {
    const streak = typeof search.streak === 'string' && search.streak ? search.streak : undefined;
    return streak ? { streak } : {};
  },
  component: TodosRoute,
});

function TodosRoute() {
  useDeactivateFrames();
  return <TodosPage />;
}
