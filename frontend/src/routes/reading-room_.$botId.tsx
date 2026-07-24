import { useEffect } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { ReadingRoomPage } from '../features/readingRoom/ReadingRoomPage';
import { getSessions } from '../features/readingRoom/api';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * A reading-room conversation (bot-surface-design §5A). `?conv=<id>` opens an
 * existing conversation; without it the page starts a fresh one (and swaps
 * the id into the URL after the first send). `?conv=latest` (the Chat tab's
 * link when Settings points it here) resolves to the pinned Keeper session —
 * or, failing that, whatever sorted first — or a fresh one if there are none
 * at all. The `$botId` URL segment is a routing leftover from the bot-per-
 * persona era (07-24 dissolved it server-side into session-carried config);
 * it's kept only so old bookmarks and the still-hardcoded Chat-tab link
 * (shell/TopTabs.tsx navigates to `/reading-room/keeper`) keep routing here
 * without a crash — nothing downstream reads its value. The `reading-room_.`
 * filename un-nests from /reading-room, same trick as threads_.$slug.tsx.
 */
export const Route = createFileRoute('/reading-room_/$botId')({
  validateSearch: (search: Record<string, unknown>): { conv?: string } =>
    typeof search.conv === 'string' && search.conv ? { conv: search.conv } : {},
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: ReadingRoomChatRoute,
});

function ReadingRoomChatRoute() {
  useDeactivateFrames();
  const { botId } = Route.useParams();
  const { conv } = Route.useSearch();
  if (conv === 'latest') return <LatestConvResolver botId={botId} />;
  // Remount on bot OR conversation change so turn state never bleeds across.
  return <ReadingRoomPage key={`${botId}:${conv ?? 'new'}`} botId={botId} convId={conv} />;
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
        to: '/reading-room/$botId',
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
