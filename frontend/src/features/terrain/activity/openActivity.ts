import { dispatchIntent } from '../../../shell/panels/windowBus';

/**
 * openActivity.ts — open a session's Activity pane from anywhere.
 *
 * On a wide screen the workspace catches the request and opens the pane
 * beside the session (shell/panels/activityRouting.ts decides where). On a
 * phone there is no workspace, nothing catches it, and the page is simply
 * navigated to — its "← Session" button walks back.
 *
 * Touches: windowBus.ts (the 'activity' intent), Workspace.tsx (the catcher),
 * features/observatory/ObservatoryPage.tsx (the toolbar button that calls it).
 */
export function openActivity(convId: string, navigateToPage: () => void): void {
  if (dispatchIntent({ kind: 'activity', convId }) === 'none') navigateToPage();
}
