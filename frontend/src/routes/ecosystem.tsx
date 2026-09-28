import { createFileRoute, redirect } from '@tanstack/react-router';
import { validateFoodMapSearch } from './food';

/**
 * /ecosystem — MOVED to /food, the Food area's map. Kept as a redirect so
 * bookmarks, the Kitchen's older links and cached PWA clients still land on
 * the map; ?recipe= / ?source= / ?food= carry across.
 */
export const Route = createFileRoute('/ecosystem')({
  validateSearch: validateFoodMapSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/food', search, replace: true });
  },
});
