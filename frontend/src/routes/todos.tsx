import { createFileRoute } from '@tanstack/react-router';
import { TodosPage } from '../features/todos/TodosPage';
import { useDeactivateFrames } from '../shell/useIframeView';

export const Route = createFileRoute('/todos')({
  // ?streak=<slug> — the journal's counter-chip deep link; TodosPage consumes
  // it (opens that counter's sheet) and immediately clears it.
  // ?front=<id> — the Fronts overview's deep link; TodosPage adopts it as the
  // active focus chip (which persists it) and clears the param the same way.
  validateSearch: (search: Record<string, unknown>): { streak?: string; front?: string } => {
    const streak = typeof search.streak === 'string' && search.streak ? search.streak : undefined;
    const front = typeof search.front === 'string' && search.front ? search.front : undefined;
    return { ...(streak ? { streak } : {}), ...(front ? { front } : {}) };
  },
  component: TodosRoute,
});

function TodosRoute() {
  useDeactivateFrames();
  return <TodosPage />;
}
