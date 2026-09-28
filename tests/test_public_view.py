"""Tests for public_config.filter_for_view — what logged-out visitors receive.

This is the privacy boundary: every /api/data/* response passes through it.
The high-stakes behaviors pinned here:
  - unknown keys default to hidden (new streams are private until opted in)
  - frosted streams ship shape/count only, never content
  - money streams ship RELATIVE values — one private scale factor, largest
    value → 100 — so the public bars render identically but real dollars
    never travel; the bank CSV deep-link and receipt paths are dropped
  - private activity types are redacted row-level from the activity log
  - the caller's data is never mutated
"""
from public_config import filter_for_view, is_public_path


def _money_data():
    return {
        "budget": {
            "income_monthly": 5000.0,
            "bank_csv_url": "https://bank.example/secret-deep-link",
            "categories": [{"name": "Groceries", "planned": 500.0, "type": "variable"}],
        },
        "expenses": [
            {"id": "e1", "date": "2026-06-01", "amount": 250.0, "category": "Groceries",
             "comments": "HEB", "receipt": "receipts/grocery/x.jpg", "source": "receipt_import"},
        ],
        "subscriptions": [{"name": "Netflix", "amount": 15.49, "frequency": "monthly"}],
    }


def test_authed_view_passes_through_untouched():
    data = _money_data()
    assert filter_for_view(data, "authed") is data


def test_unknown_keys_are_hidden_by_default():
    out = filter_for_view({"some_new_stream": [1, 2, 3]}, "public")
    assert "some_new_stream" not in out


def test_hidden_streams_are_dropped():
    out = filter_for_view({"contacts": [{"name": "x"}], "habits": []}, "public")
    assert "contacts" not in out
    assert "habits" in out


def test_frosted_streams_ship_shape_not_content():
    out = filter_for_view({"todos": [{"text": "secret"}, {"text": "secret2"}]}, "public")
    assert out["todos"] == {"_frosted": True, "shape": "list", "count": 2}


# --- money rescaling -----------------------------------------------------------

def test_public_money_never_ships_raw_dollars():
    out = filter_for_view(_money_data(), "public")
    # Largest value (income 5000) becomes 100; everything scales by the same factor
    assert out["budget"]["income_monthly"] == 100.0
    assert out["budget"]["categories"][0]["planned"] == 10.0
    assert out["expenses"][0]["amount"] == 5.0
    assert out["subscriptions"][0]["amount"] == 0.31


def test_public_money_preserves_the_ratios_the_bars_need():
    data = _money_data()
    out = filter_for_view(data, "public")
    # spent/planned ratio is identical before and after scaling
    raw = data["expenses"][0]["amount"] / data["budget"]["categories"][0]["planned"]
    scaled = out["expenses"][0]["amount"] / out["budget"]["categories"][0]["planned"]
    assert abs(raw - scaled) < 0.001


def test_public_money_drops_bank_link_and_receipt_paths():
    out = filter_for_view(_money_data(), "public")
    assert "bank_csv_url" not in out["budget"]
    assert "receipt" not in out["expenses"][0]
    assert "source" not in out["expenses"][0]
    # non-sensitive fields survive
    assert out["expenses"][0]["category"] == "Groceries"


def test_public_money_does_not_mutate_the_original():
    data = _money_data()
    filter_for_view(data, "public")
    assert data["budget"]["income_monthly"] == 5000.0
    assert data["budget"]["bank_csv_url"].startswith("https://")
    assert data["expenses"][0]["amount"] == 250.0
    assert data["expenses"][0]["receipt"] == "receipts/grocery/x.jpg"


def test_public_money_handles_all_zero_amounts():
    out = filter_for_view({
        "budget": {"income_monthly": 0, "categories": []},
        "expenses": [],
        "subscriptions": [],
    }, "public")
    assert out["budget"]["income_monthly"] == 0


# --- ecosystem food map (the shareable /food-map page) ------------------------

def test_public_ecosystem_map_is_exposed():
    out = filter_for_view({"ecosystem": {"sources": [{"name": "Kale"}]}}, "public")
    assert out["ecosystem"] == {"sources": [{"name": "Kale"}]}


def test_food_map_and_its_data_feed_travel_together():
    # The standalone /food-map and its data feed are one exhibit, reopened
    # 2026-09-17 for the portfolio: whichever tier they sit in, they sit
    # there TOGETHER, so a public map whose feed bounces to /login (or the
    # reverse) can't happen by accident. The /ecosystem dashboard tab stayed
    # closed with the rest of the dashboard.
    import public_config
    tiers = {"presentable": set(public_config.PRESENTABLE_PATHS),
             "closed": set(public_config._NOT_YET_PRESENTABLE)}
    home = {name for name, paths in tiers.items() if "/food-map" in paths}
    assert home, "/food-map must be in one of the tiers"
    assert "/api/data/ecosystem" in tiers[home.pop()]
    assert is_public_path("/food-map") == is_public_path("/api/data/ecosystem")


def test_ecosystem_write_endpoints_stay_gated():
    # Read is public; editing is owner-only. The write endpoints must NOT be public.
    assert not is_public_path("/api/ecosystem/source/add")
    assert not is_public_path("/api/ecosystem/source/remove")


def test_auth_check_is_not_public():
    # /api/auth-check is the nginx auth_request target for /files/ (code-server)
    # and /terminal/ (ttyd). It MUST NOT be public: if it is, it returns 204 to
    # logged-out visitors and nginx's auth_request becomes a silent no-op,
    # leaving those proxied shells open. It must 401 when unauthed (via the gate)
    # and 204 only when authed.
    assert not is_public_path("/api/auth-check")


def test_public_map_exposes_light_recipes_but_hides_full_recipes():
    # The map's trace picker needs id/name/ingredients (eco_recipes, public), but
    # the full recipes stream carries instructions and also rides the public
    # kitchen tab — it must stay hidden so cooking instructions never leak.
    out = filter_for_view({
        "eco_recipes": [{"id": "r1", "name": "Soup", "ingredients": ["kale"]}],
        "recipes": [{"id": "r1", "name": "Soup", "instructions": "secret steps"}],
    }, "public")
    assert out["eco_recipes"] == [{"id": "r1", "name": "Soup", "ingredients": ["kale"]}]
    assert "recipes" not in out


# --- activity log row-level redaction ---------------------------------------------

def test_private_activity_types_are_redacted_from_public_log():
    out = filter_for_view({
        "activity_log": [
            {"date": "2026-06-01", "type": "estradiol"},
            {"date": "2026-06-01", "type": "run"},
        ],
        "private_act_types": ["estradiol"],
    }, "public")
    assert out["activity_log"] == [{"date": "2026-06-01", "type": "run"}]
