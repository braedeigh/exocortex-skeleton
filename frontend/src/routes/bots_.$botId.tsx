import { useEffect } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { BotChatPage } from '../features/bots/BotChatPage';
import { getBots } from '../features/bots/botsApi';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * One bot's reading-room chat (bot-surface-design §5A). `?conv=<id>` opens an
 * existing conversation; without it the page starts a fresh one (and swaps
 * the id into the URL after the first send). `?conv=latest` (the Chat tab's
 * link when Settings points it here) resolves to the bot's most recent
 * conversation — or a fresh one if there's none. The `bots_.` filename
 * un-nests from /bots, same trick as threads_.$slug.tsx.
 */
export const Route = createFileRoute('/bots_/$botId')({
  validateSearch: (search: Record<string, unknown>): { conv?: string } =>
    typeof search.conv === 'string' && search.conv ? { conv: search.conv } : {},
  beforeLoad: () => {
    if (typeof window === 'undefined') return;
    if (window.VIEW_MODE === 'public') throw redirect({ to: '/' });
  },
  component: BotChatRoute,
});

function BotChatRoute() {
  useDeactivateFrames();
  const { botId } = Route.useParams();
  const { conv } = Route.useSearch();
  if (conv === 'latest') return <LatestConvResolver botId={botId} />;
  // Remount on bot OR conversation change so turn state never bleeds across.
  return <BotChatPage key={`${botId}:${conv ?? 'new'}`} botId={botId} convId={conv} />;
}

/** Swap ?conv=latest for the real newest conversation id (or none = fresh),
 * replace:true so back never lands on the sentinel. */
function LatestConvResolver({ botId }: { botId: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    const go = (conv?: string) => {
      if (cancelled) return;
      void navigate({
        to: '/bots/$botId',
        params: { botId },
        search: conv ? { conv } : {},
        replace: true,
      });
    };
    getBots()
      .then(({ bots }) => go(bots.find((b) => b.id === botId)?.conversations[0]?.id))
      .catch(() => go());
    return () => {
      cancelled = true;
    };
  }, [botId, navigate]);
  return null;
}
