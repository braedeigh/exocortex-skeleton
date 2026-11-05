#!/usr/bin/env python3
"""The ear — an always-on listener for the machine in the room. It hears speech,
transcribes it locally, and sends the words to the exocortex, where each one
becomes a journal card.

Runs on the listening machine (a Mac, in the first install), NOT on the server:
nothing in the Flask app imports this. It touches

  segmenter.py   decides when speech starts and stops (pure Python, tested)
  draft.py       holds utterances until the entry is done: "send it" or a
                 minute of quiet (pure, tested)
  wake.py        tells a "hey exo" command from a plain thought (pure, tested)
  routes/ear.py  the server door it POSTs to — /api/ear/heard, shared secret

and keeps three files of its own under ~/.local/share/exo-ear/:

  heard.jsonl    every transcript, sent or not — the local copy of everything
  spool.jsonl    transcripts the server didn't take (offline); replayed later
  paused         touch this file to stop recording, remove it to resume

Flow, in one loop: microphone frames -> Segmenter -> an utterance -> Whisper
(faster-whisper, on this machine; no audio leaves it) -> wake.parse. A
"hey exo" command is sent at once and its reply spoken. Anything else joins
the Draft (draft.py): pauses don't end an entry; "send it" does, and the
exocortex answers out loud; a minute of silence does too, quietly. The ear
is deaf while it speaks, so it never transcribes its own voice. A light hook
(--light) runs a shell command on every state change so a bulb, a menu-bar
icon, or a Shortcut can show listening / hearing / drafting / thinking /
sent / saved / offline / paused.

Run `ear.py --dry-run` first: it listens and prints transcripts without a
server, which is the whole first test. README.md has the install.

Prompt that produced this (technical part): "an audio capturing tool ... talk
out loud into it and record all of my thoughts as i have them"; "a different
machine"; "light up a light bulb or something to signal that it heard
something and maybe have commands with hey exo that aren't just recording";
"local whisper on my other machine".
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import queue
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import draft as drafting  # noqa: E402
import segmenter as seg   # noqa: E402
import wake               # noqa: E402

SAMPLE_RATE = 16000
FRAME_SECONDS = 0.03
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_SECONDS)

# Lines Whisper produces from silence or breath — it was trained on subtitles,
# so an empty room comes back as a sign-off. Dropped before they reach the
# journal; a real sentence that merely contains these words is unaffected.
HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching.", "thanks for watching",
    "you", "you.", "bye.", "bye", ".", "the end.", "so", "um", "uh",
}


def state_dir() -> pathlib.Path:
    path = pathlib.Path(os.environ.get("EXO_EAR_HOME") or "~/.local/share/exo-ear").expanduser()
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# The light: one shell command per state change.
# ---------------------------------------------------------------------------

class Light:
    """Show the ear's state to the room. `template` is a shell command with
    {state} in it, run detached on every change and never waited on — a Hue
    bulb, `shortcuts run "Exo {state}"`, anything. With no template it only
    prints, which is the dry-run light."""
    STATES = ("listening", "hearing", "drafting", "heard", "thinking", "sent", "saved", "offline", "paused")

    HOLD_SECONDS = {"sent": 2.0, "saved": 3.0, "offline": 3.0}

    def __init__(self, template: str | None):
        self.template = template
        self.state = None
        self._held_until = 0.0

    def set(self, state: str):
        # A flash of green is no signal at all: "sent" and "offline" hold
        # for a moment before "listening" may replace them. "hearing" always
        # wins — she started talking again.
        if state == self.state:
            return
        if state == "listening" and time.monotonic() < self._held_until:
            return
        self._held_until = time.monotonic() + self.HOLD_SECONDS.get(state, 0.0)
        self.state = state
        print(f"[{_clock()}] ◉ {state}", flush=True)
        if self.template:
            try:
                subprocess.Popen(
                    self.template.replace("{state}", shlex.quote(state)), shell=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except OSError as exc:
                print(f"  light command failed: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Sending: the server door, with a spool for when it's unreachable.
# ---------------------------------------------------------------------------

def build_payload(heard: wake.Heard, heard_at: datetime, device: str, secret: str,
                  closed_by: str | None = None) -> dict:
    """What one entry or command looks like on the wire to /api/ear/heard.
    `closed_by` ("command" or "silence") says how an entry ended; the server
    only speaks back to one closed by command."""
    payload = {
        "secret": secret,
        "text": heard.text,
        "kind": heard.kind,
        "heard_at": heard_at.isoformat(timespec="seconds"),
        "device": device,
    }
    if closed_by:
        payload["closed_by"] = closed_by
    return payload


class Sender:
    """POST each utterance to the server; keep what it couldn't take.

    A thought lost because the laptop was asleep is the worst failure this
    tool can have, so a failed send goes to spool.jsonl and every later
    success first replays the spool, oldest first. The secret is added at
    send time, never written to the spool."""

    def __init__(self, url: str, secret: str, home: pathlib.Path, timeout: float = 8.0):
        self.url = url.rstrip("/") + "/api/ear/heard"
        self.secret = secret
        self.spool = home / "spool.jsonl"
        self.timeout = timeout

    def send(self, payload: dict, timeout: float | None = None) -> dict | None:
        """Returns the server's reply, or None when it couldn't be reached
        (the payload is then spooled). An entry that expects words back
        waits longer: the server is asking a model."""
        self.replay()
        reply = self._post(payload, timeout)
        if reply is None:
            self._spool(payload)
        return reply

    def replay(self) -> int:
        """Push spooled payloads through, stopping at the first failure so
        order holds. Returns how many got through."""
        if not self.spool.exists():
            return 0
        lines = [l for l in self.spool.read_text().splitlines() if l.strip()]
        sent = 0
        for line in lines:
            if self._post(json.loads(line)) is None:
                break
            sent += 1
        rest = lines[sent:]
        if rest:
            self.spool.write_text("\n".join(rest) + "\n")
        else:
            self.spool.unlink(missing_ok=True)
        return sent

    def _spool(self, payload: dict):
        kept = {k: v for k, v in payload.items() if k != "secret"}
        with self.spool.open("a") as fh:
            fh.write(json.dumps(kept) + "\n")

    def _post(self, payload: dict, timeout: float | None = None) -> dict | None:
        body = json.dumps({**payload, "secret": self.secret}).encode()
        req = urllib.request.Request(
            self.url, data=body, headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            # The server answered and refused: a wrong secret or an empty
            # text. Spooling it would just fail again forever, so say so.
            print(f"  server refused ({exc.code}): {exc.read().decode(errors='replace')[:200]}", file=sys.stderr)
            return {"ok": False, "refused": exc.code}
        except (urllib.error.URLError, TimeoutError, OSError):
            return None


# ---------------------------------------------------------------------------
# Transcribing: Whisper on this machine.
# ---------------------------------------------------------------------------

class Transcriber:
    def __init__(self, model_name: str, language: str):
        from faster_whisper import WhisperModel   # imported here: the server never needs it
        print(f"loading whisper model '{model_name}' (first run downloads it)…", flush=True)
        self.model = WhisperModel(model_name, device="cpu", compute_type="int8")
        self.language = language

    def transcribe(self, samples) -> str:
        import numpy as np
        audio = np.asarray(samples, dtype=np.float32)
        segments, _info = self.model.transcribe(
            audio, language=self.language, beam_size=1, vad_filter=True,
        )
        # Whisper's own guess of "no speech here" drops the breaths and
        # chair-creaks the loudness gate let through.
        parts = [s.text.strip() for s in segments if s.no_speech_prob < 0.6 and s.text.strip()]
        return " ".join(parts).strip()


def worth_keeping(text: str) -> bool:
    """A transcript worth recording: not empty, not one of Whisper's
    silence sign-offs."""
    cleaned = text.strip().lower()
    return bool(cleaned) and cleaned not in HALLUCINATIONS


# ---------------------------------------------------------------------------
# The loop.
# ---------------------------------------------------------------------------

def _clock() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _say(text: str, voice: str | None = None):
    """Speak a reply, on machines that have `say` (macOS). Returns the
    running process so the loop can stay deaf until it ends, or None."""
    if not shutil.which("say"):
        return None
    command = ["say"] + (["-v", voice] if voice else []) + [text]
    return subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Ear:
    """Everything one utterance passes through after the microphone: the
    transcriber, the draft, the sender, the light, the voice, the local log.
    Built once in listen(); handle_utterance / tick are the loop's two calls."""

    REPLY_TIMEOUT = 60.0      # a reply means a model call on the server

    def __init__(self, args, home: pathlib.Path):
        self.args = args
        self.light = Light(args.light)
        self.heard_log = home / "heard.jsonl"
        self.transcriber = Transcriber(args.model, args.language)
        self.sender = None if args.dry_run else Sender(args.url, args.secret, home)
        self.draft = drafting.Draft(timeout_seconds=args.draft_timeout,
                                    close_phrases=tuple(args.close_phrase) or drafting.DEFAULT_CLOSE_PHRASES)
        self.speaking = None      # the `say` process while the ear is talking

    # --- state the loop asks about ---------------------------------------

    def is_speaking(self) -> bool:
        if self.speaking is not None and self.speaking.poll() is None:
            return True
        self.speaking = None
        return False

    def idle_state(self) -> str:
        return "drafting" if self.draft.pending else "listening"

    def tick(self, now: float):
        """Every frame: has silence closed the entry?"""
        closed = self.draft.tick(now)
        if closed:
            self.send_entry(closed)

    # --- one utterance -----------------------------------------------------

    def handle_segment(self, segment, now: float):
        self.light.set("heard")
        text = self.transcriber.transcribe(segment.samples)
        seconds = segment.ended_at - segment.started_at
        if not worth_keeping(text):
            print(f"[{_clock()}] ({seconds:.1f}s, nothing worth keeping{': ' + text if text else ''})", flush=True)
            return
        self.handle_utterance(text, now)

    def handle_utterance(self, text: str, now: float):
        heard = wake.parse(text)
        if heard.kind == "command":
            print(f"[{_clock()}] command: {heard.text}", flush=True)
            self.send_command(heard)
            return
        closed = self.draft.feed(text, now)
        if closed is None:
            print(f"[{_clock()}] + {text}", flush=True)
            return
        if not closed.text:
            print(f"[{_clock()}] (send it — but nothing is drafted)", flush=True)
            self.speak("Nothing to send.")
            return
        self.send_entry(closed)

    # --- sending -------------------------------------------------------------

    def send_command(self, heard: wake.Heard):
        """A "hey exo" command: sent at once, its reply spoken."""
        entry = self._log_entry(heard, closed_by=None)
        if self.sender:
            reply = self.sender.send(build_payload(heard, datetime.now(), self.args.device_name, self.args.secret),
                                     timeout=self.REPLY_TIMEOUT)
            entry["sent"] = bool(reply and reply.get("ok"))
            self.light.set("sent" if entry["sent"] else "offline")
            if reply and reply.get("reply"):
                self.speak(reply["reply"])
        else:
            self.speak("Got it.")
        self._write_log(entry)

    def send_entry(self, closed: drafting.Closed):
        """A finished entry. Closed by command: wait for words and speak
        them. Closed by silence: save it and show the saved colour only."""
        heard = wake.Heard(kind="note", text=closed.text)
        print(f"[{_clock()}] entry ({closed.closed_by}): {closed.text}", flush=True)
        entry = self._log_entry(heard, closed_by=closed.closed_by)
        if self.sender:
            if closed.closed_by == "command":
                self.light.set("thinking")
            payload = build_payload(heard, datetime.now(), self.args.device_name, self.args.secret,
                                    closed_by=closed.closed_by)
            reply = self.sender.send(payload, timeout=self.REPLY_TIMEOUT if closed.closed_by == "command" else None)
            entry["sent"] = bool(reply and reply.get("ok"))
            if not entry["sent"]:
                self.light.set("offline")
            elif closed.closed_by == "command":
                self.light.set("sent")
                self.speak(reply.get("reply") or "Saved.")
            else:
                self.light.set("saved")
        else:
            self.light.set("sent" if closed.closed_by == "command" else "saved")
            if closed.closed_by == "command":
                self.speak("Got it.")
        self._write_log(entry)

    def speak(self, text: str):
        if self.args.speak:
            self.speaking = _say(text, self.args.voice)

    # --- the local record ----------------------------------------------------

    def _log_entry(self, heard: wake.Heard, closed_by: str | None) -> dict:
        entry = {"heard_at": datetime.now().isoformat(timespec="seconds"), "kind": heard.kind,
                 "text": heard.text, "sent": False}
        if closed_by:
            entry["closed_by"] = closed_by
        return entry

    def _write_log(self, entry: dict):
        with self.heard_log.open("a") as fh:
            fh.write(json.dumps(entry) + "\n")


