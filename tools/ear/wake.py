"""Tell a "hey exo" command apart from a plain spoken thought.

ear.py runs every transcript through parse() before sending it: a line that opens
with the wake phrase is a command (sent with kind "command", the phrase stripped),
anything else is a note. Pure text, no audio — tests/test_ear.py covers the
spellings Whisper actually produces for the phrase.

Why fuzzy: Whisper has never heard the word "exo", so it writes what it thinks it
heard — "Exo", "echo", "X.O.", "ecso". The owner asked for "commands with hey exo
that aren't just recording", so the matcher takes the common mishearings rather
than making her enunciate.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# The wake phrase and the ways Whisper spells it. Opening word first, then the
# name, then any punctuation the model put after it.
_WAKE = re.compile(
    r"^\s*(?:hey|hi|hay|ok|okay|yo)[\s,]+"
    r"(?:exo|echo|ecso|exa|ex[\s.-]*o|x[\s.-]*o)\b[\s,.!?:;-]*",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Heard:
    kind: str   # "note" or "command"
    text: str   # what to record (the wake phrase removed for a command)


def parse(transcript: str) -> Heard:
    text = (transcript or "").strip()
    match = _WAKE.match(text)
    if not match:
        return Heard(kind="note", text=text)
    rest = text[match.end():].strip()
    # "hey exo" with nothing after it is still a command — an empty one the
    # server can answer with a prompt, rather than a note that reads "hey exo".
    return Heard(kind="command", text=rest)
