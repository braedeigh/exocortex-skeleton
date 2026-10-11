import { createFileRoute, redirect } from '@tanstack/react-router';
import { ReviewPage } from '../features/ecosystem/ReviewPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * /food/review — the machine's suggested sources waiting for her, grouped by
 * food (features/ecosystem/ReviewPage.tsx). ?food=<id> narrows it to one
 * food. Auth-only: the suggestions are never shown publicly.
 */
export const Route = createFileRoute('/food_/review')({
  validateSearch: (search: Record<string, unknown>): { food?: number } => {
    const food = Number(search.food);
    return search.food != null && search.food !== '' && Number.isInteger(food) ? { food } : {};
  },
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ReviewRoute,
});

function ReviewRoute() {
  useDeactivateFrames();
  const { food } = Route.useSearch();
  return <ReviewPage foodId={food ?? null} />;
}