def listen(args):
    import sounddevice as sd

    home = state_dir()
    paused_flag = home / "paused"
    ear = Ear(args, home)
    if ear.sender:
        replayed = ear.sender.replay()
        if replayed:
            print(f"replayed {replayed} spooled transcript(s)", flush=True)

    frames: "queue.Queue" = queue.Queue()

    def on_audio(indata, _frames, _time, status):
        if status:
            print(f"  audio: {status}", file=sys.stderr)
        frames.put(indata[:, 0].copy())

    stream = sd.InputStream(
        samplerate=SAMPLE_RATE, channels=1, dtype="float32",
        blocksize=FRAME_SAMPLES, device=args.device, callback=on_audio,
    )
    with stream:
        # Listen to the room for a moment to set the loudness gate, unless
        # the threshold was given by hand.
        threshold = args.threshold
        if threshold is None:
            sample = [frames.get() for _ in range(int(1.5 / FRAME_SECONDS))]
            threshold = seg.calibrate_threshold(sample)
            print(f"room noise measured; voice threshold {threshold:.4f}", flush=True)
        cutter = seg.Segmenter(
            sample_rate=SAMPLE_RATE, frame_seconds=FRAME_SECONDS, threshold=threshold,
            end_silence_seconds=args.silence, max_seconds=args.max_seconds,
        )
        ear.light.set("listening")
        print(f"listening. talk; pauses are fine; say \"send it\" to finish an entry, or wait "
              f"{int(args.draft_timeout)}s and it saves quietly. (ctrl-c stops; touch {paused_flag} to pause)", flush=True)
        while True:
            frame = frames.get()
            now = time.monotonic()
            if paused_flag.exists():
                ear.light.set("paused")
                cutter.flush()
                continue
            # Deaf while talking: the reply would otherwise come straight
            # back in as her next utterance.
            if ear.is_speaking():
                cutter.flush()
                continue
            ear.tick(now)
            segment = cutter.feed(frame)
            ear.light.set("hearing" if cutter.listening else ear.idle_state())
            if segment is None:
                continue
            ear.handle_segment(segment, time.monotonic())
            ear.light.set(ear.idle_state())


