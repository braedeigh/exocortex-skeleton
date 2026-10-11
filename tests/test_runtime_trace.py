"""Per-request tracing (runtime_trace.py) and its endpoints.

The tracer is driven for real here — actual sys.monitoring, actual calls
through actual modules on disk — because every interesting failure is in the
shadow stack, and a faked event stream would pin the mock rather than the
mechanism. The cases that matter:

  - a hop is recorded when the FILE changes, not on every call;
  - a call arriving from outside our code is an ENTRY (src is None), which is
    the framework-mediation hole that runtime_sensor cannot see;
  - a call mediated BY a framework is still attributed to the our-frame that
    started it, for the same reason;
  - generators don't corrupt the stack (this app streams SSE from one for the
    length of an agent turn);
  - `claim()` is atomic, because two gunicorn workers race for it.
"""
import textwrap
from datetime import datetime, timezone

import pytest
from flask import Flask

import runtime_trace
import sqlstore
from routes import observatory, terrain


@pytest.fixture
def tracer(data_dir, tmp_path):
    """Roots pointed at a synthetic repo, and always torn down — a leaked
    monitoring tool id or a live trace on the greenlet would follow this test
    into the next one."""
    root = tmp_path / "app"
    root.mkdir(exist_ok=True)
    runtime_trace.configure([("skeleton", root)])
    try:
        yield runtime_trace, root
    finally:
        while runtime_trace.current() is not None:
            runtime_trace.finish(save=False)
        runtime_trace._state["roots"] = None
        runtime_trace._path_cache.clear()


def _mod(root, name, body):
    """Write a module into this test's root and import THAT file, never an
    earlier test's module of the same name.

    Python keeps every imported module in `sys.modules` for the life of the
    process, so a plain `__import__("jr_leaf")` in a second test hands back the
    first test's module — whose file sits under the first test's root. The
    tracer rightly calls that file "not ours" and records nothing, and the test
    fails for a reason that has nothing to do with the tracer. It only shows
    when the tests run in a different order, which testmon does (it sorts by
    how long each test took last time). So: forget the old module first, and
    check that what came back really lives under this root."""
    import importlib
    import sys
    path = root / f"{name}.py"
    path.write_text(textwrap.dedent(body).lstrip())
    sys.modules.pop(name, None)
    importlib.invalidate_caches()
    sys.path.insert(0, str(root))
    try:
        mod = __import__(name)
    finally:
        sys.path.remove(str(root))
    assert mod.__file__ == str(path), f"{name} was imported from {mod.__file__}, not {path}"
    return mod


def _hops(trace):
    return [(s["src"], s["dst"], s["dst_func"]) for s in trace.spans]


# --- what counts as a hop -----------------------------------------------------

def test_a_hop_is_a_file_change_not_a_call(tracer):
    """Calls inside one file are stack bookkeeping; only crossing into another
    file is a flow. This is the ~10-100x reduction the whole design rests on."""
    trace_mod, root = tracer
    _mod(root, "leaf_a", "def work():\n    return 1\n")
    caller = _mod(root, "caller_a", """
        import leaf_a

        def helper():
            return leaf_a.work()

        def go():
            helper()
            helper()
            return leaf_a.work()
    """)

    trace_mod.begin("t1", entry="test")
    caller.go()
    trace = trace_mod.finish(save=False)

    dsts = [d for _s, d, _f in _hops(trace)]
    # helper() is caller_a -> caller_a, so it never appears. The three calls
    # into leaf_a do.
    assert dsts.count("leaf_a.py") == 3
    assert "caller_a.py" in dsts        # the entry into caller_a.go itself
    assert all(s in (None, "caller_a.py") for s, _d, _f in _hops(trace))


