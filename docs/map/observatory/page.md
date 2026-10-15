---
id: page
name: The Observatory page
kind: module
order: 1
fingerprint: 
written: 2026-10-02
---

The page is the React screen at /observatory. It shows every session as a card in its room. A tap on a card opens the session's chat.

The page gets all its data from the session engine over HTTP. Pages for swarms, helpers, Linear, the night crew and worktrees open from doors on the page. Those pages sit in their own boxes.

On a desktop the page sits in a panel, and each panel has a row of tabs across its top. The row holds the pinned rooms at the left, then what she opened, in the order she put them. Opening something gives it a tab, and the tab stays until she closes it with its ×. Closing a tab closes the view only: the session keeps running and stays on the roster. A session she hasn't opened gets no tab, however busy it is. An open session's tab shows its state: purple while it runs, amber while it waits on her. Tabs drag to rearrange, within a row or onto another panel's row, by mouse or by press-and-hold on a touch screen. Any panel can be closed until one is left. The panel code is in frontend/src/shell/panels (TabBar.tsx, tabDrag.ts, layoutTree.ts).