def main(argv=None):
    parser = argparse.ArgumentParser(description="The ear: listen, transcribe locally, send to the exocortex.")
    parser.add_argument("--url", default=os.environ.get("EXO_EAR_URL", ""),
                        help="the exocortex, e.g. https://your-box.your-tailnet.ts.net (or env EXO_EAR_URL)")
    parser.add_argument("--secret", default=os.environ.get("EXO_EAR_SECRET", ""),
                        help="the shared secret from /api/ear/setup (or env EXO_EAR_SECRET)")
    parser.add_argument("--dry-run", action="store_true", help="listen and print only; no server")
    parser.add_argument("--model", default=os.environ.get("EXO_EAR_MODEL", "small"),
                        help="whisper model: tiny, base, small (default), medium")
    parser.add_argument("--language", default="en")
    parser.add_argument("--device", default=None, help="input device index or name (see --list-devices)")
    parser.add_argument("--device-name", default=os.environ.get("EXO_EAR_DEVICE_NAME", os.uname().nodename),
                        help="how this machine names itself to the server")
    parser.add_argument("--light", default=os.environ.get("EXO_EAR_LIGHT"),
                        help="shell command run on each state change, with {state} substituted")
    parser.add_argument("--threshold", type=float, default=None, help="voice loudness gate (default: measured from the room)")
    parser.add_argument("--silence", type=float, default=1.2, help="seconds of quiet that end an utterance")
    parser.add_argument("--max-seconds", type=float, default=30.0, help="longest utterance before it is cut")
    parser.add_argument("--draft-timeout", type=float, default=float(os.environ.get("EXO_EAR_DRAFT_TIMEOUT", 60)),
                        help="seconds of quiet after which an entry is saved without a reply (default 60)")
    parser.add_argument("--close-phrase", action="append", default=[],
                        help="a phrase that ends an entry and asks for a reply (repeatable; default: send it, that's it, done…)")
    parser.add_argument("--voice", default=os.environ.get("EXO_EAR_VOICE"),
                        help="the macOS voice to speak with (`say -v '?'` lists them)")
    parser.add_argument("--no-speak", dest="speak", action="store_false", help="don't speak command replies aloud")
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args(argv)

    if args.list_devices:
        import sounddevice as sd
        print(sd.query_devices())
        return 0
    if not args.dry_run and not (args.url and args.secret):
        parser.error("--url and --secret are needed (or --dry-run to listen without a server)")
    if args.device is not None and args.device.isdigit():
        args.device = int(args.device)
    try:
        listen(args)
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
