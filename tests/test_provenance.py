"""The machine-proposal rules in provenance.py: cleaning a model's answer,
ranking a product's parts, the USDA comparison, and finding a quote in a page.
No database — every function here is pure (USDA is stubbed)."""
import provenance


def _answer(**overrides):
    answer = {
        "food": "quinoa", "name": "Quinoa — Bolivian altiplano",
        "place": {"lat": -19.6, "lng": -67.6, "country": "bo", "region_name": "Oruro", "radius_km": 150},
        "transparency": "partial", "geo_source": "guess", "origin": "research",
        "summary": "Most US quinoa is imported from Bolivia and Peru.",
        "evidence": [{"url": "https://example.org/q", "quote": "Bolivia and Peru produce most quinoa",
                      "claim": "Quinoa is mostly grown in Bolivia and Peru"}],
    }
    answer.update(overrides)
    return answer


def test_clean_answer_keeps_a_good_answer():
    proposal, problems = provenance.clean_answer(_answer())
    assert (proposal["country"], proposal["region_name"], len(proposal["evidence"]), problems) == \
        ("BO", "Oruro", 1, [])


def test_a_machine_may_never_mark_placed():
    proposal, problems = provenance.clean_answer(_answer(geo_source="placed"))
    assert proposal is None and "only a visit" in problems[0]


def test_answer_without_coordinates_is_refused():
    proposal, _problems = provenance.clean_answer(_answer(place={"country": "BO"}))
    assert proposal is None


def test_evidence_without_a_quote_is_dropped_and_said():
    proposal, problems = provenance.clean_answer(
        _answer(evidence=[{"url": "https://example.org/q", "claim": "x"}]))
    assert proposal["evidence"] == [] and problems


def test_unknown_words_fall_back_to_the_most_cautious():
    proposal, _ = provenance.clean_answer(_answer(transparency="great", geo_source="certain"))
    assert (proposal["transparency"], proposal["geo_source"]) == ("opaque", "guess")


def test_worst_parts_picks_least_traceable_and_worst_for_health_separately():
    parts = [
        {"seq": 0, "transparency": "disclosed", "geo_source": "proxy", "health_concern": "high"},
        {"seq": 1, "transparency": "opaque", "geo_source": "guess", "health_concern": "low"},
    ]
    assert provenance.worst_parts(parts) == {"worst_trace_seq": 1, "worst_health_seq": 0}


def test_worst_parts_tie_goes_to_the_first_listed_ingredient():
    parts = [{"seq": i, "transparency": "partial", "geo_source": "proxy", "health_concern": "some"}
             for i in range(3)]
    assert provenance.worst_parts(parts) == {"worst_trace_seq": 0, "worst_health_seq": 0}


def test_quote_found_ignores_markup_case_and_punctuation():
    page = provenance.page_text("<p>“Bolivia and <b>Peru</b> produce\nmost quinoa,” says FAO.</p>")
    assert provenance.quote_found('Bolivia and Peru produce most quinoa', page)


def test_quote_not_on_the_page_is_not_found():
    assert not provenance.quote_found("Kansas grows most quinoa", "Bolivia and Peru produce most quinoa")


def test_usda_matches_flags_a_changed_value():
    stored = [{"fips": "48001", "county": "Anderson", "value": 100.0}]
    fresh = {"counties": [{"fips": "48001", "value": 150.0}]}
    assert provenance.usda_matches(stored, fresh)


def test_usda_matches_passes_the_same_numbers():
    stored = [{"fips": "48001", "county": "Anderson", "value": 100.0}]
    assert provenance.usda_matches(stored, {"counties": [{"fips": "48001", "value": 100.0}]}) == []


def test_usda_placement_centres_on_the_lead_county_state():
    rows = [{"year": "2022", "state_fips_code": "48", "county_code": "001", "Value": "500",
             "statisticcat_desc": "INVENTORY", "county_name": "ANDERSON", "state_name": "TEXAS",
             "unit_desc": "HEAD"}]
    placed = provenance.usda_placement("CATTLE", "k", fetch=lambda *a, **k: rows)
    assert (placed["region_name"], placed["counties"][0]["fips"]) == ("Texas", "48001")


def test_rules_require_something_checkable():
    proposal, _ = provenance.clean_answer(_answer())
    evidence = [{"role": "model", "check_status": "unchecked"}]
    assert any("nothing checkable" in p for p in provenance.rule_problems(proposal, evidence=evidence))


def test_rules_pass_with_a_checked_page():
    proposal, _ = provenance.clean_answer(_answer())
    assert provenance.rule_problems(proposal, evidence=[{"role": "web", "check_status": "passed"}]) == []


def test_rules_refuse_usda_origin_without_counties():
    proposal, _ = provenance.clean_answer(_answer(origin="usda-nass", geo_source="proxy"))
    problems = provenance.rule_problems(proposal, evidence=[{"role": "web", "check_status": "passed"}])
    assert any("USDA counties" in p for p in problems)
