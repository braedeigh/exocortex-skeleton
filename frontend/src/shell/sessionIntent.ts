import { dispatchIntent } from './panels/windowBus';

/**
 * sessionIntent.ts — "put this tmux session on a terminal somewhere".
 *
 * Research's "follow live", and "talk to this thread" from the threads pages
 * and the journal's thread popover, all spawn a session and then want it
 * SHOWN. That used to be a bare window event: fired into the page, caught by
 * the one docked terminal if it happened to exist, and silently lost if it
 * didn't — including on every phone.
 *
 * Now it goes through the window bus, which means two things it couldn't do
 * before: it can land on a terminal in another browser window (the monitor you
 * keep the terminal on), and it comes back with an answer, so a caller can
 * tell whether anything caught it.
 *
 * Showing the session also REVEALS the terminal wherever it lands — a session
 * running behind a hidden surface is running invisibly, and the only way to
 * find it would be to guess which tab had something new in it.
 *
 * Touches: panels/windowBus.ts (routing), panels/PaneStack.tsx (the target),
 * ThreadsPage / ThreadJournalPage / ThreadPopover / SessionsCard (senders).
 */

/** Show `name` on a terminal. False = no terminal is open anywhere, so the
 * caller can tell the user rather than appearing to do nothing. */
export function openSessionInTerminal(name: string): boolean {
  if (!name) return false;
  return dispatchIntent({ kind: 'session', name }) !== 'none';
}
