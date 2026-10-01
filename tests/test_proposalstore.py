"""The machine's proposals (proposalstore.py) and the two scripts that write them.

What can silently break here, worst first: a passed check failing to close
the request it answers (or a failed one closing it), a re-run deleting an old
proposal instead of superseding it, the research pass asking twice about a
food she already traced or requested, a citation's quote getting lost between
the proposer and the checker, and a proposal standing on model knowledge alone
passing the checker, and the backup — a lost database must bring every
proposal back from food_catalog.json. The model, the web and USDA are all stubbed.
"""
import json

import foodstore
import proposalstore
import provenance
import sourcestore
import sqlstore
import store
from scripts import check_proposals, propose_sources

PAGE = "<html><body><p>Our quinoa is grown by cooperatives on the Bolivian altiplano near Oruro.</p></body></html>"


def _answer(key, **overrides):
    answer = {
        "item": key, "name": "Quinoa — Bolivian altiplano",
        "place": {"lat": -18.9, "lng": -67.1, "country": "BO", "region_name": "Oruro",
                  "precision": "area", "radius_km": 150},
        "transparency": "partial", "geo_source": "guess", "origin": "package",
        "summary": "Grown by altiplano cooperatives.", "usda_commodity": None,
        "evidence": [{"url": "https://brand.example/quinoa", "title": "Our quinoa",
                      "quote": "grown by cooperatives on the Bolivian altiplano near Oruro",
                      "claim": "The brand's quinoa is grown near Oruro, Bolivia"}],
    }
    answer.update(overrides)
    return answer


def _propose(targets, answers):
    return propose_sources.propose(targets, ask=lambda prompt: json.dumps(answers), run_id="t")


def _judge_yes(prompt):
    count = prompt.count("CLAIM:")
    return json.dumps([{"n": n, "supports": True, "reason": "ok"} for n in range(1, count + 1)])


def _check_all(fetch=lambda url: provenance.page_text(PAGE), ask=_judge_yes):
    out = []
    for proposal in proposalstore.unchecked():
        status, reason, results = check_proposals.check(proposal, fetch=fetch, ask=ask)
        proposalstore.set_check(proposal["id"], status, reason, results)
        out.append((status, reason))
    return out


# --- targets ------------------------------------------------------------------

def test_targets_skip_a_food_already_traced_through_a_product(data_dir):
    traced = foodstore.add_food("milk")
    foodstore.add_food("quinoa")
    product = foodstore.add_product(traced, "HEB whole milk")
    sourcestore.link(sourcestore.add(sourcestore.clean({"name": "Dairy", "lat": 30, "lng": -97})),
                     product_id=product)
    assert [t["label"] for t in proposalstore.targets(only="foods")] == ["quinoa"]


def test_a_requested_food_is_asked_about_once_as_the_request(data_dir):
    food = foodstore.add_food("quinoa")
    request_id, _ = sourcestore.request(food, "kitchen")
    assert [t["key"] for t in proposalstore.targets()] == [f"request:{request_id}"]


def test_a_live_proposal_takes_its_target_off_the_list_unless_forced(data_dir):
    food = foodstore.add_food("quinoa")
    _propose(proposalstore.targets(), [_answer(f"food:{food}")])
    assert (proposalstore.targets(), len(proposalstore.targets(force=True))) == ([], 1)


# --- writing ------------------------------------------------------------------

def test_a_rerun_supersedes_the_old_proposal_instead_of_deleting_it(data_dir):
    food = foodstore.add_food("quinoa")
    target = proposalstore.targets()[0]
    _propose([target], [_answer(target["key"])])
    _propose([target], [_answer(target["key"], name="Quinoa — Peru")])
    assert [p["name"] for p in proposalstore.live()] == ["Quinoa — Peru"]


def test_a_product_answer_keeps_every_part_and_names_the_worst(data_dir):
    food = foodstore.add_food("granola")
    product = foodstore.add_product(food, "Brand granola")
    parts = [{"ingredient": "oats", "place": "Canada", "transparency": "partial",
              "geo_source": "proxy", "health_concern": "some"},
             {"ingredient": "palm oil", "place": "somewhere", "transparency": "opaque",
              "geo_source": "guess", "health_concern": "high"}]
    _propose(proposalstore.targets(only="products"), [_answer(f"product:{product}", parts=parts)])
    proposal = proposalstore.live()[0]
    assert ([p["ingredient"] for p in proposal["parts"]], proposal["worst_trace_seq"],
            proposal["worst_health_seq"]) == (["oats", "palm oil"], 1, 1)


