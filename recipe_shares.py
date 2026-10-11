"""Shared recipes — the links she hands out, and what someone opening one sees.

**What this does.** When she shares a recipe, it gets a link with an
unguessable token (/share/r/<token>). Anyone holding the link can open that one
recipe — no login — and see what it gives per serving against *their own*
targets: they type their age and sex on the page, it's sent with each request,
and it's never stored. She can stop sharing at any time. The token dies and
the link stops working. Sharing again makes a new token, so an old link stays
dead.

**Popular recipes** are the recipes shared from this exocortex, most opened
first (/share/recipes). A visitor filters them by foods they avoid and by
histamine, all in the page. Nothing about the visitor is sent except the age
and sex they typed, and those only to work out their targets.

**What a visitor sees, and what they never do.** The recipe itself — name,
servings, times, the source it came from, ingredients (item, amount, note),
the steps — and the nutrients worked out from it, with SIGHI's histamine
ratings. Never: her own notes (`my_notes`), the recipe's `notes` and `tags`
(she writes both, and either can carry something personal), her food guide,
her catalog's safety marks, her targets or settings. The allow-list is
`_RECIPE_FIELDS` / `_INGREDIENT_FIELDS` below. Leaving a field out of those
is how it stays private.

**Where it's kept.** `recipe_shares.json` in her data dir (through store.py):
{"shares": {token: {recipe_id, created_at, revoked_at, views}}}. A view is
counted when the page first opens a recipe (the `count` flag). Changing the
age box doesn't count again. The count is honest only as far as nobody is
reloading on purpose: it's a ranking hint, not a measure.

**Reach.** The pages and their API are open without login (the /share/ and
/api/share/ prefixes in public_config.PUBLIC_PATHS), but the site itself is
still only on her tailnet. Reaching people outside it waits on a public
website, and that's the only piece missing.

Touches: `store.py` (the shares file), `recipe_nutrition.py` (for_visitor:
the nutrients, worked out without anything of hers), `foodstore.py` (a
rebuild when she shares, so the recipe rows are fresh), `routes/recipe_share.py`
(the HTTP door), `tests/test_recipe_shares.py`. Design: docs/recipe-nutrition.md.

Prompt that produced this file: "i'll want it to have shareable recipes and
popular recipes so that people can get recipes that meet their nutrient
requirements and they can filter by foods they are sensitive to" — then:
popular = explicitly shared ones; reachable outside the tailnet (a website
comes later); a shared recipe shows the recipient's own nutrient fit per
serving.
"""
import datetime
import secrets
import sqlite3

import foodstore
import recipe_nutrition
import store

SHARES = "recipe_shares.json"

# What of a recipe a visitor sees. Anything not listed here stays hers.
_RECIPE_FIELDS = ("name", "servings", "prep_min", "cook_min", "source_url")
_INGREDIENT_FIELDS = ("item", "qty", "note")


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _recipes():
    """Her recipes by id, archived ones left out."""
    data = store.read("recipes.json", {"recipes": []}) or {}
    return {r["id"]: r for r in data.get("recipes") or []
            if isinstance(r, dict) and r.get("id") and not r.get("is_archived")}


def _live(shares):
    """The shares still open: {token: share}."""
    return {token: share for token, share in shares.items() if not share.get("revoked_at")}


# --- her side: sharing and unsharing -----------------------------------------

def share(recipe_id):
    """Share a recipe: its open token, or a new one. Raises KeyError for an unknown recipe."""
    if recipe_id not in _recipes():
        raise KeyError(recipe_id)
    # Refresh the recipe rows now, so a visitor (whose requests never write) reads current lines.
    try:
        foodstore.rebuild()
    except sqlite3.OperationalError as error:
        if "locked" not in str(error) and "busy" not in str(error):
            raise
    with store.mutate(SHARES, {"shares": {}}) as data:
        shares = data.setdefault("shares", {})
        for token, one in _live(shares).items():
            if one["recipe_id"] == recipe_id:
                return token
        token = secrets.token_urlsafe(12)
        shares[token] = {"recipe_id": recipe_id, "created_at": _now(), "revoked_at": None, "views": 0}
        return token


