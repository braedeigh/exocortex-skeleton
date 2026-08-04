/**
 * sessionLocation.ts — the ONE place that knows how to spell a session's URL.
 *
 * The room route still carries a `$botId` segment (a leftover from the
 * bot-per-persona era, kept so old bookmarks don't 404 — see
 * routes/observatory_.$botId.tsx). Nothing reads its value, so every caller
 * fills it with the same fixed placeholder and the conversation id travels in
 * `?conv=`. Before this helper each entry point spelled that shape by hand and
 * they disagreed — one put the conversation id in the dead segment and opened
 * a blank compose instead of the session.
 */

/** Navigation options for opening one conversation in the Observatory —
 * hand straight to TanStack's navigate(). */
export function sessionLocation(convId: string) {
  return {
    to: '/observatory/$botId',
    params: { botId: 'session' },
    search: { conv: convId },
  } as const;
}