def test_a_module_name_reused_under_a_new_root_is_still_traced(tracer, tmp_path):
    """Two tests that each write a module called the same thing must each get
    their own. The second one is the one that used to come back empty: it was
    handed the first one's module, from a root the tracer no longer watches.
    That is what made the journey test fail only in some run orders."""
    trace_mod, root = tracer
    earlier = tmp_path / "earlier_app"
    earlier.mkdir()
    _mod(earlier, "reused_a", "def work():\n    return 1\n")
    mod = _mod(root, "reused_a", "def work():\n    return 2\n")

    trace_mod.begin("t-reused", entry="test")
    assert mod.work() == 2
    trace = trace_mod.finish(save=False)

    assert [s["dst"] for s in trace.spans] == ["reused_a.py"]


def test_a_call_from_outside_our_code_is_an_entry(tracer):
    """src is None means "the framework called us here" — the row that answers
    where a request actually gets in, and precisely what runtime_sensor's
    immediate-caller edges cannot see."""
    trace_mod, root = tracer
    mod = _mod(root, "entry_a", "def handler():\n    return 1\n")

    trace_mod.begin("t2", entry="test")
    mod.handler()                    # called from the test — not one of ours
    trace = trace_mod.finish(save=False)

    assert [(s["src"], s["dst"]) for s in trace.spans] == [(None, "entry_a.py")]


def test_a_framework_mediated_call_keeps_our_caller(tracer):
    """`map()` is C code, so the immediate caller of the callee is not ours.
    The sensor records nothing for this; the tracer attributes it to the
    nearest our-frame below, which is the whole point of the shadow stack."""
    trace_mod, root = tracer
    _mod(root, "leaf_b", "def work(x):\n    return x + 1\n")
    caller = _mod(root, "caller_b", """
        import leaf_b

        def go():
            return list(map(leaf_b.work, [1, 2]))
    """)

    trace_mod.begin("t3", entry="test")
    caller.go()
    trace = trace_mod.finish(save=False)

    mediated = [s for s in trace.spans if s["dst"] == "leaf_b.py"]
    assert mediated, "the mediated call was lost entirely"
    assert all(s["src"] == "caller_b.py" for s in mediated)


def test_generators_do_not_corrupt_the_stack(tracer):
    """A generator yields and resumes rather than returning once. Without
    PY_YIELD/PY_RESUME the frame would sit on the stack forever and every later
    hop would hang off it — and this app streams SSE out of a generator for the
    entire length of an agent turn."""
    trace_mod, root = tracer
    _mod(root, "leaf_c", "def work():\n    return 1\n")
    gen = _mod(root, "gen_c", """
        import leaf_c

        def stream():
            yield leaf_c.work()
            yield leaf_c.work()

        def after():
            return leaf_c.work()
    """)

    trace_mod.begin("t4", entry="test")
    list(gen.stream())
    gen.after()
    trace = trace_mod.finish(save=False)

    # The call made AFTER the generator was fully consumed must be at the same
    # depth as the generator's own entry — not buried under a frame that never
    # got popped.
    after = [s for s in trace.spans if s["src"] == "gen_c.py"][-1]
    assert after["depth"] == 1
    assert all(s["t1_us"] is not None for s in trace.spans)


def test_truncation_is_flagged_and_bounded(tracer, monkeypatch):
    trace_mod, root = tracer
    _mod(root, "leaf_d", "def work():\n    return 1\n")
    caller = _mod(root, "caller_d", """
        import leaf_d

        def go(n):
            for _ in range(n):
                leaf_d.work()
    """)
    monkeypatch.setattr(runtime_trace, "MAX_SPANS", 5)

    trace_mod.begin("t5", entry="test")
    caller.go(50)
    trace = trace_mod.finish(save=False)

    assert trace.truncated is True
    assert len(trace.spans) == 5


# --- arming across processes --------------------------------------------------

def test_claim_is_atomic_and_one_shot(data_dir):
    """Two gunicorn workers race for the same arm. Exactly one may win, or the
    same request gets traced twice under one id."""
    trace_id = runtime_trace.arm(label="x")
    assert runtime_trace.armed()["id"] == trace_id
    first = runtime_trace.claim()
    second = runtime_trace.claim()
    assert first["id"] == trace_id
    assert second is None
    assert runtime_trace.armed() is None


def test_claim_returns_none_when_nothing_armed(data_dir):
    assert runtime_trace.claim() is None


