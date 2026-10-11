---
id: file-edit
name: File to edit
kind: module
order: 14
sources:
  - file_edits.py
  - scripts/open_file.py
  - routes/file_edit.py
  - frontend/src/features/fileedit/
links:
  - writes data.queue-files: The open requests are one file in the data folder.
  - calls engine.delivery: A save wakes every session that asked.
  - depends-on page.api: The card links to the asking session with the shared link helper.
fingerprint: 
written: 2026-10-11
---

The owner can edit a file in the browser: the code page has an Edit button, which reads the whole file and saves her change back. Only files that already exist in the app code, the vault or a build can be opened. A save is refused if the file changed on disk since she opened it.

A session that needs her to fill something in, such as a key in a settings file, files a request with open_file.py. It shows as an orange card on the roster and a popup on other pages, with a button that opens the editor in a new tab. When she saves, the sessions that asked are woken. They are told the file was saved, never what is in it.
