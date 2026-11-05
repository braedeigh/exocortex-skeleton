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

Each thought now lands on today's journal page with a source chip,
"🎙 voice · <machine>", from the tags `voice` and `via:<machine>` (the
machine's name, or `--device-name` to choose one). If the server
is asleep or unreachable the thought is kept in `~/.local/share/exo-ear/spool.jsonl`
and sent the next time one gets through. Everything heard is also appended
to `~/.local/share/exo-ear/heard.jsonl` on the listening machine.

## The light

`--light` takes a shell command run on every state change, with `{state}`
replaced by one of `listening`, `hearing`, `heard`, `sent`, `offline`,
`paused`.

**A LIFX bulb** works over the local network, no account. With the Mac on
the same Wi-Fi as the bulbs:

```
./venv/bin/python3 lifx_light.py --list            # the bulbs and their names
./venv/bin/python3 lifx_light.py --label "Desk" hearing   # try one colour
./venv/bin/python3 ear.py --light './venv/bin/python3 lifx_light.py --label "Desk" {state}'
```

Dim warm white is listening, blue is hearing you, violet is transcribing,
green is sent, red is offline, and paused turns it off. The colours are at
the top of `lifx_light.py`. The bulb's address is remembered after the first
run; `--fresh` searches again if it moved.

Any other light is the same idea: on a Mac with a HomeKit bulb, one
Shortcut per state and `--light 'shortcuts run "Exo {state}"'`.

## How an entry ends

Talk with whatever pauses you like; they don't cut the entry. It ends one of
two ways:

- **You say "send it"** (or "that's it", "save it", "done" on its own). The
  entry is sent to the Keeper's open session, the light goes magenta while
  the Keeper thinks, then green, and the Keeper's reply is spoken. You can
  keep talking while it thinks. The reply is kept in the journal as the
  Keeper's card under yours. The ear is deaf while it talks, so its own voice
  never ends up in your journal. If the Keeper isn't awake or is mid-turn,
  the ear says so and the entry is still saved.
- **A minute goes by.** The entry is saved without a word and the light goes
  amber. `--draft-timeout 90` changes the minute; `--close-phrase "that'll do"`
  adds a phrase of your own.

The light is soft teal while an entry is open and waiting.

`--voice Ava` picks the Mac voice it answers in (`say -v '?'` lists them;
better ones download in System Settings under Accessibility, Spoken Content).

## Pausing

`touch ~/.local/share/exo-ear/paused` stops recording; remove the file to
resume. Useful for calls and visitors.

## Commands

A line starting with "hey exo" (Whisper also hears "hey echo", "okay X.O.")
is sent as a command and recorded with the tag `exo-command` too. Commands go
to the ear bot, which today only acknowledges them; the router that sends
them on (trigger words first, a model for the rest) is the next step, in
`routes/ear.py` `_route` and `_answer_command`.