def test_a_product_answered_without_its_parts_is_asked_again(data_dir):
    food = foodstore.add_food("bone broth")
    product = foodstore.add_product(food, "Brand bone broth")
    key = f"product:{product}"
    bare = _answer(key, ingredients=["beef bones", "water", "onions", "vinegar"])
    parts = [{"ingredient": name, "place": "US", "transparency": "partial", "geo_source": "guess",
              "health_concern": "low"} for name in ("beef bones", "onions", "vinegar")]
    replies = iter([[bare], [dict(bare, parts=parts)]])
    saved, _, failures = propose_sources.propose(
        proposalstore.targets(only="products"), ask=lambda prompt: json.dumps(next(replies)), run_id="t")
    assert (len(saved), failures, len(proposalstore.live()[0]["parts"])) == (1, [], 3)


def test_the_quote_travels_from_the_proposer_to_the_checker(data_dir):
    food = foodstore.add_food("quinoa")
    _propose(proposalstore.targets(), [_answer(f"food:{food}")])
    citation = proposalstore.unchecked()[0]["citations"][0]
    assert (citation["url"], citation["quote"]) == (
        "https://brand.example/quinoa", "grown by cooperatives on the Bolivian altiplano near Oruro")


# --- the checker ------------------------------------------------------------------

def test_a_passed_check_closes_the_request_it_answers(data_dir):
    food = foodstore.add_food("quinoa")
    request_id, _ = sourcestore.request(food, "kitchen")
    _propose(proposalstore.targets(), [_answer(f"request:{request_id}")])
    assert (_check_all(), sourcestore.requests("open")) == ([("passed", "")], [])


def test_a_quote_missing_from_its_page_fails_and_leaves_the_request_open(data_dir):
    food = foodstore.add_food("quinoa")
    request_id, _ = sourcestore.request(food, "kitchen")
    _propose(proposalstore.targets(), [_answer(f"request:{request_id}")])
    [(status, reason)] = _check_all(fetch=lambda url: "a page about something else entirely")
    assert (status, "isn't on the page" in reason, len(sourcestore.requests("open"))) == \
        ("failed", True, 1)


def test_model_knowledge_alone_fails_the_check_but_is_still_shown(data_dir):
    food = foodstore.add_food("quinoa")
    _propose(proposalstore.targets(), [_answer(f"food:{food}", evidence=[])])
    [(status, reason)] = _check_all()
    assert (status, "nothing checkable" in reason, proposalstore.live()[0]["check_status"]) == \
        ("failed", True, "failed")


def test_the_judge_saying_no_fails_the_citation(data_dir):
    food = foodstore.add_food("quinoa")
    _propose(proposalstore.targets(), [_answer(f"food:{food}")])
    no = lambda prompt: json.dumps([{"n": 1, "supports": False, "reason": "says Peru"}])
    _check_all(ask=no)
    web = [e for e in proposalstore.live()[0]["evidence"] if e["role"] == "web"]
    assert {(e["check_status"], e["check_reason"]) for e in web} == {("failed", "says Peru")}


# --- backup -----------------------------------------------------------------------

_PROPOSAL_TABLES = ("source_proposals", "source_proposal_counties", "source_proposal_regions",
                    "source_proposal_parts", "source_proposal_evidence")


def _proposal_rows():
    conn = sqlstore.open_db()
    try:
        return {table: sorted(conn.execute(f"SELECT * FROM {table}").fetchall(), key=repr)
                for table in _PROPOSAL_TABLES}
    finally:
        conn.close()


def test_proposals_come_back_from_the_backup_when_the_database_is_lost(data_dir):
    # Every kind of row a run leaves: a replaced answer and its replacement,
    # county and region outlines, a product's parts, evidence, and a verdict.
    quinoa = foodstore.add_food("quinoa")
    granola = foodstore.add_product(foodstore.add_food("granola"), "Brand granola")
    target = proposalstore.targets(only="foods")[0]
    _propose([target], [_answer(target["key"])])
    _propose([target], [_answer(target["key"], name="Quinoa — Peru")])
    parts = [{"ingredient": "oats", "place": "Canada", "transparency": "partial",
              "geo_source": "proxy", "health_concern": "some"}]
    _propose(proposalstore.targets(only="products"), [_answer(f"product:{granola}", parts=parts)])
    place = {"name": "Onions", "lat": 26.2, "lng": -98.2, "precision": "area", "radius_km": 0,
             "transparency": "partial", "origin": "usda-nass"}
    proposalstore.add({"food_id": quinoa, "product_id": granola},
                      dict(place, area_kind="counties", geo_source="proxy"),
                      counties=[{"fips": "48215", "county": "Hidalgo", "state": "Texas",
                                 "value": 1200, "unit": "ACRES"}])
    proposalstore.add({"food_id": foodstore.add_food("onion")},
                      dict(place, area_kind="state", geo_source="guess"),
                      regions=[{"code": "US-TX", "name": "Texas"}])
    _check_all()
    before = _proposal_rows()
    live_before = [p["name"] for p in proposalstore.live()]

    # Lose the database; only the export files beside it are left.
    for leftover in store.DATA_DIR.glob("exo.db*"):
        leftover.unlink()
    foodstore.rebuild()

    assert all(before.values()) and (_proposal_rows(), [p["name"] for p in proposalstore.live()]) \
        == (before, live_before)
