#!/usr/bin/env python3
"""request_input.py — the running session's door to ask the owner for input.

A session that hits real questions it can't resolve calls this to hand the
turn back to her: it files every open question on its OWN conversation, its
card glows orange, the questions print on the roster card and at the bottom
of its chat, and her next message answers them (the next `--resume` turn —
nothing else wakes the session; she is the transport). Same narrow-door
doctrine as spinoff_open.py: agents never write session state directly — one
validated entry point, loud precise failures.

She reads the card away from the chat, and wants to learn why things are the
way they are, so every filing carries its context and its choices:

    ./venv/bin/python3 scripts/request_input.py \
        --about "Building the question cards; the server side is done." \
        --question "Where should the about line sit?" \
        --option "Under the title — read first, before the questions" \
        --option "Above the answer box — closer to where she types" \
        --question "Anything else before I ship?"

  --about     REQUIRED for a new set: one or two plain lines on what this
              session is building and where it stands.
  --question  one question. The --options after it belong to it.
  --option    "<label> — <what it means, what it costs or gains>". 0 options
              (she types her answer) or 2-4; the one you recommend FIRST.
  --add       append these questions to the set already open, keeping its
              about, instead of filing a new set (filing replaces).

Filing exactly the set that's open again changes nothing. The JSON printed
back lists, under `open_nearby`, questions already open in the other
sessions of this one's swarm — if one is yours, point at it instead.

The same door takes the questions back down. Her message arriving in this
session clears them by itself; but when her answer comes by another route (she
answered in a different session's chat and a peer relayed her words), nothing
of hers arrives here, so the session withdraws its own questions and says
where her answer came from. The chat keeps the block, marked answered
elsewhere, with that line under it:

    ./venv/bin/python3 scripts/request_input.py --answered "relayed by <session>: she said \"A)\""

Anything this door doesn't know — an unknown --flag, an option before any
question, one lone option — is refused with the usage, never filed as a
question. A bare argument still counts as a question with no options, but
only beside --about.

The conversation id comes from EXOCORTEX_CONV_ID, injected into every Reading
Room turn's environment by routes/observatory.py `_spawn`. Prints one JSON
line to stdout; exits non-zero on refusal (no conv id, no about, a malformed
call, unknown conversation, nothing open to withdraw).

Touches: routes/observatory.py (request_input, withdraw_questions),
tests/test_request_input.py.

Prompts: "Agent symbol stayed orange when it got the answer from another chat
and not me" (the --answered form) · "I think most choices should be
questions. I want to learn why things are the way they are." · "similar to
Claude planning mode where I can click options it presents or else type in my
response" (--about and --option).
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routes.observatory import request_input, withdraw_questions  # noqa: E402

_USAGE = (
    'usage: request_input.py --about "<what you are building and where it stands>"'
    ' --question "<question>" [--option "<label> — <what it means, what it costs or gains>" ...]'
    ' [--question ...]'
    '  |  add one to the open set: request_input.py --add --question "<question>" [--option ...]'
    '  |  her answer came another way: request_input.py --answered "<where her answer came from>".'
    ' Each question gets 0 options (she types) or 2-4, the one you recommend first.'
)
_FLAGS_WITH_VALUE = ("--about", "--question", "--option")


class _Refused(ValueError):
    """A call this door won't guess at — the message says what was wrong."""


def parse(arguments):
    """Read a filing's arguments into (about, questions, options, add).
    `options` is one list per question. Raises _Refused on anything it
    doesn't understand, so nothing malformed is ever filed."""
    about, questions, options, add = None, [], [], False
    tokens = list(arguments)
    while tokens:
        token = tokens.pop(0)
        # A known flag may carry its value after "=" as well as after a space.
        flag, _, inline = token.partition("=") if token.startswith("--") else (token, "", "")
        if flag == "--add" and not inline:
            add = True
            continue
        if flag in _FLAGS_WITH_VALUE:
            if inline:
                value = inline
            elif tokens and not tokens[0].startswith("--"):
                value = tokens.pop(0)
            else:
                raise _Refused(f"{flag} needs a value after it")
            if flag == "--about":
                about = value
            elif flag == "--question":
                questions.append(value)
                options.append([])
            elif not questions:
                raise _Refused("an --option comes after the --question it belongs to")
            else:
                options[-1].append(value)
            continue
        if token.startswith("--"):
            raise _Refused(f"unknown flag {token!r}")
        # A bare argument: a question with no options.
        questions.append(token)
        options.append([])
    # Check the shape: something asked, context given, real choices.
    questions_kept = [q for q in questions if q.strip()]
    if not questions_kept:
        raise _Refused("no question given")
    if not add and not (about or "").strip():
        raise _Refused("--about is required: one or two plain lines on what you are"
                       " building and where it stands, so she can read the card away"
                       " from your chat")
    for question, offered in zip(questions, options):
        offered = [o for o in offered if o.strip()]
        if len(offered) == 1:
            raise _Refused(f"one option isn't a choice — give 2-4 or none: {question[:80]!r}")
        if len(offered) > 4:
            raise _Refused(f"at most 4 options a question: {question[:80]!r}")
    return about, questions, options, add


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    # Withdraw the open questions: `--answered` plus exactly one line saying
    # where her answer came from. Anything else after the flag is refused
    # rather than guessed at, so a mistyped call can't file "--answered" as a
    # question or drop half of what was meant.
    withdrawing = bool(arguments) and arguments[0] == "--answered"
    if withdrawing:
        if len(arguments) != 2 or not arguments[1].strip():
            print(json.dumps({"error": _USAGE}))
            return 2
    else:
        # A filing: refused whole, with the right form, unless it parses.
        try:
            about, questions, options, add = parse(arguments)
        except _Refused as refused:
            print(json.dumps({"error": f"{refused} — nothing was filed. {_USAGE}"}))
            return 2
    conv_id = os.environ.get("EXOCORTEX_CONV_ID")
    if not conv_id:
        print(json.dumps({"error": "no EXOCORTEX_CONV_ID — not a Observatory turn?"}))
        return 2
    if withdrawing:
        payload, status = withdraw_questions(conv_id, arguments[1])
    else:
        payload, status = request_input(conv_id, questions, about=about,
                                        options=options, add=add)
    print(json.dumps(payload))
    return 0 if status == 200 else 1


if __name__ == "__main__":
    # Put this run on the runtime map (runtime_sensor.py): which of our
    # files actually execute, and which call which. Inside __main__ rather
    # than at import, because some of these modules are also imported BY
    # the web app, and only the standalone run is a process of its own.
    import runtime_sensor
    runtime_sensor.attach()
    sys.exit(main())
