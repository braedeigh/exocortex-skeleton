"""Hold what's being said until it's one finished journal entry — the ear's
sense of "she's done", with no clock or microphone attached.

ear.py feeds it every transcribed utterance as it arrives, and asks it on every
frame whether time has run out. The draft closes two ways:

  by command   the utterance is a close phrase ("send it", "that's it"), alone
               or at the end of what she said — the entry is sent and the
               exocortex answers out loud;
  by silence   nothing new for `timeout_seconds` (a minute) — the entry is
               saved without a word, and the light shows a different colour.

Pauses shorter than the timeout are just pauses: the next utterance joins the
same draft. Pure Python, tested in tests/test_ear.py.

Prompt that produced this (technical part): "i want it to talk when i am done
and let me give pauses between things … some command to stop and send it
unless it's been like 1 minute, and if it's been 1 minute i don't want it to
respond in voice, i want it to just save it as a card and turn a different
color."
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

# What ends an entry on purpose. A phrase of two or more words also counts at
# the END of an utterance ("…and that's about it, send it"); a single word
# only counts when it is the whole utterance, so "and then I was done" stays
# in the entry.
DEFAULT_CLOSE_PHRASES = (
    "send it", "okay send it", "ok send it", "that's it", "thats it",
    "save it", "save that", "all done", "end card", "send", "done",
)

_PUNCTUATION = re.compile(r"[^\w\s']")


def _words(text: str) -> List[str]:
    return _PUNCTUATION.sub("", text.lower()).split()


def split_close_phrase(text: str, phrases: Sequence[str] = DEFAULT_CLOSE_PHRASES) -> Tuple[bool, str]:
    """(closed, remainder): whether the utterance ends with a close phrase,
    and what was said before it (empty when the phrase was the whole thing)."""
    words = _words(text)
    if not words:
        return False, ""
    for phrase in sorted(phrases, key=lambda p: -len(p.split())):
        phrase_words = _words(phrase)
        count = len(phrase_words)
        if words[-count:] != phrase_words:
            continue
        if len(words) == count:
            return True, ""
        if count < 2:
            continue          # a lone word only closes when it stands alone
        # Cut the phrase off the original text by word count, so the
        # remainder keeps its own punctuation and capitals.
        original_words = text.split()
        remainder = " ".join(original_words[:-count]).rstrip(" ,;:-")
        return True, remainder
    return False, text.strip()


@dataclass
class Closed:
    text: str
    closed_by: str          # "command" | "silence"
    started_at: float
    ended_at: float


@dataclass
class Draft:
    """The entry being spoken. feed() takes each utterance with the time it
    ended; tick() is asked every frame whether silence has closed it."""
    timeout_seconds: float = 60.0
    close_phrases: Sequence[str] = DEFAULT_CLOSE_PHRASES
    _parts: List[str] = field(default_factory=list, init=False, repr=False)
    _started_at: float = field(default=0.0, init=False, repr=False)
    _last_at: float = field(default=0.0, init=False, repr=False)

    @property
    def pending(self) -> bool:
        return bool(self._parts)

    @property
    def text(self) -> str:
        return " ".join(self._parts).strip()

    def feed(self, utterance: str, now: float) -> Optional[Closed]:
        closed, remainder = split_close_phrase(utterance, self.close_phrases)
        if not self._parts:
            self._started_at = now
        if remainder:
            self._parts.append(remainder)
        self._last_at = now
        if closed:
            return self._close("command", now)
        return None

    def tick(self, now: float) -> Optional[Closed]:
        if self._parts and now - self._last_at >= self.timeout_seconds:
            return self._close("silence", now)
        return None

    def _close(self, closed_by: str, now: float) -> Closed:
        done = Closed(text=self.text, closed_by=closed_by, started_at=self._started_at, ended_at=now)
        self._parts = []
        return done
