import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '../features/settings/SettingsPage';
import { useDeactivateFrames } from '../shell/useIframeView';

// Native Settings page (theme editor, dev notes, account) — replaces the
// /settings-view iframe of templates/settings.html.
export const Route = createFileRoute('/settings')({
  component: SettingsRoute,
});

function SettingsRoute() {
  useDeactivateFrames();
  return <SettingsPage />;
}
