"""Recipes: the parse pipeline (URL or photo → Claude in the 'recipes' tmux
session → parsed/*.parsed.json → review/save), saved-recipe CRUD with variant
lineage (parent_id chains, archive-on-variant), and push-to-grocery-list.
"""
import json
import uuid
from datetime import datetime
from pathlib import Path

from flask import request, jsonify

from data_helpers import RECIPES_DIR
import store
from . import shared
from routes import helpers

RECIPES_URLS_DIR = RECIPES_DIR / "urls"
RECIPES_IMAGES_DIR = RECIPES_DIR / "images"
RECIPES_PARSED_DIR = RECIPES_DIR / "parsed"
RECIPES_ALL_DIRS = (RECIPES_DIR, RECIPES_URLS_DIR, RECIPES_IMAGES_DIR, RECIPES_PARSED_DIR)


def _load_recipes():
    return store.read("recipes.json", {"recipes": []})


def _save_recipes(d):
    store.write("recipes.json", d)


def _ing_stocking_status(ing):
    """Return 'n_a' | 'usually_have' | None. Handles new + legacy schemas."""
    st = (ing.get("stocking_status") or "").strip().lower()
    if st in ("n_a", "usually_have"):
        return st
    # Legacy: status was stored in the category field
    cat = (ing.get("category") or "").strip().lower()
    if cat in ("n_a", "usually_have"):
        return cat
    return None


def _ing_store_category(ing):
    """The actual store section. Falls back to 'other' if legacy data used the
    category slot for stocking status instead."""
    cat = (ing.get("category") or "").strip().lower()
    if cat in ("n_a", "usually_have"):
        return "other"
    return cat or "other"


def _recipe_brief(job, out_path):
    """The brief hands the session to the recipe skill (RECIPES_DIR/CLAUDE.md,
    in the vault) and names the one job and the one output file."""
    return (
        "# Recipe parse\n\n## Protocol\n\n"
        f"1. Read `{RECIPES_DIR / 'CLAUDE.md'}` — it is the skill; follow its "
        "parsing rules and output format exactly.\n"
        f"2. Job: {job}.\n"
        f"3. Write the result to `{out_path}`, then stop. Nobody is waiting to "
        "chat — if the source can't be parsed, write nothing and say why.\n"
    )


