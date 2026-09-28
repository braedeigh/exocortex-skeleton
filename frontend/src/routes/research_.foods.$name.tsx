import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /research/foods/<name> — MOVED to /food/foods/<name>, inside the Food area.
 * Kept as a redirect because the grocery list's popup and older links still
 * point here.
 */
export const Route = createFileRoute('/research_/foods/$name')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/food/foods/$name', params: { name: params.name }, replace: true });
  },
});