# --- persistence --------------------------------------------------------------

def test_saved_trace_round_trips_with_its_spans(tracer):
    trace_mod, root = tracer
    mod = _mod(root, "saved_a", "def handler():\n    return 1\n")
    trace_mod.begin("t6", label="lbl", entry="GET /x")
    mod.handler()
    trace_mod.finish()

    out = runtime_trace.read_trace("t6")
    assert out["label"] == "lbl" and out["entry"] == "GET /x"
    assert [s["dst"] for s in out["spans"]] == ["saved_a.py"]
    assert out["parts"] == []


def test_a_continuation_is_its_own_part_not_more_spans(tracer):
    """The turn host's half runs in another process with its own
    perf_counter origin, so splicing it into the parent's span list would draw
    a timeline that never happened."""
    trace_mod, root = tracer
    mod = _mod(root, "part_a", "def handler():\n    return 1\n")

    trace_mod.begin("t7", entry="POST /send")
    mod.handler()
    trace_mod.finish()
    trace_mod.begin("t7.turn", entry="turn abc", kind="turn", parent_id="t7")
    mod.handler()
    trace_mod.finish()

    out = runtime_trace.read_trace("t7")
    assert len(out["parts"]) == 1
    assert out["parts"][0]["kind"] == "turn"
    assert out["parts"][0]["id"] == "t7.turn"
    # ...and the list shows one root, not two entries.
    assert [t["id"] for t in runtime_trace.recent()] == ["t7"]


def test_retention_drops_children_with_their_parent(tracer, monkeypatch):
    """Evicting a turn's half while keeping the send that spawned it would
    leave a trace that lies about where it ended."""
    trace_mod, root = tracer
    mod = _mod(root, "ret_a", "def handler():\n    return 1\n")
    monkeypatch.setattr(runtime_trace, "KEEP_TRACES", 2)

    for n in range(3):
        trace_mod.begin(f"r{n}", entry=f"GET /{n}")
        mod.handler()
        trace_mod.finish()
        trace_mod.begin(f"r{n}.turn", kind="turn", parent_id=f"r{n}")
        mod.handler()
        trace_mod.finish()

    conn = sqlstore.open_db()
    try:
        ids = {r[0] for r in conn.execute("SELECT id FROM traces")}
        orphans = conn.execute(
            "SELECT COUNT(*) FROM trace_spans WHERE trace_id NOT IN"
            " (SELECT id FROM traces)").fetchone()[0]
    finally:
        conn.close()
    assert "r0" not in ids and "r0.turn" not in ids     # the pair went together
    assert {"r1", "r1.turn", "r2", "r2.turn"} <= ids
    assert orphans == 0


# --- the tree -----------------------------------------------------------------

def test_tree_rebuilds_nesting_from_depth():
    """`depth` is the shadow-stack depth, so parentage is reconstructible
    without storing parent ids — but only if a span's parent is the last one
    strictly shallower, and deeper siblings are forgotten on the way back up."""
    spans = [
        {"seq": 0, "depth": 0, "dst": "a"},
        {"seq": 1, "depth": 1, "dst": "b"},
        {"seq": 2, "depth": 2, "dst": "c"},
        {"seq": 3, "depth": 1, "dst": "d"},      # back up — sibling of b, not child of c
        {"seq": 4, "depth": 0, "dst": "e"},
    ]
    tree = terrain._trace_tree(spans)
    assert [n["dst"] for n in tree] == ["a", "e"]
    assert [n["dst"] for n in tree[0]["children"]] == ["b", "d"]
    assert [n["dst"] for n in tree[0]["children"][0]["children"]] == ["c"]
    assert tree[0]["children"][1]["children"] == []


def test_tree_keeps_an_orphan_as_a_root():
    """A truncated trace can lose a parent. The orphan must still appear."""
    tree = terrain._trace_tree([{"seq": 0, "depth": 3, "dst": "deep"}])
    assert [n["dst"] for n in tree] == ["deep"]


# --- the endpoints ------------------------------------------------------------

