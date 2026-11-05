"""Cut a stream of microphone frames into spoken segments — the ear's "did it hear
something" judgement, with no microphone or model attached.

Pure Python on purpose: ear.py (the Mac listener) feeds it 30 ms frames of audio
samples and gets back whole utterances to transcribe, and tests/test_ear.py feeds
it synthetic frames to prove the cutting holds up. Nothing here knows about sound
cards or Whisper.

How it decides: loudness. Each frame's RMS (root mean square — the frame's average
volume) is compared to a threshold. A few loud frames in a row start a segment; a
stretch of quiet ends it; a hard cap ends a monologue so the transcriber never
waits for a pause that isn't coming. A short pre-roll of the frames just before the
start is kept, so the first syllable isn't clipped.

Prompt that produced this (technical part): "an audio capturing tool ... i just
want to be able to talk out loud into it and record all of my thoughts as i have
them" — always-on, with voice detection, on a separate machine.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional, Sequence


def frame_rms(frame: Sequence[float]) -> float:
    """The frame's loudness, 0.0 (silence) to about 1.0 (clipping)."""
    if not len(frame):
        return 0.0
    return math.sqrt(sum(float(x) * float(x) for x in frame) / len(frame))


@dataclass
class Segment:
    """One utterance: its samples, and when (in seconds since the listener
    started) it began and ended."""
    samples: List[float]
    started_at: float
    ended_at: float


@dataclass
class Segmenter:
    """Turn frames into segments. Call feed(frame) for every frame, in order; it
    returns a Segment when one has just closed, else None. Call flush() when
    the stream stops to close a segment still open."""
    sample_rate: int = 16000
    frame_seconds: float = 0.03
    threshold: float = 0.01          # RMS above this counts as "a voice"
    start_frames: int = 3            # this many loud frames in a row open a segment
    end_silence_seconds: float = 1.2 # this much quiet closes one
    max_seconds: float = 30.0        # a monologue is cut here regardless
    preroll_seconds: float = 0.3     # kept from just before the start

    _preroll: Deque[Sequence[float]] = field(default_factory=deque, init=False, repr=False)
    _loud_run: int = field(default=0, init=False, repr=False)
    _quiet_run: int = field(default=0, init=False, repr=False)
    _open: Optional[List[float]] = field(default=None, init=False, repr=False)
    _open_started: float = field(default=0.0, init=False, repr=False)
    _clock: float = field(default=0.0, init=False, repr=False)

    def __post_init__(self):
        self._preroll = deque(maxlen=max(1, int(round(self.preroll_seconds / self.frame_seconds))))

    @property
    def listening(self) -> bool:
        """True while a segment is open — the "hearing" light."""
        return self._open is not None

    def feed(self, frame: Sequence[float]) -> Optional[Segment]:
        self._clock += self.frame_seconds
        loud = frame_rms(frame) >= self.threshold

        # No segment open: wait for a run of loud frames, keeping a pre-roll.
        # A single click or cough is one loud frame; a voice holds for several.
        if self._open is None:
            self._preroll.append(frame)
            self._loud_run = self._loud_run + 1 if loud else 0
            if self._loud_run >= self.start_frames:
                self._open = [x for f in self._preroll for x in f]
                self._open_started = self._clock - len(self._preroll) * self.frame_seconds
                self._preroll.clear()
                self._loud_run = 0
                self._quiet_run = 0
            return None

        # Segment open: keep everything (quiet included — pauses between words),
        # and close on enough quiet or on the hard cap.
        self._open.extend(frame)
        self._quiet_run = 0 if loud else self._quiet_run + 1
        quiet_seconds = self._quiet_run * self.frame_seconds
        open_seconds = self._clock - self._open_started
        if quiet_seconds >= self.end_silence_seconds or open_seconds >= self.max_seconds:
            return self._close()
        return None

    def flush(self) -> Optional[Segment]:
        """Close whatever is open (the stream is stopping)."""
        return self._close() if self._open is not None else None

    def _close(self) -> Segment:
        segment = Segment(samples=self._open, started_at=self._open_started, ended_at=self._clock)
        self._open = None
        self._quiet_run = 0
        return segment


def calibrate_threshold(frames: Sequence[Sequence[float]], floor: float = 0.006, factor: float = 3.0) -> float:
    """Pick a threshold from a second or so of room noise: a few times the
    room's median loudness, never below a floor. A fixed number would be right
    in one room and wrong in the next."""
    levels = sorted(frame_rms(f) for f in frames)
    if not levels:
        return floor
    median = levels[len(levels) // 2]
    return max(floor, median * factor)
