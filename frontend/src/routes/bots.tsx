import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /bots is retired in favor of /reading-room (renamed 07-24 — the persona
 * concept keeps the name "bot"; only this surface's URL changed). This file
 * stays only as a redirect for old bookmarks and cached PWA clients.
 */
export const Route = createFileRoute('/bots')({
  beforeLoad: () => {
    throw redirect({ to: '/reading-room' });
  },
});
