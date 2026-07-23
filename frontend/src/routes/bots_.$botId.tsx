import { createFileRoute, redirect } from '@tanstack/react-router';
import { BotChatPage } from '../features/bots/BotChatPage';
import { useDeactivateFrames } from '../shell/useIframeView';

/**
 * One bot's reading-room chat (bot-surface-design §5A). `?conv=<id>` opens an
 * existing conversation; without it the page starts a fresh one (and swaps
 * the id into the URL after the first send). The `bots_.` filename un-nests
 * from /bots, same trick as threads_.$slug.tsx.
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
  // Remount on bot OR conversation change so turn state never bleeds across.
  return <BotChatPage key={`${botId}:${conv ?? 'new'}`} botId={botId} convId={conv} />;
}
