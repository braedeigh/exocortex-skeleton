import { createFileRoute } from '@tanstack/react-router';
import { JournalPage } from '../features/journal/JournalPage';
import { useDeactivateFrames } from '../shell/useIframeView';

export interface JournalSearch {
  date?: string;
  /** Search mode: the words being searched for. When set, the journal pane
   * shows matching entries instead of the day (features/journal/SearchResults). */
  q?: string;
  /** Search filters: who said it (B = the owner, K = the Keeper) and an
   * inclusive day range. */
  who?: 'B' | 'K';
  from?: string;
  to?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const Route = createFileRoute('/journal')({
  component: JournalRoute,
  validateSearch: (search: Record<string, unknown>): JournalSearch => ({
    date: typeof search.date === 'string' && DATE_RE.test(search.date) ? search.date : undefined,
    q: typeof search.q === 'string' && search.q.trim() ? search.q : undefined,
    who: search.who === 'B' || search.who === 'K' ? search.who : undefined,
    from: typeof search.from === 'string' && DATE_RE.test(search.from) ? search.from : undefined,
    to: typeof search.to === 'string' && DATE_RE.test(search.to) ? search.to : undefined,
  }),
});

function JournalRoute() {
  useDeactivateFrames();
  return <JournalPage />;
}
