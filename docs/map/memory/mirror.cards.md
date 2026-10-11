---
id: mirror.cards
name: Card mirror
kind: module
parent: mirror
sources:
  - cardstore.py
  - scripts/update_cards.py
links:
  - reads data.cards: Every card file is read into a row.
  - writes data.tables: The cards and card tags tables are the mirror.
fingerprint: 30d3af019726
written: 2026-10-04
---

This module walks the card files into two tables: the cards and their tags. It never writes to the files. A script runs it every hour.

The mirror is also an alarm. It keeps a row for every card it has ever seen. A card that is gone from disk with no recorded delete is marked missing, and the hourly run fails loudly.
