import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /bots/$botId is retired in favor of /observatory/$botId (renamed 07-24 —
 * the persona concept keeps the name "bot"; only this surface's URL
 * changed). This file stays only as a redirect for old bookmarks and cached
 * PWA clients, preserving the `?conv` search param. The `bots_.` filename
 * un-nests from /bots, same trick as threads_.$slug.tsx.
 */
export const Route = createFileRoute('/bots_/$botId')({
  validateSearch: (search: Record<string, unknown>): { conv?: string } =>
    typeof search.conv === 'string' && search.conv ? { conv: search.conv } : {},
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/observatory/$botId',
      params: { botId: params.botId },
      search: search.conv ? { conv: search.conv } : {},
    });
  },
});