@pytest.fixture
def trace_client(data_dir, tmp_path, monkeypatch):
    root = tmp_path / "app"
    root.mkdir(exist_ok=True)
    (root / "solo.py").write_text("x = 1\n")
    monkeypatch.setattr(observatory, "_terrain_repos",
                        lambda: ({"id": "skeleton", "name": "App", "root": root},))
    monkeypatch.setattr(terrain, "_graph_cache", {"built_at": 0.0})
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terrain.register(app)
    return app.test_client()


def test_arm_then_list_then_disarm(trace_client):
    armed = trace_client.post("/api/observatory/terrain/trace/arm",
                              json={"label": "hello"}).get_json()
    assert armed["armed"] is True and armed["id"]
    listed = trace_client.get("/api/observatory/terrain/trace").get_json()
    assert listed["armed"]["id"] == armed["id"]
    assert listed["armed"]["label"] == "hello"
    trace_client.delete("/api/observatory/terrain/trace/arm")
    assert trace_client.get("/api/observatory/terrain/trace").get_json()["armed"] is None


def test_missing_trace_is_a_404(trace_client):
    assert trace_client.get("/api/observatory/terrain/trace/nope").status_code == 404


def test_trace_endpoint_marks_hops_the_import_graph_cannot_explain(trace_client, tracer):
    """A hop with static=false is a real call the static graph doesn't have an
    edge for — dynamic dispatch, or a parser gap. Both are worth seeing."""
    trace_mod, root = tracer
    _mod(root, "leaf_e", "def work():\n    return 1\n")
    caller = _mod(root, "caller_e", "import leaf_e\n\ndef go():\n    return leaf_e.work()\n")
    trace_mod.begin("t8", entry="GET /x")
    caller.go()
    trace_mod.finish()

    data = trace_client.get("/api/observatory/terrain/trace/t8").get_json()
    hop = next(s for s in data["spans"] if s["src"] == "caller_e.py")
    assert hop["static"] is True          # caller_e imports leaf_e — explained
    entry = next(s for s in data["spans"] if s["src"] is None)
    assert entry["static"] is False       # an entry has no static edge by definition
    assert data["tree"]


# --- journeys: many requests, one id ------------------------------------------

def _journey_app(root, monkeypatch):
    """A minimal app with server.py's two request hooks reproduced verbatim in
    spirit: header first, then the one-shot arm."""
    monkeypatch.setattr(observatory, "_terrain_repos",
                        lambda: ({"id": "skeleton", "name": "App", "root": root},))
    monkeypatch.setattr(terrain, "_graph_cache", {"built_at": 0.0})
    app = Flask(__name__)
    app.config.update(TESTING=True)
    terrain.register(app)
    mod = _mod(root, "jr_leaf", "def work():\n    return 1\n")

    @app.before_request
    def _begin():
        from flask import request
        if request.path.startswith("/api/observatory/terrain/trace"):
            return
        jrec = runtime_trace.claim_for_header(request.headers.get("X-Journey-Id"))
        if jrec:
            rid = runtime_trace.journey_request_id(jrec["id"])
            request.trace_id = rid
            runtime_trace.begin(rid, entry=f"{request.method} {request.path}",
                                kind="http", parent_id=jrec["id"])
            return
        pending = runtime_trace.claim()
        if pending:
            runtime_trace.begin(pending["id"], entry=f"{request.method} {request.path}")

    @app.teardown_request
    def _end(exc=None):
        if runtime_trace.current() is not None:
            runtime_trace.finish()

    @app.route("/api/thing")
    def thing():
        mod.work()
        return "ok"

    return app.test_client()


