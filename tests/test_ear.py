"""The ear (tools/ear + routes/ear.py): a listener in the room hears speech,
transcribes it locally, and each utterance becomes a journal card.

Three things that can silently break, each proven the way it's used:
  - the segmenter cuts a stream of frames into the utterances a person
    actually spoke (no clipping, no runaway monologue, no cough-triggers);
  - the wake-phrase parser tells "hey exo" commands from thoughts in the
    spellings Whisper really produces;
  - the server door refuses the wrong secret, mints a B card marked with
    how it came in and from which device, on the day it was spoken, and
    answers a command;
  - the LIFX light's packets read back as what was sent;
  - a transcript the server couldn't take is spooled and replayed, in order.
No microphone, no Whisper: frames are synthetic, the network is a fake.
"""
import json
import math
from datetime import datetime

import pytest
from flask import Flask

import store
from routes import ear as ear_route
from tools.ear import ear as ear_tool
from tools.ear import lifx_light, segmenter, wake
from tools.stream import stream

FRAME = int(16000 * 0.03)


def quiet(frames, level=0.001):
    return [[level] * FRAME for _ in range(frames)]


def voice(frames, level=0.2):
    # a steady tone, loud enough to count as speech
    return [[level * math.sin(i / 3.0) for i in range(FRAME)] for _ in range(frames)]


def run(cutter, frames):
    out = [s for s in (cutter.feed(f) for f in frames) if s is not None]
    tail = cutter.flush()
    return out + ([tail] if tail else [])


# ---- segmenter -------------------------------------------------------------

def test_one_utterance_between_silences_comes_out_whole_with_preroll():
    cutter = segmenter.Segmenter(threshold=0.01)
    # 1 s quiet, 2 s voice, 2 s quiet
    segments = run(cutter, quiet(33) + voice(67) + quiet(67))
    assert len(segments) == 1
    seg = segments[0]
    # it started a little BEFORE the voice did (the pre-roll keeps the first syllable)
    assert 0.99 - 0.31 <= seg.started_at <= 0.99
    # and it closed after the 1.2 s of quiet, not at the end of the stream
    assert 2.99 + 1.1 <= seg.ended_at <= 2.99 + 1.4
    assert len(seg.samples) == pytest.approx((seg.ended_at - seg.started_at) * 16000, rel=0.02)


def test_a_single_click_does_not_open_an_utterance():
    cutter = segmenter.Segmenter(threshold=0.01)
    segments = run(cutter, quiet(20) + voice(1) + quiet(60) + voice(2) + quiet(60))
    assert segments == []


def test_a_pause_between_words_does_not_split_the_sentence():
    cutter = segmenter.Segmenter(threshold=0.01, end_silence_seconds=1.2)
    # talk, half a second of breath, talk again, then real silence
    segments = run(cutter, quiet(10) + voice(30) + quiet(16) + voice(30) + quiet(60))
    assert len(segments) == 1


def test_a_monologue_is_cut_at_the_cap_and_continues_in_the_next_segment():
    cutter = segmenter.Segmenter(threshold=0.01, max_seconds=3.0)
    segments = run(cutter, quiet(10) + voice(250) + quiet(60))   # 7.5 s of talking
    assert len(segments) == 3
    assert all(s.ended_at - s.started_at <= 3.0 + 0.35 for s in segments)


def test_threshold_is_measured_from_the_room_but_never_below_the_floor():
    assert segmenter.calibrate_threshold(quiet(50, level=0.02)) == pytest.approx(0.06)
    assert segmenter.calibrate_threshold(quiet(50, level=0.0001)) == 0.006


# ---- wake phrase ------------------------------------------------------------

@pytest.mark.parametrize("line, kind, text", [
    ("Hey Exo, add rice to the list.", "command", "add rice to the list."),
    ("hey echo what's on my calendar", "command", "what's on my calendar"),
    ("Okay, X.O. turn off the lamp", "command", "turn off the lamp"),
    ("Hey exo", "command", ""),
    ("I think the exo should remember this.", "note", "I think the exo should remember this."),
    ("Hey, it's getting dark early now.", "note", "Hey, it's getting dark early now."),
])
def test_wake_phrase_tells_commands_from_thoughts(line, kind, text):
    assert wake.parse(line) == wake.Heard(kind=kind, text=text)


def test_whisper_silence_signoffs_are_not_worth_keeping():
    assert not ear_tool.worth_keeping("Thank you.")
    assert not ear_tool.worth_keeping("  ")
    assert ear_tool.worth_keeping("Thank you for the soup, I liked it.")


# ---- the server door --------------------------------------------------------

@pytest.fixture
def client(data_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("TULKU_STREAM_ROOT", str(tmp_path / "stream"))
    monkeypatch.setattr(ear_route.cardstore, "sync_one", lambda cid: None)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    ear_route.register(app)
    return app.test_client()


def test_wrong_secret_is_refused_and_nothing_is_recorded(client):
    resp = client.post("/api/ear/heard", json={"secret": "nope", "text": "hello"})
    assert resp.status_code == 403
    assert stream.load_all_cards() == []


def test_a_thought_becomes_a_journal_card_on_the_day_it_was_said(client):
    secret = ear_route._secret()
    resp = client.post("/api/ear/heard", json={
        "secret": secret, "text": "the bread needs a longer proof", "kind": "note",
        "heard_at": "2026-03-04T09:15:00", "device": "kitchen-mac",
    })
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] and body["kind"] == "note" and body["reply"] == ""
    card = stream.read_card(body["id"])
    assert card.who == "B"
    assert card.body == "the bread needs a longer proof"
    assert card.tags == ["voice", "via:kitchen-mac"]
    assert card.ts.startswith("2026-03-04 09:15")
    assert body["id"].startswith("2026-03-04.0915b")


