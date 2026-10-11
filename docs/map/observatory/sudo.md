---
id: sudo
name: Sudo requests
kind: module
order: 13
sources:
  - sudo_requests.py
  - scripts/sudo_request.py
  - routes/sudo.py
  - frontend/src/features/sudo/
links:
  - writes data.queue-files: The open requests are one file in the data folder.
  - calls engine.delivery: The result wakes every session that asked.
  - depends-on page.api: The sudo card links to the asking session with the shared link helper.
fingerprint: 6162ed19fcb0
written: 2026-10-02
---

An agent cannot type the sudo password. So it files a request with sudo_request.py, which names one action from a fixed list in the config. The request shows as an orange box on the roster and a popup on other pages, with a password box.

When the owner approves, the server passes the password to sudo and runs the listed command. The password is never stored or logged. Two sessions that ask for the same action share one request.
