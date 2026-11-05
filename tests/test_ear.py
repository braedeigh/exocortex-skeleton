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
  - the draft holds an entry across pauses and closes it two ways: "send it"
    (a reply is spoken) or a minute of quiet (saved without a word);
  - an entry sent on purpose goes to the pinned Keeper session off the
    record, the Keeper's reply comes back through the polled reply door and
    is kept as a K card under the entry; a silent save asks nobody;
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
from tools.ear import draft as drafting
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


def _pin_keeper(conv_id="2026-03-04.030000"):
    (store.DATA_DIR / "bot_chats").mkdir(parents=True, exist_ok=True)
    store.write("bot_chats/index", {conv_id: {"bot": "keeper", "pinned": True, "last_at": "2026-03-04T09:00:00",
                                              "running": False}})
    return conv_id


def test_an_entry_sent_on_purpose_goes_to_the_keeper_off_the_record(client, monkeypatch):
    from routes import observatory
    conv_id = _pin_keeper()
    started = []
    monkeypatch.setattr(observatory, "begin_turn",
                        lambda cid, text, record=True, **kw: started.append((cid, text, record)) or {"ok": True, "start_offset": 1234})
    resp = client.post("/api/ear/heard", json={
        "secret": ear_route._secret(), "text": "the bread finally rose", "kind": "note",
        "closed_by": "command", "device": "kitchen-mac",
    })
    body = resp.get_json()
    assert body["pending"] == {"conv": conv_id, "offset": 1234, "card": body["id"]}
    assert body["reply"] == ""
    (cid, text, record), = started
    assert cid == conv_id and record is False, "the ear minted the B card; the turn must not mint another"
    assert text.endswith("the bread finally rose") and "read out loud" in text


def test_the_keepers_reply_is_fetched_once_the_turn_ends_and_kept_under_the_entry(client, tmp_path, monkeypatch):
    from routes import observatory
    conv_id = _pin_keeper()
    chats = tmp_path / "chats"; chats.mkdir()
    monkeypatch.setattr(observatory, "_chats_dir", lambda: chats)
    log = chats / f"{conv_id}.jsonl"
    log.write_text('{"type": "result", "result": "an older reply"}\n')
    offset = log.stat().st_size
    entry = client.post("/api/ear/heard", json={"secret": ear_route._secret(), "text": "the bread rose"}).get_json()

    # still thinking: no result past the offset, and the turn is running
    monkeypatch.setattr(observatory, "_effective_running", lambda cid, meta: True)
    poll = {"secret": ear_route._secret(), "conv": conv_id, "offset": offset, "card": entry["id"], "device": "kitchen-mac"}
    assert client.post("/api/ear/reply", json=poll).get_json() == {"done": False}

    with log.open("a") as fh:
        fh.write('{"type": "assistant", "text": ""}\n{"type": "result", "result": " The kitchen was kind today. "}\n')
    body = client.post("/api/ear/reply", json=poll).get_json()
    assert body == {"done": True, "reply": "The kitchen was kind today."}
    answer = next(c for c in stream.load_all_cards() if c.who == "K")
    assert answer.reply_to == entry["id"] and answer.body == "The kitchen was kind today."
    assert answer.tags == ["voice", "via:kitchen-mac"]


def test_a_turn_that_died_without_a_reply_ends_the_wait(client, tmp_path, monkeypatch):
    from routes import observatory
    conv_id = _pin_keeper()
    chats = tmp_path / "chats"; chats.mkdir()
    monkeypatch.setattr(observatory, "_chats_dir", lambda: chats)
    monkeypatch.setattr(observatory, "_effective_running", lambda cid, meta: False)
    body = client.post("/api/ear/reply", json={"secret": ear_route._secret(), "conv": conv_id, "offset": 0, "card": "x"}).get_json()
    assert body == {"done": True, "reply": ""}
    assert stream.load_all_cards() == []


@pytest.mark.parametrize("setup, sentence", [
    ("none", "isn't awake"),
    ("busy", "is busy"),
])
def test_when_the_keeper_cannot_take_it_she_still_hears_that_it_saved(client, monkeypatch, setup, sentence):
    from routes import observatory
    if setup == "busy":
        _pin_keeper()
        monkeypatch.setattr(observatory, "begin_turn",
                            lambda *a, **kw: {"ok": False, "status": 409, "body": {"busy": True}})
    body = client.post("/api/ear/heard", json={
        "secret": ear_route._secret(), "text": "a thought", "kind": "note", "closed_by": "command",
    }).get_json()
    assert "pending" not in body and body["reply"].startswith("Saved.") and sentence in body["reply"]
    assert [c.who for c in stream.load_all_cards()] == ["B"]


def test_an_entry_closed_by_silence_asks_nobody(client, monkeypatch):
    from routes import observatory
    _pin_keeper()
    monkeypatch.setattr(observatory, "begin_turn", lambda *a, **kw: pytest.fail("the Keeper must not be asked"))
    resp = client.post("/api/ear/heard", json={
        "secret": ear_route._secret(), "text": "remember the lease", "kind": "note", "closed_by": "silence",
    })
    assert resp.get_json()["reply"] == "" and "pending" not in resp.get_json()


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

    def post(self, payload, timeout=None):
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


# ---- the draft: when is she done? ------------------------------------------

def test_pauses_join_one_entry_and_send_it_closes_it_with_a_reply_wanted():
    entry = drafting.Draft(timeout_seconds=60)
    assert entry.feed("Today the bread finally rose.", now=10.0) is None
    assert entry.feed("I think it was the warmer kitchen.", now=40.0) is None    # a 30 s pause
    closed = entry.feed("Send it.", now=55.0)
    assert closed.closed_by == "command"
    assert closed.text == "Today the bread finally rose. I think it was the warmer kitchen."
    assert not entry.pending


