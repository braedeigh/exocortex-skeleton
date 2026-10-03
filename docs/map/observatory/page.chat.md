---
id: page.chat
name: Session chat
kind: feature
parent: page
sources:
  - frontend/src/features/observatory/SessionDialog.tsx
  - frontend/src/features/observatory/events.ts
  - frontend/src/features/observatory/streamPacing.ts
  - frontend/src/features/observatory/useReattach.ts
  - frontend/src/features/observatory/replyViews.tsx
  - frontend/src/features/observatory/useComposerBox.ts
  - frontend/src/features/observatory/useMessageQueue.ts
  - frontend/src/features/observatory/queuedMessages.ts
  - frontend/src/features/observatory/QueuedRows.tsx
  - frontend/src/features/observatory/PeerCard.tsx
  - frontend/src/features/observatory/PeerCard.module.css
  - frontend/src/features/observatory/ChatApprovalCard.tsx
  - frontend/src/features/observatory/CommandDecision.tsx
  - frontend/src/features/observatory/useCommandDecision.ts
  - frontend/src/features/observatory/resumeAfterDecision.ts
  - frontend/src/features/observatory/SpinoffOffer.tsx
  - frontend/src/features/observatory/SpinoffOffer.module.css
  - frontend/src/features/observatory/photoAttach.tsx
  - frontend/src/features/observatory/JournalHighlight.tsx
  - frontend/src/features/observatory/useJournalHighlight.ts
  - frontend/src/features/observatory/highlightMarks.ts
  - frontend/src/features/observatory/useKeeperRollover.ts
  - frontend/src/features/observatory/useScrollContract.ts
  - frontend/src/features/observatory/useStepBack.ts
  - frontend/src/features/observatory/useWordFlow.ts
  - frontend/src/features/observatory/useFloatRoom.ts
  - frontend/src/features/observatory/usePlaceInView.ts
  - frontend/src/features/observatory/sessionMountKey.ts
links:
  - depends-on page.api: The chat sends, stops and approves through the shared API calls.
  - calls engine.turns: The send box starts a turn, and the Stop button ends one.
  - calls engine.reading: The chat follows a turn as a stream of server events.
  - calls engine.delivery: Messages typed during a turn go into the session's mailbox.
  - calls engine.gates: The approval card approves or denies a held command.
  - calls spinoffs.door: The Go button on a spinoff offer starts the new sessions.
  - depends-on page.roster: The chat reads session state and read marks from the roster's helpers.
fingerprint: 7d638c97729a
written: 2026-10-02
---

The chat is the view of one session. It reads the session's transcript and then follows the live turn as a stream of events. The reply appears word by word.

The chat draws each kind of line in its own way: the owner's words, the agent's replies, tool calls, System messages, and messages from other agents. It also shows the cards that wait for the owner: an approval, open questions, and a spinoff offer. A message typed during a turn waits in a queue row until the agent reads it.
