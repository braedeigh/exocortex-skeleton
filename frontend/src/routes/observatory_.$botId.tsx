import { useEffect } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { ObservatoryPage } from '../features/observatory/ObservatoryPage';
import { getSessions } from '../features/observatory/api';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * An observatory conversation (bot-surface-design §5A). `?conv=<id>` opens an
 * existing conversation; without it the page starts a fresh one (and swaps
 * the id into the URL after the first send). `?conv=latest` resolves to the
 * pinned Keeper session — or, failing that, whatever sorted first — or a
 * fresh one if there are none at all. The `$botId` URL segment is a routing
 * leftover from the bot-per-persona era (07-24 dissolved it server-side into
 * session-carried config): nothing downstream reads its value, every live
 * caller fills it with the fixed placeholder 'session', and it's kept only
 * so old bookmarks and cached PWA clients keep routing here without a crash.
 * `?from=<id>` rides along when a spinoff's Go button brought her here; the
 * page then asks whether to close that chat (SpinoffOffer.tsx).
 * The `observatory_.` filename un-nests from /observatory, same trick as
 * threads_.$slug.tsx.
 */
export const Route = createFileRoute('/observatory_/$botId')({
  validateSearch: (search: Record<string, unknown>): { conv?: string; from?: string } => ({
    ...(typeof search.conv === 'string' && search.conv ? { conv: search.conv } : {}),
    ...(typeof search.from === 'string' && search.from ? { from: search.from } : {}),
  }),
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ObservatoryChatRoute,
});

function ObservatoryChatRoute() {
  useDeactivateFrames();
  const { botId } = Route.useParams();
  const { conv, from } = Route.useSearch();
  if (conv === 'latest') return <LatestConvResolver botId={botId} />;
  // Remount on bot OR conversation change so turn state never bleeds across.
  return <ObservatoryPage key={`${botId}:${conv ?? 'new'}`} botId={botId} convId={conv} cameFrom={from} />;
}

/** Swap ?conv=latest for a real conversation id — the pinned Keeper session
 * if there is one (sessions sort pinned-first), else whatever's newest, else
 * none = fresh — replace:true so back never lands on the sentinel. */
function LatestConvResolver({ botId }: { botId: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    const go = (conv?: string) => {
      if (cancelled) return;
      void navigate({
        to: '/observatory/$botId',
        params: { botId },
        search: conv ? { conv } : {},
        replace: true,
      });
    };
    getSessions()
      .then(({ sessions }) => go(sessions.find((s) => s.pinned)?.id ?? sessions[0]?.id))
      .catch(() => go());
    return () => {
      cancelled = true;
    };
  }, [botId, navigate]);
  return null;
}