def test_a_close_phrase_at_the_end_of_a_sentence_is_cut_off_the_entry():
    entry = drafting.Draft()
    closed = entry.feed("and that's about all for today, send it", now=1.0)
    assert (closed.closed_by, closed.text) == ("command", "and that's about all for today")


def test_a_lone_close_word_inside_a_sentence_does_not_close_the_entry():
    entry = drafting.Draft()
    assert entry.feed("and then I was done", now=1.0) is None
    assert entry.pending and entry.text == "and then I was done"
    assert entry.feed("Done.", now=2.0).closed_by == "command"


def test_a_minute_of_quiet_saves_the_entry_without_asking_for_a_reply():
    entry = drafting.Draft(timeout_seconds=60)
    entry.feed("Remember to call about the lease.", now=100.0)
    assert entry.tick(159.0) is None
    closed = entry.tick(160.0)
    assert (closed.closed_by, closed.text) == ("silence", "Remember to call about the lease.")
    assert entry.tick(300.0) is None, "nothing pending, nothing to close"


def test_send_it_with_nothing_drafted_closes_empty():
    closed = drafting.Draft().feed("send it", now=1.0)
    assert closed.closed_by == "command" and closed.text == ""


# ---- the ear end to end, with fakes for the mic, whisper, server and voice --

class FakeSender:
    def __init__(self):
        self.sent = []

    def send(self, payload, timeout=None):
        self.sent.append((payload, timeout))
        return {"ok": True, "id": "x", "reply": "I heard the bread rose." if payload.get("closed_by") == "command"
                or payload["kind"] == "command" else ""}


class FakeSay:
    def __init__(self):
        self.said = []
        self.alive = False

    def __call__(self, text, voice=None):
        self.said.append(text)
        self.alive = True
        return self

    def poll(self):
        return None if self.alive else 0


@pytest.fixture
def ear(tmp_path, monkeypatch):
    monkeypatch.setattr(ear_tool, "Transcriber", lambda model, language: None)
    say = FakeSay()
    monkeypatch.setattr(ear_tool, "_say", say)
    args = __import__("argparse").Namespace(
        light=None, model="small", language="en", dry_run=False, url="https://exo", secret="s",
        draft_timeout=60.0, close_phrase=[], device_name="kitchen-mac", speak=True, voice=None,
    )
    ear = ear_tool.Ear(args, tmp_path)
    ear.sender = FakeSender()
    ear.say = say
    return ear


def test_an_entry_sent_on_purpose_is_spoken_back_and_the_ear_goes_deaf_meanwhile(ear):
    ear.handle_utterance("Today the bread finally rose.", now=10.0)
    assert ear.sender.sent == [] and ear.light.state == None and ear.idle_state() == "drafting"
    ear.handle_utterance("send it", now=20.0)
    payload, timeout = ear.sender.sent[0]
    assert payload["closed_by"] == "command" and payload["text"] == "Today the bread finally rose."
    assert timeout == ear.REPLY_TIMEOUT, "a reply means a model call: wait for it"
    assert ear.say.said == ["I heard the bread rose."]
    assert ear.light.state == "sent"
    assert ear.is_speaking(), "frames are dropped while the reply plays"
    ear.say.alive = False
    assert not ear.is_speaking()
    assert json.loads((ear.heard_log).read_text())["closed_by"] == "command"


def test_while_the_keeper_thinks_the_ear_keeps_asking_then_speaks_the_reply(ear):
    answers = iter([None, {"done": False}, {"done": True, "reply": "The kitchen was kind today."}])
    polled = []
    ear.sender.poll_reply = lambda pending, device: polled.append((pending, device)) or next(answers)
    clock = iter(range(0, 1000, 2))
    ear.await_reply({"conv": "c", "offset": 5, "card": "k"}, sleep=lambda s: None, clock=lambda: next(clock))
    assert len(polled) == 3 and polled[0] == ({"conv": "c", "offset": 5, "card": "k"}, "kitchen-mac")
    assert ear.say.said == ["The kitchen was kind today."]
    assert ear.light.state == "sent"


def test_if_the_keeper_takes_too_long_the_ear_says_so_and_moves_on(ear):
    ear.sender.poll_reply = lambda pending, device: {"done": False}
    clock = iter(range(0, 100000, 50))
    ear.await_reply({"conv": "c", "offset": 5, "card": "k"}, sleep=lambda s: None, clock=lambda: next(clock))
    assert ear.say.said == ["The Keeper is still thinking. The answer will be in the journal."]


def test_an_entry_closed_by_silence_is_saved_quietly_with_its_own_colour(ear):
    ear.handle_utterance("Remember to call about the lease.", now=10.0)
    ear.tick(69.0)
    assert ear.sender.sent == []
    ear.tick(70.0)
    payload, timeout = ear.sender.sent[0]
    assert payload["closed_by"] == "silence" and timeout is None
    assert ear.say.said == [], "no voice after a silent save"
    assert ear.light.state == "saved"


def test_a_hey_exo_command_is_answered_at_once_without_touching_the_draft(ear):
    ear.handle_utterance("First thought of the morning.", now=10.0)
    ear.handle_utterance("Hey exo, what time is it", now=12.0)
    payload, _ = ear.sender.sent[0]
    assert payload["kind"] == "command" and payload["text"] == "what time is it"
    assert ear.say.said == ["I heard the bread rose."]
    assert ear.draft.pending and ear.draft.text == "First thought of the morning."