def unshare(recipe_id):
    """Stop sharing a recipe: every open link to it stops working. Returns how many were closed."""
    closed = 0
    with store.mutate(SHARES, {"shares": {}}) as data:
        for one in _live(data.setdefault("shares", {})).values():
            if one["recipe_id"] == recipe_id:
                one["revoked_at"] = _now()
                closed += 1
    return closed


def mine():
    """Her open shares: {recipe_id: {token, views, created_at}}."""
    shares = (store.read(SHARES, {"shares": {}}) or {}).get("shares") or {}
    return {one["recipe_id"]: {"token": token, "views": one.get("views", 0),
                               "created_at": one.get("created_at")}
            for token, one in _live(shares).items()}


# --- a visitor's side ----------------------------------------------------------

def _visible(recipe):
    """The recipe as a visitor sees it: only the allow-listed fields."""
    out = {field: recipe.get(field) for field in _RECIPE_FIELDS}
    out["ingredients"] = [{field: (ing.get(field) or "") for field in _INGREDIENT_FIELDS}
                          for ing in recipe.get("ingredients") or [] if isinstance(ing, dict)]
    steps = [step for step in recipe.get("instructions") or [] if isinstance(step, str)]
    sections = [{"title": section.get("title") or "",
                 "steps": [step for step in section.get("steps") or [] if isinstance(step, str)]}
                for section in recipe.get("sections") or [] if isinstance(section, dict)]
    out["instructions"] = steps
    out["sections"] = sections
    return out


def _count(token):
    with store.mutate(SHARES, {"shares": {}}) as data:
        one = data.setdefault("shares", {}).get(token)
        if one and not one.get("revoked_at"):
            one["views"] = int(one.get("views") or 0) + 1


def open_shared(token, sex=None, age=None, count=False):
    """One shared recipe for a visitor, against their targets; None if the link is closed or unknown."""
    shares = (store.read(SHARES, {"shares": {}}) or {}).get("shares") or {}
    one = _live(shares).get(token)
    recipe = _recipes().get(one["recipe_id"]) if one else None
    if not recipe:
        return None
    if count:
        _count(token)
    worked = recipe_nutrition.for_visitor([recipe["id"]], sex, age).get(recipe["id"])
    return dict(_visible(recipe), token=token, nutrition=worked)


def popular(sex=None, age=None):
    """Every shared recipe in short, most opened first, against the visitor's targets.

    Returns {recipes: [{token, name, servings, per, views, ingredients: [item],
    counted, lines, nutrients: {key: {amount, unit, percent}}, flags}], nutrients:
    [{key, label}], histamine_source}.
    """
    shares = _live((store.read(SHARES, {"shares": {}}) or {}).get("shares") or {})
    recipes = _recipes()
    open_ones = [(token, one) for token, one in shares.items() if one["recipe_id"] in recipes]
    worked = recipe_nutrition.for_visitor([one["recipe_id"] for _, one in open_ones], sex, age)
    out = []
    source = None
    for token, one in open_ones:
        recipe = recipes[one["recipe_id"]]
        nutrition = worked.get(one["recipe_id"])
        if not nutrition:
            continue
        source = nutrition["histamine_source"]
        out.append({
            "token": token, "name": recipe.get("name"), "servings": nutrition["servings"],
            "per": nutrition["per"], "views": int(one.get("views") or 0),
            "ingredients": [ing.get("item") or "" for ing in recipe.get("ingredients") or []
                            if isinstance(ing, dict)],
            "lines": len(nutrition["lines"]),
            "counted": len(nutrition["lines"]) - len(nutrition["not_counted"]),
            "nutrients": {row["key"]: {"amount": row["amount"], "unit": row["unit"],
                                       "percent": recipe_nutrition._percent(row)}
                          for row in nutrition["report"]["nutrients"]},
            "flags": nutrition["flags"]})
    out.sort(key=lambda r: (-r["views"], (r["name"] or "").lower()))
    labels = [{"key": key, "label": label} for key, label, _ in recipe_nutrition.nutrition.TRACKED]
    return {"recipes": out, "nutrients": labels, "histamine_source": source}
