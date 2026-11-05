#!/usr/bin/env python3
"""Turn a LIFX bulb into the ear's light — one colour per state, over the
local network, with no LIFX account or cloud.

ear.py runs this on every state change through its --light hook:

    ear.py --light './venv/bin/python3 lifx_light.py --label "Desk" {state}'

LIFX bulbs speak a small UDP protocol on port 56700 (the LIFX LAN protocol);
this file builds those packets by hand, so it needs no package. The first run
finds the bulbs on the network and remembers the chosen one's address in
~/.local/share/exo-ear/lifx.json (the listener's own folder, see ear.py), so
every later state change is one packet and no searching.

    lifx_light.py --list              show the bulbs on this network
    lifx_light.py --label Desk hearing  set that bulb to the "hearing" colour

Colours: listening is a dim warm white, hearing is blue, drafting (an entry
open, waiting) is soft teal, heard (transcribing) is violet, thinking (waiting
for the spoken reply) is magenta, sent is green, saved (quietly, after a
minute's silence) is amber, offline is red, paused turns the bulb off. Change
them in COLOURS.

Prompt that produced this (technical part): "i want it to light up a light
bulb or something to signal that it heard something"; "i have some light
bulbs that are lifx".
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import random
import socket
import struct
import sys
import time

PORT = 56700
HEADER_SIZE = 36

# Message types from the LIFX LAN protocol.
GET_SERVICE, STATE_SERVICE = 2, 3
GET_LABEL, STATE_LABEL = 23, 25
SET_POWER = 117          # LightSetPower: level u16, duration u32
SET_COLOR = 102          # LightSetColor: reserved u8, HSBK, duration u32

# State -> (hue degrees, saturation 0..1, brightness 0..1, kelvin). None = off.
COLOURS = {
    "listening": (0, 0.0, 0.18, 2700),      # dim warm white: nothing held
    "hearing":   (205, 0.75, 0.70, 3500),   # blue: you're talking
    "drafting":  (190, 0.45, 0.35, 3500),   # soft teal: an entry is open, waiting for more or "send it"
    "heard":     (280, 0.70, 0.60, 3500),   # violet: transcribing
    "thinking":  (300, 0.60, 0.55, 3500),   # magenta: sent, waiting for the spoken reply
    "sent":      (120, 0.80, 0.60, 3500),   # green: sent and answered
    "saved":     (40, 0.90, 0.50, 3500),    # amber: saved quietly after a minute's silence
    "offline":   (0, 1.0, 0.60, 3500),      # red: the server couldn't be reached
    "paused":    None,                      # off
}
FADE_MS = 300


# ---------------------------------------------------------------------------
# Packets.
# ---------------------------------------------------------------------------

def build_packet(message_type: int, payload: bytes = b"", target: int = 0,
                 tagged: bool = False, source: int = 0, sequence: int = 0,
                 response_wanted: bool = False) -> bytes:
    """One LIFX LAN packet: a 36-byte header (frame, frame address, protocol
    header — all little-endian) and the message's payload. `target` is the
    bulb's serial as a 64-bit number, or 0 with tagged=True for every bulb."""
    size = HEADER_SIZE + len(payload)
    frame_flags = 1024 | (1 << 12) | ((1 if tagged else 0) << 13)   # protocol 1024, addressable
    frame = struct.pack("<HHI", size, frame_flags, source)
    address_flags = 1 if response_wanted else 0                       # res_required
    frame_address = struct.pack("<Q6sBB", target, b"\0" * 6, address_flags, sequence)
    protocol_header = struct.pack("<QHH", 0, message_type, 0)
    return frame + frame_address + protocol_header + payload


def parse_packet(data: bytes) -> dict:
    """The parts of an incoming packet we read: who sent it (target), what it
    is (type), and its payload."""
    if len(data) < HEADER_SIZE:
        raise ValueError("short packet")
    size, _flags, source = struct.unpack_from("<HHI", data, 0)
    target, _reserved, _address_flags, sequence = struct.unpack_from("<Q6sBB", data, 8)
    _reserved2, message_type, _reserved3 = struct.unpack_from("<QHH", data, 24)
    return {"size": size, "source": source, "target": target, "sequence": sequence,
            "type": message_type, "payload": data[HEADER_SIZE:size]}


def colour_payload(hue_degrees: float, saturation: float, brightness: float,
                   kelvin: int, duration_ms: int = FADE_MS) -> bytes:
    """LightSetColor's body: HSBK, each 0..65535, then the fade in ms."""
    def unit(x):
        return max(0, min(65535, int(round(x * 65535))))
    hue = unit((hue_degrees % 360) / 360.0)
    return struct.pack("<BHHHHI", 0, hue, unit(saturation), unit(brightness), int(kelvin), duration_ms)


def power_payload(on: bool, duration_ms: int = FADE_MS) -> bytes:
    return struct.pack("<HI", 65535 if on else 0, duration_ms)


