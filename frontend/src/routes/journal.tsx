import { createFileRoute } from '@tanstack/react-router';
import { JournalPage } from '../features/journal/JournalPage';
import { useDeactivateFrames } from '../shell/useIframeView';

export interface JournalSearch {
  date?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const Route = createFileRoute('/journal')({
  component: JournalRoute,
  validateSearch: (search: Record<string, unknown>): JournalSearch => ({
    date: typeof search.date === 'string' && DATE_RE.test(search.date) ? search.date : undefined,
  }),
});

function JournalRoute() {
  useDeactivateFrames();
  return <JournalPage />;
}