def test_journey_collects_every_request_that_carries_its_id(tracer, monkeypatch):
    """Two requests with the header -> two child traces under one journey; a
    request WITHOUT the header is not traced at all, even mid-window."""
    trace_mod, root = tracer
    c = _journey_app(root, monkeypatch)
    rec = c.post("/api/observatory/terrain/trace/arm",
                 json={"journey": True, "seconds": 30}).get_json()
    jid = rec["id"]
    assert rec["journey"]["until"] > 0
    c.get("/api/thing", headers={"X-Journey-Id": jid})
    c.get("/api/thing")                                   # no header: untraced
    c.get("/api/thing", headers={"X-Journey-Id": jid})

    out = runtime_trace.read_trace(jid)
    assert out["kind"] == "journey" and out["spans"] == []
    assert len(out["parts"]) == 2
    assert all(p["parent_id"] == jid for p in out["parts"])
    assert [s["dst"] for s in out["parts"][0]["spans"]] == ["jr_leaf.py"]
    # ...and the list shows one root, the journey, not three entries.
    assert [t["id"] for t in runtime_trace.recent()] == [jid]
    listed = c.get("/api/observatory/terrain/trace").get_json()
    assert listed["journey"]["id"] == jid


def test_journey_header_with_a_stale_id_is_ignored(tracer, monkeypatch):
    trace_mod, root = tracer
    c = _journey_app(root, monkeypatch)
    jid = c.post("/api/observatory/terrain/trace/arm", json={"journey": True}).get_json()["id"]
    c.get("/api/thing", headers={"X-Journey-Id": "j-nope"})
    assert runtime_trace.read_trace(jid)["parts"] == []


def test_journey_expires_and_closes_with_its_duration(tracer, monkeypatch):
    trace_mod, root = tracer
    rec = runtime_trace.arm_journey(seconds=30)
    monkeypatch.setattr(runtime_trace.time, "time", lambda: rec["until"] + 1)
    assert runtime_trace.journey() is None                # expired on sight
    assert runtime_trace.claim_for_header(rec["id"]) is None
    head = runtime_trace.read_trace(rec["id"])
    assert 0 < head["duration_us"] <= 30 * 1_000_000


def test_a_turn_under_a_journey_request_is_a_grandchild_and_still_listed(tracer):
    """journey -> request -> turn. read_trace flattens all three levels into
    `parts`, in start order, and retention drops the whole family together."""
    trace_mod, root = tracer
    mod = _mod(root, "jr_turn", "def handler():\n    return 1\n")
    rec = runtime_trace.arm_journey(seconds=30)
    rid = runtime_trace.journey_request_id(rec["id"])
    trace_mod.begin(rid, entry="POST /send", parent_id=rec["id"])
    mod.handler()
    trace_mod.finish()
    trace_mod.begin(f"{rid}.turn", entry="turn abc", kind="turn", parent_id=rid)
    mod.handler()
    trace_mod.finish()

    out = runtime_trace.read_trace(rec["id"])
    assert [p["kind"] for p in out["parts"]] == ["http", "turn"]
    assert out["parts"][1]["parent_id"] == rid

    import pytest as _pt
    _pt.MonkeyPatch().setattr(runtime_trace, "KEEP_TRACES", 1)
    trace_mod.begin("newer", entry="GET /x")
    mod.handler()
    trace_mod.finish()
    conn = sqlstore.open_db()
    try:
        ids = {r[0] for r in conn.execute("SELECT id FROM traces")}
    finally:
        conn.close()
    runtime_trace.KEEP_TRACES = 2000
    assert ids == {"newer"}                               # grandchild went too


def test_roots_older_than_keep_days_are_dropped(tracer, monkeypatch):
    """The record is kept by age now, not by count — a week of journeys."""
    trace_mod, root = tracer
    mod = _mod(root, "ret_age", "def handler():\n    return 1\n")
    trace_mod.begin("old", entry="GET /old")
    mod.handler()
    old = trace_mod.finish()
    conn = sqlstore.open_db()
    try:
        conn.execute("UPDATE traces SET started_at = '2000-01-01T00:00:00.000+00:00' WHERE id = 'old'")
        conn.commit()
    finally:
        conn.close()
    trace_mod.begin("new", entry="GET /new")
    mod.handler()
    trace_mod.finish()
    assert [t["id"] for t in runtime_trace.recent()] == ["new"]
    assert old is not None