def parse_label(payload: bytes) -> str:
    return payload[:32].split(b"\0", 1)[0].decode("utf-8", errors="replace")


def target_to_serial(target: int) -> str:
    """The bulb's serial as LIFX prints it: six hex pairs."""
    raw = struct.pack("<Q", target)[:6]
    return ":".join(f"{b:02x}" for b in raw)


# ---------------------------------------------------------------------------
# The network.
# ---------------------------------------------------------------------------

def discover(timeout: float = 1.5) -> list[dict]:
    """Every bulb on the local network: broadcast GetService, collect each
    StateService reply, then ask each bulb its label. Returns
    [{label, ip, target, serial}], sorted by label."""
    source = random.randint(2, 2**32 - 1)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(0.3)
    sock.bind(("", 0))
    sock.sendto(build_packet(GET_SERVICE, tagged=True, source=source, response_wanted=True),
                ("255.255.255.255", PORT))
    found = {}
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            data, (ip, _port) = sock.recvfrom(1024)
        except socket.timeout:
            continue
        try:
            packet = parse_packet(data)
        except ValueError:
            continue
        if packet["type"] == STATE_SERVICE and packet["source"] == source:
            found[packet["target"]] = {"ip": ip, "target": packet["target"],
                                       "serial": target_to_serial(packet["target"]), "label": ""}
    for bulb in found.values():
        sock.sendto(build_packet(GET_LABEL, target=bulb["target"], source=source, response_wanted=True),
                    (bulb["ip"], PORT))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and any(not b["label"] for b in found.values()):
        try:
            data, _addr = sock.recvfrom(1024)
        except socket.timeout:
            continue
        try:
            packet = parse_packet(data)
        except ValueError:
            continue
        if packet["type"] == STATE_LABEL and packet["target"] in found:
            found[packet["target"]]["label"] = parse_label(packet["payload"])
    sock.close()
    return sorted(found.values(), key=lambda b: b["label"].lower())


def send(bulb: dict, message_type: int, payload: bytes):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(build_packet(message_type, payload, target=bulb["target"]), (bulb["ip"], PORT))
    sock.close()


def set_state(bulb: dict, state: str):
    """The bulb shows one state: off for paused, else on and its colour."""
    colour = COLOURS.get(state)
    if colour is None:
        send(bulb, SET_POWER, power_payload(False))
        return
    send(bulb, SET_POWER, power_payload(True))
    send(bulb, SET_COLOR, colour_payload(*colour))


# ---------------------------------------------------------------------------
# Remembering the bulb between calls.
# ---------------------------------------------------------------------------

def cache_path() -> pathlib.Path:
    home = pathlib.Path(os.environ.get("EXO_EAR_HOME") or "~/.local/share/exo-ear").expanduser()
    home.mkdir(parents=True, exist_ok=True)
    return home / "lifx.json"


def choose_bulb(label: str | None, fresh: bool = False) -> dict:
    """The bulb to drive: the cached one with this label, else search the
    network. With no label, only a network with exactly one bulb is
    unambiguous; otherwise the labels are listed and the caller must pick."""
    path = cache_path()
    if not fresh and path.exists():
        cached = json.loads(path.read_text())
        if not label or cached.get("label") == label:
            return cached
    bulbs = discover()
    if not bulbs:
        raise SystemExit("no LIFX bulbs answered on this network (is this machine on the same Wi-Fi?)")
    if label:
        matches = [b for b in bulbs if b["label"].lower() == label.lower()]
        if not matches:
            raise SystemExit(f"no bulb labelled {label!r}; found: " + ", ".join(b["label"] for b in bulbs))
        bulb = matches[0]
    elif len(bulbs) == 1:
        bulb = bulbs[0]
    else:
        raise SystemExit("several bulbs found, pass --label one of: " + ", ".join(b["label"] for b in bulbs))
    path.write_text(json.dumps(bulb))
    return bulb


def main(argv=None):
    parser = argparse.ArgumentParser(description="Drive a LIFX bulb as the ear's light.")
    parser.add_argument("state", nargs="?", choices=sorted(COLOURS), help="the state to show")
    parser.add_argument("--label", default=os.environ.get("EXO_EAR_LIFX_LABEL"), help="which bulb, by its LIFX name")
    parser.add_argument("--list", action="store_true", help="show the bulbs on this network")
    parser.add_argument("--fresh", action="store_true", help="search the network again instead of using the remembered bulb")
    args = parser.parse_args(argv)
    if args.list:
        bulbs = discover()
        if not bulbs:
            print("no bulbs answered")
        for bulb in bulbs:
            print(f"{bulb['label'] or '(no label)':24} {bulb['ip']:16} {bulb['serial']}")
        return 0
    if not args.state:
        parser.error("a state is needed (or --list)")
    bulb = choose_bulb(args.label, fresh=args.fresh)
    try:
        set_state(bulb, args.state)
    except OSError as exc:
        print(f"could not reach the bulb at {bulb['ip']}: {exc} (try --fresh)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
