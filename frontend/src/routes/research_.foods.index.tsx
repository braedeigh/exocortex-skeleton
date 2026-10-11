import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /research/foods — MOVED to /food/foods, inside the Food area. Kept as a
 * redirect so old links and bookmarks still land on the list of foods.
 */
export const Route = createFileRoute('/research_/foods/')({
  beforeLoad: () => {
    throw redirect({ to: '/food/foods', replace: true });
  },
});