def test_several_journeys_can_be_open_at_once(tracer, monkeypatch):
    """One per visible tab: each is its own file, each id claims only itself,
    and closing one leaves the other open."""
    trace_mod, root = tracer
    c = _journey_app(root, monkeypatch)
    a = runtime_trace.arm_journey(label="phone", seconds=60)
    b = runtime_trace.arm_journey(label="laptop", seconds=60)
    assert {j["id"] for j in runtime_trace.open_journeys()} == {a["id"], b["id"]}
    c.get("/api/thing", headers={"X-Journey-Id": a["id"]})
    c.get("/api/thing", headers={"X-Journey-Id": b["id"]})
    assert len(runtime_trace.read_trace(a["id"])["parts"]) == 1
    assert len(runtime_trace.read_trace(b["id"])["parts"]) == 1
    c.delete("/api/observatory/terrain/trace/arm", json={"id": a["id"]})
    assert [j["id"] for j in runtime_trace.open_journeys()] == [b["id"]]
    listed = c.get("/api/observatory/terrain/trace").get_json()
    assert [j["id"] for j in listed["journeys"]] == [b["id"]]


def test_browser_part_lands_under_the_journey_with_components_resolved(tracer, monkeypatch, tmp_path):
    """The browser posts clicks and fetches; a component name becomes the file
    the code graph knows exports it, and an unknown one stays `browser`."""
    trace_mod, root = tracer
    src = root / "frontend" / "src"
    src.mkdir(parents=True)
    (src / "Composer.tsx").write_text("export function Composer() { return null }\n")
    (src / "Page.tsx").write_text("import { Composer } from './Composer';\nexport const P = 1;\n")
    c = _journey_app(root, monkeypatch)
    jid = c.post("/api/observatory/terrain/trace/arm", json={"journey": True}).get_json()["id"]
    r = c.post(f"/api/observatory/terrain/trace/{jid}/browser", json={"events": [
        {"kind": "click", "components": ["Composer", "Page"], "label": "Send",
         "t0_ms": 10, "t1_ms": 10},
        {"kind": "fetch", "path": "/api/thing", "label": "GET /api/thing",
         "t0_ms": 12, "t1_ms": 40},
        {"kind": "click", "components": ["Mystery"], "label": "?", "t0_ms": 50},
    ]})
    assert r.status_code == 200 and r.get_json()["span_count"] == 3

    out = c.get(f"/api/observatory/terrain/trace/{jid}").get_json()
    browser = next(p for p in out["parts"] if p["kind"] == "browser")
    spans = browser["spans"]
    assert (spans[0]["dst_repo"], spans[0]["dst"]) == ("skeleton", "frontend/src/Composer.tsx")
    assert spans[0]["src"] == "Composer < Page" and spans[0]["src_func"] == "click"
    assert spans[1]["dst"] == "/api/thing" and spans[1]["t1_us"] == 40_000
    assert spans[2]["dst_repo"] == "browser"
    assert browser["duration_us"] == 50_000


def test_browser_events_for_an_unknown_or_closed_journey_are_refused(tracer, monkeypatch):
    trace_mod, root = tracer
    c = _journey_app(root, monkeypatch)
    assert c.post("/api/observatory/terrain/trace/j-nope/browser",
                  json={"events": []}).status_code == 404
    jid = c.post("/api/observatory/terrain/trace/arm", json={"journey": True}).get_json()["id"]
    c.delete("/api/observatory/terrain/trace/arm")
    # Inside the grace window the trailing flush still lands...
    assert c.post(f"/api/observatory/terrain/trace/{jid}/browser",
                  json={"events": []}).status_code == 200
    # ...well after it, it doesn't.
    monkeypatch.setattr(terrain.time, "time", lambda: 10**10)
    assert c.post(f"/api/observatory/terrain/trace/{jid}/browser",
                  json={"events": []}).status_code == 409


