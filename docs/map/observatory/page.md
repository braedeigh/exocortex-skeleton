---
id: page
name: The Observatory page
kind: module
order: 1
fingerprint: 
written: 2026-10-02
---

The page is the React screen at /observatory. On a phone it shows every session as a card in its room, and a tap on a card opens the session's chat. The room helper's band is the first thing on the page at every width (RoomHelperBand.tsx).

On a desktop the page fills the window and draws as a map (RosterMap.tsx, with mapPlaces.ts deciding where each session stands). Each swarm is a circle, each session working alone a ring, each project room a box, and a side column holds the cards that want her: questions, plans, failures, replies to read, then the Done drawers and Saved for later. Filters narrow both, including "Needs you" and "Planning", which only the map has. Below about 1100px of panel width the side column becomes a one-line strip that opens the list; below about 600px it's the phone's column. The Journal's list, the desktop app and the docked pane keep the column.

A tap on a session on desktop opens it in a pane on the right, or in the session pane already there (shell/panels/conversationRouting.ts). The other panels stay mounted and hidden while the page fills the window, and the saved arrangement doesn't change (layoutTree.ts fullScreenPlan). A panel comes forward when a session lands in it or she splits one off, and goes when she closes it. A button in the page's panel header turns this off and on for the window. The sudo, approval and file popups stand at window level, outside every panel.

The page gets all its data from the session engine over HTTP. Pages for swarms, helpers, Linear, the night crew and worktrees open from doors on the page. Those pages sit in their own boxes.

On a desktop the page sits in a panel, and each panel has a row of tabs across its top. The row holds the pinned rooms at the left, then what she opened, in the order she put them. Opening something gives it a tab, and the tab stays until she closes it with its ×. Closing a tab closes the view only: the session keeps running and stays on the roster. A session she hasn't opened gets no tab, however busy it is. An open session's tab shows its state: purple while it runs, amber while it waits on her. Tabs drag to rearrange, within a row or onto another panel's row, by mouse or by press-and-hold on a touch screen. Any panel can be closed until one is left. The panel code is in frontend/src/shell/panels (TabBar.tsx, tabDrag.ts, layoutTree.ts).
