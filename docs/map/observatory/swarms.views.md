---
id: swarms.views
name: Swarm cards and pages
kind: feature
parent: swarms
sources:
  - frontend/src/features/observatory/SwarmCard.tsx
  - frontend/src/features/observatory/SwarmCard.module.css
  - frontend/src/features/observatory/SwarmPage.tsx
  - frontend/src/features/observatory/SwarmPage.module.css
  - frontend/src/features/observatory/SwarmNetwork.tsx
  - frontend/src/features/observatory/SwarmNetwork.module.css
  - frontend/src/features/observatory/SwarmStack.tsx
  - frontend/src/features/observatory/SwarmStack.module.css
  - frontend/src/features/observatory/SwarmClosingFold.tsx
  - frontend/src/features/observatory/SwarmClosingFold.module.css
  - frontend/src/features/observatory/messageArrows.ts
  - frontend/src/features/observatory/RoomMap.tsx
  - frontend/src/features/observatory/RoomMap.module.css
  - frontend/src/features/observatory/swarmApi.ts
  - frontend/src/features/observatory/swarmNetworkMath.ts
links:
  - calls swarms.routes: The cards and pages read the swarm routes.
  - depends-on page.api: The swarm calls use the shared API client.
  - depends-on page.roster: A swarm's page lists its members with the roster's session lane and order.
  - composes page.chat: A swarm's page starts a new member session in the session dialog.
fingerprint: 591e26e75491
written: 2026-10-04
---

A swarm shows as a card in its room, with its summary and its members' states. A tap opens the swarm's page. The page draws the members as a network of rings and message lines, and lists what the swarm did. An arrowhead on a line shows which way the messages went, with a count for each direction. A tap on a line opens the messages behind it. Pointing at a member highlights it and its lines.

The room map sits at the head of a room that has a room helper. It shows the helper, each swarm as a stack, and the sessions that work alone. A stack holds the swarm's drawing in a circle, its open questions and its members, and it folds shut from a chevron. When a swarm closes, the room's chat shows one line that opens into the whole closing summary.
