/**
 * useCommandDecision — her Approve / Deny on a command the act-vs-ask gate
 * stopped, shared by every card that shows one: the session card in the room
 * view (SessionCard.tsx ApprovalCard) and the same card inside the chat that's
 * asking (ChatApprovalCard.tsx). One copy of the logic, so the two can't drift.
 *
 * What a tap does: tells the server (approve/deny), and the SERVER sends the
 * retry cue that wakes the session — right away if it's idle, the moment its
 * current reply ends if not (routes/observatory.py, "Follow-ups"). This hook
 * used to do that waiting itself in the browser, retrying for 30 seconds; a
 * session that kept working longer, or a phone that locked, lost the approval.
 * Against an older server that doesn't answer with `resume`, it still falls
 * back to sending the cue itself, the old way.
 *
 * Touches: api.ts (approveConversation / denyConversation / streamSend),
 * resumeAfterDecision.ts (the fallback only).
 *
 * Prompt: "I also need some kind of fix to things like this dropping ...
 * Otherwise just fix it." / "I mean the approve card only" — show it in the
 * chat that's making the request.
 */
import { useState } from 'react';
import { approveConversation, denyConversation, streamSend, type DecisionResult } from './api';
import { resumeAfterDecision } from './resumeAfterDecision';

const APPROVE_CUE = 'Approved — go ahead and retry that exact command now.';
const DENY_CUE =
  "I've denied that command — don't run it. Find another way, or stop and tell me why.";

export function useCommandDecision(convId: string, onChanged?: () => void) {
  const [sticky, setSticky] = useState(false);
  const [deciding, setDeciding] = useState(false);
  // Set when a decision didn't land, so the card says so instead of looking
  // like the tap did nothing. Cleared when she taps again.
  const [decideErr, setDecideErr] = useState('');
  // Set when the server is holding the retry until the current reply ends —
  // shown on the card so a wait doesn't read as a drop.
  const [queued, setQueued] = useState(false);

  // Old-server fallback: send the cue from here, waiting out a busy turn.
  const resumeFromPage = async (
    text: string,
    decision: { kind: 'approve' | 'deny'; command: string },
  ) => {
    await resumeAfterDecision(() =>
      streamSend(convId, text, { record: false, decision }, () => {}),
    );
  };

  const decide = (
    call: () => Promise<DecisionResult>,
    kind: 'approve' | 'deny',
    cue: string,
  ) => {
    setDeciding(true);
    setDecideErr('');
    call()
      .then(async (res) => {
        if (res.resume) {
          setQueued(res.resume === 'queued');
        } else {
          await resumeFromPage(cue, { kind, command: res.command });
        }
      })
      .catch((err: unknown) => {
        setDecideErr(err instanceof Error ? err.message : 'could not record that decision');
        setDeciding(false);
      })
      .finally(() => onChanged?.());
  };

  return {
    sticky,
    setSticky,
    deciding,
    decideErr,
    queued,
    approve: () => decide(() => approveConversation(convId, sticky), 'approve', APPROVE_CUE),
    deny: () => decide(() => denyConversation(convId), 'deny', DENY_CUE),
  };
}
