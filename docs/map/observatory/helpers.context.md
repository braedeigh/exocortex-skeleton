---
id: helpers.context
name: Standing rules and context page
kind: feature
parent: helpers
sources:
  - scripts/helper_rule.py
  - frontend/src/features/observatory/HelperContextPage.tsx
  - frontend/src/features/observatory/HelperContextPage.module.css
links:
  - calls helpers.chat: The rule script adds, lists and drops rules through the helper chat module.
  - calls swarms.routes: The context page reads the seed and saves the rules through the swarm routes.
  - depends-on swarms.views: The context page uses the swarm API calls.
  - depends-on swarms.grouping: The rule script checks that the session is a helper.
  - depends-on page.api: The page links to sessions with the shared link helper.
fingerprint: fa9c3b4da694
written: 2026-10-04
---

The owner's standing rules are the one part of a helper's context that lasts. Each rule is a line in a small markdown file, in the owner's words with a date. A helper adds a rule with the helper_rule.py script only when the owner says something meant to last.

The context page shows a helper's last seed, part by part. It can also build the seed as it would be now. The owner can add a rule there, and edit or delete each rule. The owner can also edit the whole rules file. A save is refused when the file changed since the page loaded it.