def register(app):

    @app.route("/api/kitchen/parse-recipe-url", methods=["POST"])
    def parse_recipe_url():
        body = request.json or {}
        url = (body.get("url") or "").strip()
        if not url:
            return jsonify({"error": "Empty URL"}), 400
        ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        slug = shared.slug(url.replace("https://", "").replace("http://", ""))[:30] or "recipe"
        fname = f"{ts}-{slug}.url.json"
        RECIPES_URLS_DIR.mkdir(parents=True, exist_ok=True)
        target = RECIPES_URLS_DIR / fname
        target.write_text(json.dumps({"url": url, "submitted_at": datetime.now().isoformat()}, indent=2))
        shared.chmod_for_claude(RECIPES_URLS_DIR)
        shared.chmod_for_claude(RECIPES_PARSED_DIR)
        shared.chmod_for_claude(target)

        # One Reading Room session per submission (routes/helpers.py): the
        # job is fire-and-forget, and a fresh session per job is what makes
        # each parse its own card in the Helpers room. Paths are ABSOLUTE —
        # the session stands at the root of both repos, not in RECIPES_DIR.
        payload, status = helpers.mint_helper(
            "recipe", f"recipe-{ts}"[:39],
            _recipe_brief(f"fetch and parse the recipe URL in `{target}`",
                          RECIPES_PARSED_DIR / f"{ts}-{slug}.parsed.json"),
            f"Recipe: {slug}")
        if status != 200:
            return jsonify(payload), status
        return jsonify(dict(payload, filename=fname))

    @app.route("/api/kitchen/scan-recipe", methods=["POST"])
    def scan_recipe():
        if "photo" not in request.files:
            return jsonify({"error": "No photo uploaded"}), 400
        f = request.files["photo"]
        if not f.filename:
            return jsonify({"error": "Empty filename"}), 400
        ext = Path(f.filename).suffix.lower() or ".jpg"
        if ext not in {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".pdf"}:
            return jsonify({"error": f"Unsupported extension: {ext}"}), 400
        ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        fname = f"{ts}-recipe{ext}"
        RECIPES_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        target = RECIPES_IMAGES_DIR / fname
        f.save(str(target))
        shared.chmod_for_claude(RECIPES_IMAGES_DIR)
        shared.chmod_for_claude(RECIPES_PARSED_DIR)
        shared.chmod_for_claude(target)

        payload, status = helpers.mint_helper(
            "recipe", f"recipe-{ts}"[:39],
            _recipe_brief(f"parse the recipe photo at `{target}`",
                          RECIPES_PARSED_DIR / f"{fname}.parsed.json"),
            f"Recipe photo {ts}")
        if status != 200:
            return jsonify(payload), status
        return jsonify(dict(payload, filename=fname))

    @app.route("/api/kitchen/parsed-recipes/list")
    def list_parsed_recipes():
        results = []
        if not RECIPES_PARSED_DIR.exists():
            return jsonify({"recipes": results})
        for parsed in sorted(RECIPES_PARSED_DIR.glob("*.parsed.json")):
            try:
                pdata = json.loads(parsed.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            results.append({
                "filename": parsed.name,
                "name": pdata.get("name", ""),
                "source_url": pdata.get("source_url"),
                "source_image": pdata.get("source_image"),
                "ingredients_count": len(pdata.get("ingredients", [])),
                "servings": pdata.get("servings"),
                "parse_error": pdata.get("parse_error"),
            })
        return jsonify({"recipes": results})

    @app.route("/api/kitchen/parsed-recipes/preview", methods=["POST"])
    def preview_parsed_recipe():
        body = request.json or {}
        filename = body.get("filename", "")
        path = RECIPES_PARSED_DIR / filename
        try:
            if not path.exists() or not str(path.resolve()).startswith(str(RECIPES_PARSED_DIR.resolve())):
                return jsonify({"error": "File not found"}), 404
        except OSError:
            return jsonify({"error": "File not found"}), 404
        return jsonify(json.loads(path.read_text()))

    @app.route("/api/kitchen/parsed-recipes/discard", methods=["POST"])
    def discard_parsed_recipe():
        body = request.json or {}
        filename = body.get("filename", "")
        path = RECIPES_PARSED_DIR / filename
        try:
            if path.exists() and str(path.resolve()).startswith(str(RECIPES_PARSED_DIR.resolve())):
                path.unlink()
        except OSError:
            return jsonify({"error": "Could not delete"}), 500
        return jsonify({"ok": True})

    @app.route("/api/kitchen/recipes/save", methods=["POST"])
    def save_recipe():
        body = request.json or {}
        filename = (body.get("parsed_filename") or "").strip()
        recipe = body.get("recipe") or {}
        if not recipe.get("name"):
            return jsonify({"error": "Missing recipe name"}), 400
        rid = recipe.get("id") or uuid.uuid4().hex[:12]
        recipe["id"] = rid
        recipe.setdefault("created", datetime.now().strftime("%Y-%m-%d"))
        data = _load_recipes()
        # Upsert. Preserve parent_id and is_archived from the stored row if the
        # frontend didn't send them — those fields aren't editable in the form.
        existing = next((r for r in data["recipes"] if r.get("id") == rid), None)
        if existing:
            if "parent_id" not in recipe:
                recipe["parent_id"] = existing.get("parent_id")
            if "is_archived" not in recipe:
                recipe["is_archived"] = existing.get("is_archived", False)
            data["recipes"] = [recipe if r.get("id") == rid else r for r in data["recipes"]]
        else:
            data["recipes"].append(recipe)
        _save_recipes(data)
        # Clean up the parsed file
        if filename:
            path = RECIPES_PARSED_DIR / filename
            try:
                if path.exists() and str(path.resolve()).startswith(str(RECIPES_PARSED_DIR.resolve())):
                    path.unlink()
            except OSError:
                pass
        return jsonify({"ok": True, "id": rid})

    @app.route("/api/kitchen/recipes/remove", methods=["POST"])
    def remove_recipe():
        body = request.json or {}
        rid = body.get("id")
        data = _load_recipes()
        target = next((r for r in data["recipes"] if r.get("id") == rid), None)
        if not target:
            return jsonify({"ok": True})  # idempotent
        target_parent_id = target.get("parent_id")
        was_active = not target.get("is_archived", False)
        # Re-stitch the chain: anything pointing at us now points at our parent
        for r in data["recipes"]:
            if r.get("parent_id") == rid:
                r["parent_id"] = target_parent_id
        data["recipes"] = [r for r in data["recipes"] if r.get("id") != rid]
        # If we deleted the active head of a chain, promote our parent back to active
        if was_active and target_parent_id:
            parent = next((r for r in data["recipes"] if r.get("id") == target_parent_id), None)
            if parent:
                parent["is_archived"] = False
        _save_recipes(data)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/recipes/save-as-variant", methods=["POST"])
    def save_recipe_as_variant():
        """Archive the parent recipe and create a new variant with parent_id pointing to it."""
        body = request.json or {}
        recipe = body.get("recipe") or {}
        parent_id = recipe.get("id")
        if not recipe.get("name"):
            return jsonify({"error": "Missing recipe name"}), 400
        if not parent_id:
            return jsonify({"error": "Missing parent id"}), 400
        data = _load_recipes()
        parent = next((r for r in data["recipes"] if r.get("id") == parent_id), None)
        if not parent:
            return jsonify({"error": "Parent recipe not found"}), 404
        # Archive the parent
        parent["is_archived"] = True
        # Mint a new id for the variant; carry the user's edits
        new_id = uuid.uuid4().hex[:12]
        recipe["id"] = new_id
        recipe["parent_id"] = parent_id
        recipe["is_archived"] = False
        recipe["created"] = datetime.now().strftime("%Y-%m-%d")
        data["recipes"].append(recipe)
        _save_recipes(data)
        return jsonify({"ok": True, "id": new_id})

    @app.route("/api/kitchen/recipes/my-notes/save", methods=["POST"])
    def save_recipe_my_notes():
        body = request.json or {}
        rid = body.get("id")
        text = (body.get("my_notes") or "").strip()
        if not rid:
            return jsonify({"error": "missing id"}), 400
        data = _load_recipes()
        found = False
        for r in data["recipes"]:
            if r.get("id") == rid:
                r["my_notes"] = text
                found = True
                break
        if not found:
            return jsonify({"error": "recipe not found"}), 404
        _save_recipes(data)
        return jsonify({"ok": True})

    @app.route("/api/kitchen/recipes/to-grocery", methods=["POST"])
    def recipe_to_grocery():
        body = request.json or {}
        rid = body.get("id")
        skip_set = {str(s).strip().lower() for s in (body.get("skip") or [])}
        # picks: {group_id: [member_name, ...]} — which choice-group members were selected
        picks = body.get("picks") or {}
        data = _load_recipes()
        recipe = next((r for r in data["recipes"] if r.get("id") == rid), None)
        if not recipe:
            return jsonify({"error": "Recipe not found"}), 404

        # Build a lookup: ingredient_name_lower -> group_id (if it's a group member)
        # And: selected set of names (any group member selected via picks)
        groups = recipe.get("choice_groups") or []
        member_to_group = {}
        selected_members = set()
        for g in groups:
            gid = str(g.get("id") or "")
            for m in (g.get("members") or []):
                member_to_group[m.lower().strip()] = gid
            for m in (picks.get(gid) or []):
                selected_members.add(str(m).lower().strip())

        gdata = store.read("kitchen.json", {"items": [], "category_map": {}})
        cat_map = gdata.setdefault("category_map", {})
        existing = {i["name"].lower() for i in gdata.get("items", [])}
        rules = shared.load_grocery_rules()

        added = 0
        skipped_existing = 0
        skipped_unchecked = 0
        skipped_na = 0
        skipped_unpicked = 0
        for ing in recipe.get("ingredients", []):
            name = (ing.get("item") or "").strip()
            if not name:
                continue
            name_lower = name.lower()
            # N/A: always skipped
            if _ing_stocking_status(ing) == "n_a":
                skipped_na += 1
                continue
            # Group member: skip unless it was picked this round
            if name_lower in member_to_group:
                if name_lower not in selected_members:
                    skipped_unpicked += 1
                    continue
            if name_lower in skip_set:
                skipped_unchecked += 1
                continue
            # Catalog mapping
            mapped_cat, mapped_name = shared.categorize_grocery_item(name, rules, cat_map)
            canonical_name = (mapped_name or "").strip() or name
            canonical_cat = (mapped_cat or "").strip() or _ing_store_category(ing)
            display = canonical_name[:1].upper() + canonical_name[1:]
            if display.lower() in existing:
                skipped_existing += 1
                continue
            cat_map[display.lower()] = canonical_cat
            note = (ing.get("qty") or "").strip()
            gdata["items"].append({"name": display, "category": canonical_cat, "checked": False, "note": note})
            existing.add(display.lower())
            added += 1
        store.write("kitchen.json", gdata)

        # Remember this push's picks on the recipe so next time we can pre-select them
        if picks:
            recipe["last_picks"] = picks
            _save_recipes(data)

        return jsonify({
            "ok": True,
            "added": added,
            "skipped_already_on_list": skipped_existing,
            "skipped_unchecked": skipped_unchecked,
            "skipped_na": skipped_na,
            "skipped_unpicked": skipped_unpicked,
        })
