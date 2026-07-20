/**
 * threadTalk.ts — the one shared "talk about this thread" action, used by
 * both the journal's ThreadPopover and the /threads page. POST
 * /api/thread/talk spawns a FRESH tmux session running
 * `claude "/thread <slug>"` in the vault (routes/threads.py) — not the
 * Keeper's chat session (her call, 2026-07-14: keep that conversation
 * clean). The vault-side slash command (claude-commands/thread.md) has the
 * new session read the thread file plus every source it links, then open a
 * conversation. The response carries the session name so callers can switch
 * the terminal there.
 */
import { api } from '../../api/client';

export interface ThreadTalkResult {
  ok: true;
  /** The tmux session that was spawned (thread-<slug>, -2/-3 if taken). */
  session: string;
  thread: string;
}

export function startThreadTalk(id: string): Promise<ThreadTalkResult> {
  return api.post('/api/thread/talk', { name: id });
}

export type TalkState = 'idle' | 'sending' | 'sent' | 'error';

/** The button label for each state — kept here so the two surfaces match. */
export function talkLabel(state: TalkState): string {
  switch (state) {
    case 'sending':
      return 'Starting…';
    case 'sent':
      return 'Session started ✓ — talking in the terminal';
    case 'error':
      return 'Couldn’t start the session — tap to retry';
    default:
      return '💬 Talk about this thread';
  }
}
