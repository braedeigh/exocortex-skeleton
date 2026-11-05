# The ear

An always-on listener for a machine in the room. It hears you talk, transcribes
the words on that machine (nothing leaves it but text), and sends each thought
to your exocortex, where it becomes a journal card in your voice. Say
**"hey exo, …"** and it's recorded as a command instead, and the ear answers
out loud.

Pieces: `ear.py` (the loop), `segmenter.py` (when speech starts and stops),
`wake.py` (the "hey exo" test). The server side is `routes/ear.py`.

## Install on the listening machine (a Mac)

```
git clone <this repo> exocortex-skeleton       # or copy just tools/ear/
cd exocortex-skeleton/tools/ear
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## Step 1 — prove it can hear (no server needed)

```
./venv/bin/python3 ear.py --dry-run
```

The first run downloads the Whisper `small` model (about half a gigabyte).
Then it measures the room for a second, prints `listening`, and from there
every sentence you say prints as `note: …` or `command: …`. macOS will ask
for microphone permission the first time. Ctrl-C stops it.

If it hears nothing, `./venv/bin/python3 ear.py --list-devices` shows the
inputs; pass one with `--device <number>`.

## Step 2 — connect it

Logged in to the exocortex in a browser on the same machine, open
`/api/ear/setup`. It shows the url and the secret. Then:

```
export EXO_EAR_URL=https://…      # from that page
export EXO_EAR_SECRET=…           # from that page
./venv/bin/python3 ear.py
```

Each thought now lands on today's journal page, tagged `ear`. If the server
is asleep or unreachable the thought is kept in `~/.local/share/exo-ear/spool.jsonl`
and sent the next time one gets through. Everything heard is also appended
to `~/.local/share/exo-ear/heard.jsonl` on the listening machine.

## The light

`--light` takes a shell command run on every state change, with `{state}`
replaced by one of `listening`, `hearing`, `heard`, `sent`, `offline`,
`paused`. On a Mac with a HomeKit bulb, make a Shortcut per state and run:

```
./venv/bin/python3 ear.py --light 'shortcuts run "Exo {state}"'
```

(`hearing` is the one worth wiring first: it's the "I'm getting this" signal.)

## Pausing

`touch ~/.local/share/exo-ear/paused` stops recording; remove the file to
resume. Useful for calls and visitors.

## Commands

A line starting with "hey exo" (Whisper also hears "hey echo", "okay X.O.")
is sent as a command and recorded with the tag `exo-command`. Today the server
only acknowledges them; wiring commands to actions is the next step, in
`routes/ear.py` `_answer_command`.
