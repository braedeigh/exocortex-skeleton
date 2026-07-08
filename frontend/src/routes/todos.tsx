import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getData } from '../api/endpoints';
import { useDeactivateFrames } from '../shell/useIframeView';

export const Route = createFileRoute('/todos')({
  component: TodosPage,
});

/**
 * Placeholder native page — proof of data flow (fetch -> TanStack Query ->
 * render). Real todos UI comes later; for now just show the raw payload.
 */
function TodosPage() {
  useDeactivateFrames();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['data', 'today'],
    queryFn: ({ signal }) => getData('today', signal),
  });

  return (
    <div style={{ padding: 'var(--space-4)', overflow: 'auto', flex: 1 }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)' }}>Todos</h1>
      {isLoading ? <p>Loading&hellip;</p> : null}
      {isError ? (
        <p style={{ color: 'var(--red)' }}>
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      ) : null}
      {data !== undefined ? (
        <pre
          style={{
            background: 'var(--card-bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-4)',
            fontSize: 'var(--font-size-sm)',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