def test_a_command_is_recorded_and_answered(client):
    resp = client.post("/api/ear/heard", json={
        "secret": ear_route._secret(), "text": "add rice to the list", "kind": "command",
    })
    body = resp.get_json()
    assert body["kind"] == "command" and body["reply"]
    assert stream.read_card(body["id"]).tags == ["voice", "via:unknown", "exo-command"]


def test_the_device_name_is_made_safe_for_a_tag(client):
    resp = client.post("/api/ear/heard", json={
        "secret": ear_route._secret(), "text": "hi", "device": "Bradie's Mac, [Kitchen]",
    })
    assert stream.read_card(resp.get_json()["id"]).tags == ["voice", "via:bradie-s-mac-kitchen"]


def test_empty_text_is_refused_unless_it_is_a_bare_wake_word(client):
    secret = ear_route._secret()
    assert client.post("/api/ear/heard", json={"secret": secret, "text": "  "}).status_code == 400
    resp = client.post("/api/ear/heard", json={"secret": secret, "text": "", "kind": "command"})
    assert resp.status_code == 200 and "didn't catch" in resp.get_json()["reply"]


def test_the_secret_is_made_once_and_kept(client, data_dir):
    first = ear_route._secret()
    assert first == ear_route._secret() and len(first) == 64
    assert (store.DATA_DIR / "ear_secret").read_text().strip() == first


# ---- the listener's spool ---------------------------------------------------

class FakeServer:
    """Stands in for urlopen: offline until told otherwise, then takes
    everything and remembers the order."""
    def __init__(self):
        self.online = False
        self.got = []

    def post(self, payload):
        if not self.online:
            return None
        self.got.append(payload["text"])
        return {"ok": True, "id": "x", "reply": ""}


def test_offline_transcripts_are_spooled_and_replayed_in_order(tmp_path):
    server = FakeServer()
    sender = ear_tool.Sender("https://exo.example", "s3cret", tmp_path)
    sender._post = server.post
    when = datetime(2026, 3, 4, 9, 15)
    for text in ("first", "second"):
        heard = wake.Heard(kind="note", text=text)
        assert sender.send(ear_tool.build_payload(heard, when, "mac", "s3cret")) is None
    spooled = [json.loads(l) for l in (tmp_path / "spool.jsonl").read_text().splitlines()]
    assert [s["text"] for s in spooled] == ["first", "second"]
    assert all("secret" not in s for s in spooled), "the secret never sits on disk in the spool"

    server.online = True
    heard = wake.Heard(kind="note", text="third")
    assert sender.send(ear_tool.build_payload(heard, when, "mac", "s3cret"))["ok"]
    assert server.got == ["first", "second", "third"]
    assert not (tmp_path / "spool.jsonl").exists()


# ---- the LIFX light ---------------------------------------------------------

def test_lifx_packets_read_back_as_what_was_sent():
    target = 0xD073D5001234
    packet = lifx_light.build_packet(lifx_light.SET_COLOR, lifx_light.colour_payload(205, 0.75, 0.7, 3500),
                                     target=target, source=99, sequence=7)
    assert len(packet) == 36 + 13
    parsed = lifx_light.parse_packet(packet)
    assert (parsed["type"], parsed["target"], parsed["source"], parsed["sequence"]) == (102, target, 99, 7)
    assert parsed["size"] == len(packet)
    _reserved, hue, sat, bri, kelvin, fade = __import__("struct").unpack("<BHHHHI", parsed["payload"])
    assert (round(hue / 65535 * 360), sat, bri, kelvin, fade) == (205, 49151, 45874, 3500, 300)


def test_lifx_discovery_broadcast_is_tagged_for_every_bulb():
    packet = lifx_light.build_packet(lifx_light.GET_SERVICE, tagged=True, response_wanted=True)
    frame_flags = int.from_bytes(packet[2:4], "little")
    assert frame_flags & 0xFFF == 1024 and frame_flags & (1 << 12) and frame_flags & (1 << 13)
    assert packet[22] & 1, "a reply is asked for"
    assert lifx_light.parse_label(b"Desk lamp\0\0\0" + b"\0" * 20) == "Desk lamp"
    assert lifx_light.target_to_serial(0xD073D5001234) == "34:12:00:d5:73:d0"


def test_lifx_remembers_the_chosen_bulb_so_later_calls_do_not_search(tmp_path, monkeypatch):
    monkeypatch.setenv("EXO_EAR_HOME", str(tmp_path))
    bulbs = [{"label": "Desk", "ip": "10.0.0.5", "target": 1, "serial": "01:00:00:00:00:00"},
             {"label": "Hall", "ip": "10.0.0.6", "target": 2, "serial": "02:00:00:00:00:00"}]
    searches = []
    monkeypatch.setattr(lifx_light, "discover", lambda timeout=1.5: searches.append(1) or bulbs)
    with pytest.raises(SystemExit):           # two bulbs, no label: must be told which
        lifx_light.choose_bulb(None)
    assert lifx_light.choose_bulb("desk")["ip"] == "10.0.0.5"
    assert lifx_light.choose_bulb("Desk")["ip"] == "10.0.0.5"
    assert len(searches) == 2, "the second call for the same bulb read the cache"
