import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /atlas — GONE, redirected to /observatory/archive.
 *
 * The atlas was a shelf map of every session filed under a life front and a
 * domain. It was correct and she never opened it, because it was a page you
 * had to remember to go to — her words, 08-03: "i never use atlas so i'm
 * imagining we port it over into the observatory." So the archive moved into
 * the room she already stands in, one tap off the bottom of every session,
 * and gained the search it never had.
 *
 * The route stays as a redirect rather than being deleted: it's bookmarked,
 * it's in cached service workers, and a 404 would just look broken. The
 * front/domain labels survived the move as chips on each row; only the
 * hierarchy — the part that actually failed — was dropped.
 */
export const Route = createFileRoute('/atlas')({
  beforeLoad: () => {
    throw redirect({ to: '/observatory/archive' });
  },
});
