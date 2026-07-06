"""Person pages — the deep, single-person view (as opposed to the lightweight
roster/chips that `routes/entities.py`'s `/api/people` feeds elsewhere).

Two tiers:
  1. `/api/people` (entities.py) — the roster: names, tags, aliases. Cheap,
     used for the journal highlighter and tag filters.
  2. This module — one person's whole picture: their blurb + Impression
     narrative + `body` (for rendering the file's prose), a day-by-day mention
     timeline, and the loose mentions list. Plus a "regenerate impression"
     button that opens a Claude session (same pattern as routes/triage.py) to
     draft the `## Impression` section with her, live, before it's saved.

All vault parsing (frontmatter, blurb/impression extraction, mention counting)
lives in entities.py — this module only orchestrates: resolve -> assemble ->
respond. See dev_todo.md's rule against a 4th independent people-file parser.
"""
from flask import jsonify, render_template, request

import store
from routes import entities
from routes.kitchen import shared


def register(app):
    @app.route("/person/<slug>")
    def person_page(slug):
        if entities.resolve_person(slug) is None:
            return "Not found", 404
        return render_template("person.html", slug=slug)

    @app.route("/api/person/<slug>")
    def person_api(slug):
        person = entities.resolve_person(slug)
        if person is None:
            return jsonify({"error": "not found"}), 404
        terms = [person["name"].split()[0]] + person.get("aliases", [])
        mentions = entities.find_mentions(terms, self_file=person["file"])
        days = entities.mention_days(person)
        stats = entities.person_stats(person, days, mentions)
        # The rendered card view (people/views/<slug>.md, tag-selected verbatim
        # cards) is derived — find_mentions deliberately doesn't scan it (it
        # would double-count every card), so its existence is reported here.
        views_rel = f"people/views/{person['id']}.md"
        card_view = views_rel if (store.CONTENT_DIR / views_rel).exists() else None
        return jsonify({
            "person": person,
            "stats": stats,
            "days": days,
            "mentions": mentions,
            "card_view": card_view,
        })

    @app.route("/api/person/<slug>/summarize", methods=["POST"])
    def person_summarize(slug):
        person = entities.resolve_person(slug)
        if person is None:
            return jsonify({"error": "not found"}), 404
        # Same session-spawning pattern as triage: a named tmux session running
        # Claude Code, cwd'd into the skill folder so it boots with the right
        # CLAUDE.md loaded; the frontend deep-links to /phone?session=person.
        newly = shared.ensure_claude_session(
            "person", store.PERSON_SKILL_DIR, dirs=(store.PERSON_SKILL_DIR,),
        )
        prompt = (
            f"Update the Impression for {person['name']} — their file is "
            f"{store.CONTENT_DIR / person['file']}. Read it and all their journal mentions, "
            f"draft the ## Impression section as a biographical fact-sheet "
            f"(dated facts about who they are — not what Bradie feels about them), "
            f"and talk it through with Bradie before saving."
        )
        shared.send_prompt("person", prompt)
        return jsonify({"ok": True, "session": "person", "newly_spawned": newly})

    @app.route("/api/person/<slug>/facts", methods=["POST"])
    def person_facts(slug):
        import re, fcntl

        person = entities.resolve_person(slug)
        if person is None:
            return jsonify({"error": "not found"}), 404

        body = request.get_json(silent=True)
        if body is None or "facts" not in body:
            return jsonify({"error": "missing facts"}), 400

        new_facts = body["facts"]
        if not isinstance(new_facts, dict):
            return jsonify({"error": "facts must be an object"}), 400

        KEY_RE = re.compile(r'^[a-z0-9_ -]{1,40}$', re.IGNORECASE)
        RESERVED = {"tags", "aliases"}

        for k, v in new_facts.items():
            if not KEY_RE.match(k):
                return jsonify({"error": f"invalid key: {k!r}"}), 400
            if k.lower() in RESERVED:
                return jsonify({"error": f"reserved key: {k!r}"}), 400
            if not isinstance(v, str):
                return jsonify({"error": f"value for {k!r} must be a string"}), 400
            if "\n" in v:
                return jsonify({"error": f"value for {k!r} contains newline"}), 400

        file_path = store.CONTENT_DIR / person["file"]
        lock_path = file_path.with_suffix(file_path.suffix + ".lock")

        with open(lock_path, "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)

            raw = file_path.read_text()
            meta, body_text = entities._parse_frontmatter(raw)

            # Build the updated facts: start with existing facts, apply new values
            # (empty/whitespace-only = remove)
            SEED_ORDER = ["relationship", "age", "lives", "work"]
            # A pre-existing fact whose value held a comma parsed as a list —
            # normalize back to the string she wrote so it round-trips.
            existing_facts = {
                k: (", ".join(v) if isinstance(v, list) else str(v))
                for k, v in meta.items() if k not in {"tags", "aliases"}
            }

            # Apply changes from submitted facts
            updated_facts = dict(existing_facts)
            for k, v in new_facts.items():
                k_lower = k.lower()
                if v.strip() == "":
                    updated_facts.pop(k_lower, None)
                else:
                    updated_facts[k_lower] = v.strip()

            # Re-serialize frontmatter: tags, aliases, then facts in seed order + remaining
            lines = ["---"]

            tags = meta.get("tags", [])
            if isinstance(tags, list) and tags:
                lines.append(f"tags: [{', '.join(tags)}]")

            aliases = meta.get("aliases", [])
            if isinstance(aliases, list) and aliases:
                lines.append(f"aliases: [{', '.join(aliases)}]")

            # Output facts in seed order first, then any others in submitted order
            output_facts = {}
            for key in SEED_ORDER:
                if key in updated_facts:
                    output_facts[key] = updated_facts[key]
            # Add remaining keys in submitted order (from new_facts), then any others
            seen = set(output_facts.keys())
            for k in new_facts:
                k_lower = k.lower()
                if k_lower in updated_facts and k_lower not in seen:
                    output_facts[k_lower] = updated_facts[k_lower]
                    seen.add(k_lower)
            for k, v in updated_facts.items():
                if k not in seen:
                    output_facts[k] = v

            for k, v in output_facts.items():
                lines.append(f"{k}: {v}")

            lines.append("---")

            new_raw = "\n".join(lines) + "\n" + body_text
            file_path.write_text(new_raw)

        return jsonify({"facts": output_facts})