def test_turn_part_carries_the_agents_own_tool_calls(tracer, monkeypatch, data_dir):
    """A turn's transcript lines inside the part's window become
    `agent_calls` — the inside of the box the tracer can't see into."""
    import json as _json
    trace_mod, root = tracer
    c = _journey_app(root, monkeypatch)
    mod = _mod(root, "jr_agent", "def handler():\n    return 1\n")
    trace_mod.begin("ta", entry="POST /send")
    mod.handler()
    trace_mod.finish()
    trace_mod.begin("ta.turn", entry="turn conv1", kind="turn", parent_id="ta")
    t_mid = datetime.now(timezone.utc).isoformat()
    mod.handler()
    trace_mod.finish()
    chats = data_dir / "bot_chats"
    chats.mkdir(parents=True, exist_ok=True)
    (chats / "conv1.jsonl").write_text("\n".join(_json.dumps(e) for e in [
        {"ts": "2000-01-01T00:00:00+00:00", "message": {"content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "/x/old.py"}}]}},
        {"ts": t_mid, "message": {"content": [
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "/x/a.py"}},
            {"type": "tool_use", "name": "Bash", "input": {"command": "ls -la"}}]}},
    ]) + "\n")

    out = c.get("/api/observatory/terrain/trace/ta").get_json()
    turn = out["parts"][0]
    assert [(a["name"], a["path"]) for a in turn["agent_calls"]] == \
        [("Edit", "/x/a.py"), ("Bash", "ls -la")]


def test_trace_carries_the_store_writes_inside_its_window(tracer, monkeypatch, data_dir):
    """The creek's half: every write the journal saw while the trace was
    running, and none from before or after."""
    import store
    trace_mod, root = tracer
    c = _journey_app(root, monkeypatch)
    mod = _mod(root, "jr_w", "def handler():\n    return 1\n")
    monkeypatch.delenv("EXOCORTEX_WRITE_LOG_OFF", raising=False)
    store.write("before_coll", {"a": 1})
    import time as _t
    _t.sleep(1.05)                      # the journal stamps to the second: land in an earlier one
    trace_mod.begin("tw", entry="POST /x")
    mod.handler()
    store.write("during_coll", {"a": 2})
    trace_mod.finish()

    out = c.get("/api/observatory/terrain/trace/tw").get_json()
    colls = [w["collection"] for w in out["writes"]]
    assert "during_coll" in colls
    assert "before_coll" not in colls


def test_close_route_ends_one_journey(tracer, monkeypatch):
    trace_mod, root = tracer
    c = _journey_app(root, monkeypatch)
    a = runtime_trace.arm_journey(seconds=60)
    assert c.post(f"/api/observatory/terrain/trace/{a['id']}/close").get_json()["closed"] is True
    assert runtime_trace.open_journeys() == []
    assert c.post("/api/observatory/terrain/trace/j-nope/close").get_json()["closed"] is False


def test_request_ids_are_unique_within_one_millisecond():
    ids = {runtime_trace.journey_request_id("j-x") for _ in range(50)}
    assert len(ids) == 50


def test_empty_closed_journeys_are_pruned_after_the_grace(tracer, monkeypatch):
    """Live mode opens a window every time a tab is shown; one nothing
    happened in shouldn't clutter the record — but not before the browser's
    trailing flush has had its chance, and never while it's still open."""
    trace_mod, root = tracer
    mod = _mod(root, "pr_a", "def handler():\n    return 1\n")
    empty = runtime_trace.arm_journey(seconds=60)
    full = runtime_trace.arm_journey(seconds=60)
    still_open = runtime_trace.arm_journey(seconds=60)
    trace_mod.begin(runtime_trace.journey_request_id(full["id"]), parent_id=full["id"])
    mod.handler()
    trace_mod.finish()
    runtime_trace.end_journey(empty["id"])
    runtime_trace.end_journey(full["id"])
    assert runtime_trace.prune_empty(grace_sec=30) == 0          # inside the grace
    assert runtime_trace.prune_empty(grace_sec=0) == 1           # past it: the empty one
    assert runtime_trace.read_trace(empty["id"]) is None
    assert runtime_trace.read_trace(full["id"]) is not None
    assert runtime_trace.read_trace(still_open["id"]) is not None
