/**
 * threadTalk.ts — the one shared "talk about this thread" action, used by
 * both the journal's ThreadPopover and the /threads page. Types
 * `/thread <id>` into the Keeper's tmux session; the vault-side slash
 * command (claude-commands/thread.md) has the session read the thread file
 * plus every source it links, then open a conversation. Slash commands are
 * exempt from journal capture (routes/terminal.py), so this boilerplate is
 * never minted as her words.
 */
import { api } from '../../api/client';

/** Where the send lands — the Keeper's session. */
export const TALK_SESSION = 'chat';

export function sendThreadToChat(id: string): Promise<{ ok: true }> {
  return api.post('/api/terminal/send', { text: `/thread ${id}`, enter: true, session: TALK_SESSION });
}

export type TalkState = 'idle' | 'sending' | 'sent' | 'error';

/** The button label for each state — kept here so the two surfaces match. */
export function talkLabel(state: TalkState): string {
  switch (state) {
    case 'sending':
      return 'Sending…';
    case 'sent':
      return 'Sent to chat ✓';
    case 'error':
      return 'Couldn’t reach the terminal — tap to retry';
    default:
      return '💬 Talk about this thread';
  }
}
