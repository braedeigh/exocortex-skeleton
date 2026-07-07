#!/usr/bin/env python3
"""One-shot seed for the /research page's research.json, from the markdown
corpus in EXOCORTEX_RESEARCH_DIR (Bradie's `personal/research/*.md`).

The corpus has no frontmatter — just `# Title` + an italic date/provenance
line — so the taxonomy below is *curated*, not parsed: topics are lenses she'd
actually reach for, and each file becomes an anchor **note** (the claim-space
handle that pairs with the Library card's full text), plus the **sources**
(URLs) and a few load-bearing **claims** worth stamping with a verdict.

Deliberately NOT seeded here: **questions.** The open-question sections are
mined by routes/research_import.py (Spark's importer, the single question
door) so we don't double-extract. See AGENT-NOTES.md.

Safe + additive: merges into the existing research.json under store.mutate,
so a hand-added entry (or another session's write) is preserved. An anchor/
source/claim we've already seeded (matched on kind+text) is skipped, so
re-running is idempotent. Dry-run by default; --apply writes.

    cd /opt/exocortex/skeleton
    EXOCORTEX_DATA_DIR=/opt/exocortex/personal/data \
    EXOCORTEX_RESEARCH_DIR=/opt/exocortex/personal/research \
        ./venv/bin/python3 scripts/populate_research.py           # dry run
        ./venv/bin/python3 scripts/populate_research.py --apply    # write
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETON = os.path.dirname(HERE)
sys.path.insert(0, SKELETON)

import store  # noqa: E402
from routes.research import _slugify, _unique_id  # noqa: E402

# --- The curated taxonomy -----------------------------------------------------
# status: active = live thread; dormant = real but parked; settled = closed.
TOPICS = [
    ("context-engine", "Context engine & ambient computing", "active"),
    ("gut-microbiome", "Gut microbiome & Long COVID", "active"),
    ("esoterica", "Esoterica & captured threads", "active"),
    ("grocery-product", "Grocery & restricted-diet product", "dormant"),
    ("food-provenance", "Food provenance & traceability", "dormant"),
    ("product-refs", "Product references", "dormant"),
]

# Per source file: the anchor note (essence), which topics it sits under, and
# the file's own date (so `created` reads true in the timeline). `sources` and
# `claims` are optional. Sources: (text, url, verdict) verdict ∈ "" | "verified".
# Claims: (text, verdict) verdict ∈ "" | real | shaky | interesting.
CORPUS = [
    {
        "file": "context_engine_architecture_spec.md",
        "date": "2026-06-07 12:00",
        "topics": ["context-engine"],
        "note": "The exocortex's core as a context-to-surface engine: Signal / Rule / Surface objects, an evaluator loop, adapters, geo+time gating as the first slice. The design reference the app is being built toward.",
    },
    {
        "file": "wearables_signal_taxonomy.md",
        "date": "2026-06-07 12:30",
        "topics": ["context-engine"],
        "note": "Taxonomy of wearable/ambient signals mapped to integration-readiness — biosensors, activity, location, environmental, smart-home, AR display. Deep-research pass: 107 agents, 25 claims adversarially verified, 0 killed.",
        "sources": [
            ("Samsung Health Sensor SDK", "https://developer.samsung.com/health/sensor/faq.html", "verified"),
            ("Android Health Connect — sync data", "https://developer.android.com/health-and-fitness/health-connect/sync-data", "verified"),
            ("Apple CoreLocation geofencing / CLMonitor", "https://developer.apple.com/documentation/corelocation", "verified"),
            ("Home Assistant WebSocket API", "https://developers.home-assistant.io/docs/api/websocket", "verified"),
            ("Matter device data model", "https://developers.home.google.com/matter/primer/device-data-model", "verified"),
            ("Meta Wearables Device Access Toolkit", "https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit", "verified"),
            ("Caltech \"Stressomic\" sweat biosensor (Science Advances 2025)", "https://pmc.ncbi.nlm.nih.gov/articles/PMC12327446", "verified"),
        ],
    },
    {
        "file": "ar_cognitive_prosthetic.md",
        "date": "2026-04-18 12:00",
        "topics": ["context-engine"],
        "note": "Smart glasses as a neurotype-adaptive cognitive prosthetic — ADHD / anxiety-OCD / autism / depression modes riding one shared prediction engine. The April seed of what became the context engine.",
    },
    {
        "file": "gut_microbiome_long_covid.md",
        "date": "2026-06-26 16:25",
        "topics": ["gut-microbiome"],
        "note": "Gut→brain axis in Long COVID, tied to my own MCAS/gut n=1. From @Neuroscope_mp tweets — single source, verify against the Lancet paper before treating as settled.",
        "claims": [
            ("SIM01 synbiotic RCT (Lancet Infect Dis 2024, N=463): the gut treatment alleviated the cognitive/fatigue symptoms — concentration 62% vs 39%, fatigue 63% vs 43% — but not pulmonary. \"The gut fixed the brain symptoms, not the lungs.\"", "real"),
            ("F. prausnitzii (a butyrate producer) drops across all COVID phases and, tellingly, recovered patients get it back while Long COVID patients don't — suggesting it's load-bearing, not just a marker.", "interesting"),
            ("If the mechanism is \"the Long COVID gut won't re-seed F. prausnitzii on its own,\" FMT is the brute-force re-seed (cf. Josie Zayner) — worth chasing.", "shaky"),
        ],
    },
    {
        "file": "egregore_thread_psychic_framerate.md",
        "date": "2026-07-04 12:00",
        "topics": ["esoterica"],
        "note": "Archived 4chan /x/ thread reframing psychic ability as perceptual-framerate training, kept with a skeptical load-bearing-vs-not read. Cites Daniel Ingram's Mastering the Core Teachings of the Buddha.",
        "claims": [
            ("OP's framing — \"psychic ability is just training your perceptual framerate higher\" — as literal capability.", "shaky"),
            ("The load-bearing kernel worth keeping: attention/perception is trainable and its resolution varies, independent of the thread's metaphysics.", "interesting"),
        ],
    },
    {
        "file": "food_provenance_blockchain.md",
        "date": "2026-06-16 12:00",
        "topics": ["food-provenance"],
        "note": "Food-provenance blockchain traceability, framed around an SGTM (penny-stock) pitch via \"Mike,\" with a skeptical reality-check: the oracle problem is the whole game — a chain can't verify what the satellite/sensor can't see.",
        "sources": [
            ("SGTM / Sustainable Green Team", "https://sgtmtech.com/", ""),
            ("IBM Food Trust expands blockchain network", "https://newsroom.ibm.com/2018-10-08-IBM-Food-Trust-Expands-Blockchain-Network", ""),
            ("Chainlink — the oracle problem", "https://chain.link/education-hub/oracle-problem", "verified"),
            ("NCA — blockchain beef", "https://nca.org/article/blockchain-beef", ""),
            ("GS1 EPCIS end-to-end traceability", "https://tracextech.com/gs1-epcis-end-to-end-traceability/", ""),
        ],
        "claims": [
            ("Blockchain traceability's hard problem isn't the ledger, it's the oracle: garbage in at the farm gate is still garbage, immutably. The demo can look real while proving nothing.", "real"),
        ],
    },
    {
        "file": "food_data_sources.md",
        "date": "2026-04-18 12:30",
        "topics": ["grocery-product"],
        "note": "Catalog of food/nutrition datasets with a build order — USDA FoodData Central first, then SIGHI histamine, EWG/PDP pesticides, Open Food Facts, EFSA OpenFoodTox, Poore & Nemecek.",
        "sources": [
            ("USDA FoodData Central — ~380k foods, full nutrient composition (first integration)", "https://fdc.nal.usda.gov/", ""),
            ("SIGHI histamine list — ~300 foods rated 0–3 (high personal value for MCAS)", "https://www.histaminintoleranz.ch/en/introduction.html", ""),
            ("Open Food Facts — ~3M products, barcodes, Nutri-Score, NOVA", "https://world.openfoodfacts.org/", ""),
        ],
    },
    {
        "file": "grocery_landscape.md",
        "date": "2026-04-18 13:00",
        "topics": ["grocery-product"],
        "note": "Competitive landscape of grocery/pantry AI apps (Frooty, Instacart, Mealime, AnyList, Grocy) plus the grocy-predict companion-project scoping. \"What to steal / what we have / the gap.\"",
    },
    {
        "file": "shipping_plan.md",
        "date": "2026-04-18 13:30",
        "topics": ["grocery-product"],
        "note": "Productization plan for a restricted-diet grocery + symptom tracker — target market, revenue targets, must/should/don't-need checklists, tech stack, build order.",
    },
    {
        "file": "ar_grocery_vision.md",
        "date": "2026-04-18 14:00",
        "topics": ["grocery-product"],
        "note": "The \"manual list → auto-predicted → AR overlay\" arc for grocery: what the glasses would do in-store, and what has to exist first.",
    },
    {
        "file": "product-references/skylight-calendar.md",
        "date": "2026-07-06 12:00",
        "topics": ["product-refs"],
        "note": "Skylight — touchscreen kitchen-wall calendar/chore/meal-plan device (~$160–300). Status: considering; moved off the buy-list as a reference rather than an active buy.",
    },
    {
        "file": "references.md",
        "date": "2026-04-23 12:00",
        "topics": [],  # deliberately UNFILED — exercises the Unfiled backstop
        "note": "Bookmarks file — tagged tools/sites/resources. First entry: Paul Ekman Group (FACS / micro-expressions), a candidate for the AR facial-expression-reading layer.",
        "sources": [
            ("Paul Ekman Group — FACS micro-expression training (AR expression-reading candidate)", "https://paulekman.com", ""),
        ],
    },
]


def _entry(kind, text, created, topics, url="", verdict=""):
    return {
        "id": None,  # assigned at merge time, keyed to the file's date
        "kind": kind,
        "text": text,
        "topics": list(topics),
        "url": url,
        "verdict": verdict,
        "status": "",  # no questions seeded here → never "open"
        "reply_to": None,
        "created": created,
    }


def build_entries():
    """Flatten CORPUS into anchor-note / source / claim entries (no questions)."""
    entries = []
    for item in CORPUS:
        topics = item["topics"]
        created = item["date"]
        fname = os.path.basename(item["file"])
        entries.append(_entry("note", f"📄 {fname} — {item['note']}", created, topics))
        for text, url, verdict in item.get("sources", []):
            entries.append(_entry("source", text, created, topics, url=url, verdict=verdict))
        for text, verdict in item.get("claims", []):
            entries.append(_entry("claim", text, created, topics, verdict=verdict))
    return entries


def _entry_key(e):
    return (e["kind"], (e.get("text") or "").strip())


def _date_to_id(created):
    """`2026-06-07 12:00` -> `2026-06-07.1200` (the schema's entry-id shape)."""
    date, _, time = created.partition(" ")
    return f"{date}.{(time or '0000').replace(':', '')}"


def main():
    apply = "--apply" in sys.argv
    new_topics = [{"id": tid, "name": name, "status": status, "created": "2026-07-06 23:00"}
                  for tid, name, status in TOPICS]
    new_entries = build_entries()

    print(f"research.json  DATA_DIR={store.DATA_DIR}  RESEARCH_DIR={store.RESEARCH_DIR}")
    existing = store.read("research.json", {"topics": [], "entries": []})
    have_topic_ids = {t["id"] for t in existing.get("topics", [])}
    have_entry_keys = {_entry_key(e) for e in existing.get("entries", [])}

    topics_to_add = [t for t in new_topics if t["id"] not in have_topic_ids]
    entries_to_add = [e for e in new_entries if _entry_key(e) not in have_entry_keys]

    print(f"\nTopics: {len(existing.get('topics', []))} existing, "
          f"+{len(topics_to_add)} new ({len(new_topics) - len(topics_to_add)} already present)")
    for t in topics_to_add:
        print(f"  + {t['id']:16} {t['status']:8} {t['name']}")

    from collections import Counter
    kinds = Counter(e["kind"] for e in entries_to_add)
    print(f"\nEntries: {len(existing.get('entries', []))} existing, +{len(entries_to_add)} new "
          f"({dict(kinds)}); {len(new_entries) - len(entries_to_add)} already present")
    for e in entries_to_add:
        tag = ",".join(e["topics"]) or "UNFILED"
        print(f"  + [{e['kind']:8}] ({tag}) {e['text'][:72]}")

    if not apply:
        print("\n(dry run — pass --apply to write)")
        return

    with store.mutate("research.json", {"topics": [], "entries": []}) as data:
        topics = data.setdefault("topics", [])
        entries = data.setdefault("entries", [])
        have_tids = {t["id"] for t in topics}
        have_keys = {_entry_key(e) for e in entries}
        taken_eids = {e["id"] for e in entries}

        for t in new_topics:
            if t["id"] not in have_tids:
                topics.append(t)
                have_tids.add(t["id"])

        for e in new_entries:
            if _entry_key(e) in have_keys:
                continue
            e = dict(e)
            e["id"] = _unique_id(_date_to_id(e["created"]), taken_eids)
            taken_eids.add(e["id"])
            entries.append(e)
            have_keys.add(_entry_key(e))

    print(f"\n✓ wrote research.json — now {len(data['topics'])} topics, {len(data['entries'])} entries")


if __name__ == "__main__":
    main()
