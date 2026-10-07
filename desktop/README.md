# The desktop app

Plain English: a way to run the Observatory and Terrain as a program a person
downloads and double-clicks, instead of a website someone has to set up on a
server. This folder holds the window and the packaging. It changes nothing the
live site runs.

Three sessions built this together (2026-10-06). This folder is part 1, the
window and the download. The server's standalone mode (`scripts/standalone.py`)
and the first-run pages (`frontend/src/features/setup/`) are the other two.

## What is here, and what state it is in

| Piece | What it does | State |
|---|---|---|
| `launcher/` | Starts the Python server on a free port with its own data folder, waits for it to say it is ready, asks how many agents are working, stops it. | Compiles. Three tests pass against a stand-in server. `cargo run --example smoke` started and stopped the real `scripts/standalone.py` on 2026-10-06, once with the checkout's venv and once with the packed Python, while that script was still uncommitted work in progress. |
| `src-tauri/` | The window. Shows `splash/`, starts the server through the launcher, opens the Observatory, asks before quitting while agents work, offers the page a folder chooser. | **Written, never compiled.** This machine lacks the system packages (below). |
| `splash/` | The "Starting…" page, and the error page if the server never comes up. | Written, not seen in a window. |
| `pack_python.sh` | Makes the Python that travels inside the download, with the app's libraries in it. | Runs on Linux x86_64. The result was moved to another folder and loaded every library. |

## The choices, and why

**Tauri for the window** (the owner's choice, over Electron and pywebview). It
uses the browser engine each system already has, so the window part of the
download is about 10 MB and it is light on memory. What it costs: three
different engines to test across Linux, Mac and Windows, with Linux's
(WebKitGTK) the weakest at heavy drawing like Terrain's map; Rust in the build;
and a set of system packages needed to compile on Linux.

**A real Python packed inside, not a frozen one.** `pack_python.sh` fetches a
self-contained Python that runs from any folder and installs the libraries into
it. PyInstaller, the usual tool, was ruled out: the app starts its own helper
scripts with "the Python I am running in" (every agent turn does this, in
`routes/observatory.py`), and a frozen program cannot run a script.

**The person's own Claude Code and git.** Neither is in the download. The
window passes the server the `PATH` a terminal would have, because an app
started from a dock gets a short one where both look missing.

**The window stays thin.** It knows nothing about agents, models or repos, so
adding other models later does not touch it.

## Size, measured on this machine

- The packed Python with only what the standalone server needs
  (`requirements-desktop.txt`: Flask, jsonschema, bcrypt, Pillow): 122 MB
  unpacked, **39 MB as a compressed download**. The real server was started
  on it and every address that takes no arguments was fetched (103 of them):
  no server errors and no missing library. Addresses that need arguments, and
  an actual agent turn, were not exercised.
- With every library in `requirements.txt` instead: 329 MB unpacked, 101 MB
  compressed. The difference is pandas, scipy and numpy, which the standalone
  server does not load.
- The app's own code is 24 MB and the built page 13 MB, before compression.
- The window itself: about 10 MB, by Tauri's usual figures. Not measured.

## To compile the window on Linux

Ubuntu 24.04 needs these once (118 new packages; it also updates 8 Mesa
graphics-driver packages already on the machine):

```
sudo apt install --no-install-recommends libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev \
  libssl-dev pkg-config libxdo-dev
```

Then, from `desktop/src-tauri/`: `cargo run` opens the window using the
checkout's own `venv` and code. Making installers additionally needs Tauri's
command-line tool (`cargo install tauri-cli`, then `cargo tauri build`).

`EXO_DESKTOP_PYTHON`, `EXO_DESKTOP_APP_DIR` and `EXO_DESKTOP_DATA_DIR` override
where the window looks, for testing.

## What a real download still needs

**The app's code copied into the download.** `pack_python.sh` packs Python;
nothing yet copies the tracked code and the built page into
`src-tauri/resources/app/` or lists `resources/` in `tauri.conf.json`.
`scripts/make-release.sh` already stages exactly that file set for the tarball
and is the thing to reuse.

**The page built without the owner's settings.** `frontend/.env.local` holds
install-specific values (the home coordinates the theme's sunrise and sunset
use), and the build writes them into the JavaScript as plain numbers. The
download's page must be built in a checkout that has no `frontend/.env.local`.
`scripts/make-release.sh` builds in the checkout's own `frontend/` folder, so
on an install that has that file its tarball carries those values too.

**An installer per system.**
- Linux: Tauri makes a `.deb` and an AppImage (one file that runs on most
  distributions). The AppImage has to carry WebKitGTK, which adds roughly
  70-100 MB.
- Mac: a `.dmg` for each chip (Apple Silicon and Intel), or one universal file.
  The packed Python has to be fetched for each. It must be built on a Mac.
- Windows: not started. The server uses gunicorn-style process handling,
  `setsid` and `fcntl`, none of which exist there.
- Mac also needs code work first: the code that notices a dead agent turn
  reads Linux's `/proc` (`routes/observatory.py`), which a Mac does not have.

**Code signing.** Without it the system warns people off or refuses to open
the app.
- Mac: an Apple Developer membership, 99 US dollars a year. The app is signed
  and sent to Apple to be checked ("notarized") on every release. Every
  program inside the download, the packed Python's included, has to be signed.
- Windows: a signing certificate, roughly 120 to 400 dollars a year depending
  on the seller.
- Linux: nothing to buy.
- Prices are from memory, not checked today.

**Updates.** Tauri has an updater: the app asks a web address for a small file
naming the newest version, downloads it, checks a signature made with a key
only the publisher holds, and replaces itself. It needs somewhere public to
host the files and that key kept safe. Until then, updating means downloading
the new version by hand.

**Somewhere to host the files.** The code repository is public
(`braedeigh/exocortex-skeleton` on GitHub), so files attached to its releases
can be downloaded by anyone, and the website's download link and the updater
can both point there. (`INSTALL.md` still calls the repository private; that
line is out of date.)

**The source is readable**, which is already true of a public repository: the
download contains the Python code and the built page as ordinary files.

**One copy at a time.** Opening the app twice would start two servers on the
same data folder. Tauri has a single-instance plugin for this; not added yet.

## Installing from a terminal

The usual shape is one line a person pastes:

```
curl -fsSL https://<the website>/install.sh | sh
```

What it takes beside the download link:
- a small script on the website that works out the system and chip, downloads
  the matching file, checks it against a published checksum, puts it in place
  (`~/.local/bin` plus a menu entry on Linux, `/Applications` on a Mac), and
  says how to remove it;
- the release files on the public repository, the same ones the download
  link uses;
- keeping the script in step with each release.

One thing worth knowing: a file fetched by `curl` on a Mac is not marked as
"downloaded from the internet", so the Mac does not run its unsigned-app check
on it. A terminal install therefore works on a Mac without the paid signing.
The download link does not.

Not built. The owner said "maybe".
