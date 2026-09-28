# Verifiable exposure — buy-organic verdicts anyone can recompute

The buy-organic verdict for a food is a **calculation from public data**, shown with its
working, not a judgment someone wrote. Anyone can take the same USDA file and the same EPA
safe doses and get the same number. Claude writes plain words; the numbers and verdicts come
from code applying a published method.

## Where each piece lives

| Piece | Where | Why there |
|---|---|---|
| The public files (USDA PDP zips, EPA pages, PDFs) | the commons, via `scripts/commons_fetch.py` | Public, big, kept exactly as published ([projects.md](projects.md)) |
| Rows parsed out of them (every sample, every result) | `commons.db` beside the files (`commonsdb.py`) | Derived and rebuildable; too big for the daily-backed-up exo.db |
| Contaminant facts (CAS, safe dose, cancer rating, health effects), each sourced and reviewed | `hazard_facts` in exo.db (`exposurestore.py`) | Her record; backed up with the hazard tables |
| Which PDP commodity a food is | `food_pdp_codes` | Her record |
| What has been pulled (the memory) | `data_pulls` | One glance says what exists; pulling again is a no-op |
| Computed scores and their working | `exposure_scores`, `exposure_terms` | Derived; a re-score replaces them |
| A source's PDF, and the page each passage is on | `source_files`, `passage_pages` | So a claim's PDF opens at its highlight |

The literature numbers (a study's mean lead in rice) stay in `hazard_measures`, reviewed like
everything else there. Computed PDP numbers do not go there: they have dimensions it lacks
(organic vs conventional, sample counts per pesticide, a method version), and they are
rebuildable from the commons, so they don't need her review queue.

## The method (dri-v1)

Benbrook's Dietary Risk Index (Environmental Health 2020, PMC7557078), per food × pesticide:

    DRI = mean residue (mg/kg, over ALL samples tested, non-detect = 0) × serving (kg)
          ÷ body weight (kg) ÷ chronic safe dose (cRfD, or cPAD where FQPA applies; mg/kg/day)

Reference person: the paper's child, 16 kg; the serving is two-thirds of FDA's reference amount.
Verdict bands, per food:

- any pesticide over 0.1 → buy organic
- largest between 0.01 and 0.1 → organic helps some
- all at 0.01 or under → conventional is fine
- a pesticide found with no safe dose, which could push it over a line → open question

Beside the verdict, as a second fact: whether residues sit under the organic rule's line
(7 CFR 205.671: product with a prohibited residue over 5% of the EPA tolerance can't be sold as
organic). Tolerances come from the PDP zip's own reference table.

The headline is the most recent year a food was tested, with the year shown; other years can be
combined. The sample count is always shown.

**The honest limit, kept on the page:** this measures exposure against a safety reference, not
health outcomes. EPA *tolerances* are legal limits, not health lines, and are never the safety
line here. EWG's and Consumer Reports' rankings are shown only as a sanity check.

**What others found (the sanity check).** A published ranking of a food — EWG's Dirty Dozen
place, a Consumer Reports risk rating — is a research claim (measure `pesticide ranking`, the
food's name as subject, the ranker in its extra), linked to the article with the passage that
says it highlighted. The food page's card lists them under "What others found", quoted, and they
never enter the score. `reference_data.py ranking` records one: it fetches the article's text,
and refuses unless the passage is found in it. ewg.org refuses downloads, so EWG's list is read
from a reprint that says so in its note. Consumer Reports worked with Benbrook, whose index this
app uses, so its agreement is expected rather than independent; EWG ranks residue amount and
count, not dose.

## Running it

    venv/bin/python3 scripts/reference_data.py pdp-code potatoes PO     # which PDP commodity a food is
    venv/bin/python3 scripts/reference_data.py pull-pdp --year 2024 --food potatoes
    venv/bin/python3 scripts/reference_data.py load-epa                 # EPA benchmark table
    venv/bin/python3 scripts/reference_data.py load-iris                # IRIS reference doses
    venv/bin/python3 scripts/reference_data.py score --food potatoes    # latest year + all years
    venv/bin/python3 scripts/reference_data.py fetch-pdf --all          # sources' PDFs + passage pages
    venv/bin/python3 scripts/reference_data.py ledger
    venv/bin/python3 scripts/reference_data.py ranking kale --by EWG --claim conventional \
        --label "Dirty Dozen #2" --rank 2 --year 2026 --topic <topic> --url <article> \
        --title "<citation>" --passage "<the article's exact words>"

The page side: every food page has a pesticide residues card (features/exposure/ExposureCard.tsx),
each contaminant has a page at /food/contaminants/<id>, and the Claims page opens a source's PDF at
its highlighted passage (features/exposure/PdfPassage.tsx). Wherever else a study is listed — a
food page's evidence, a number's detail in the tables view — a "📄 PDF" button
(features/exposure/SourcePdf.tsx) opens the same viewer beside it, at the passage that backs the
number, when the commons holds that study's PDF.

## Known gaps

- **Where a chronic dose comes from, in order.** Her own `chronic_dose` fact always wins; a
  disputed one never counts. Otherwise the score uses EPA's benchmark table (the pesticide
  office's current cPAD/cRfD), and only where that table has no chronic dose, EPA IRIS's oral
  reference dose (`load-iris`, matched by the benchmark's CAS number or by name, fact basis
  "RfD (IRIS)"). IRIS figures are often decades old and can be stricter or looser than the
  pesticide office's current one (IRIS cypermethrin is 0.01, which makes it kale's top term).
  A name IRIS files differently (DCPA is IRIS's "Dacthal") goes in as an agent `fact` citing the
  IRIS page. A mixture is never matched to one isomer (technical chlordane ≠ cis-chlordane).
- **EPA's benchmark table is built for drinking water.** It has no chronic dose for most
  pyrethroids (lambda-cyhalothrin, deltamethrin, esfenvalerate …) and leaves out others
  (chlorpyrifos, diazinon, ametoctradin); IRIS covers some (cypermethrin, bifenthrin, DDT,
  dieldrin, malathion, carbaryl). A food where one still missing is found scores as an open
  question until a sourced `chronic_dose` fact is added (EPA's risk assessment or a Federal
  Register tolerance rule for that chemical) and the food is scored again. Where EPA's pesticide
  office sets only a steady-state dose (ssPAD — diazinon, chlorpyrifos, which take the lowest
  population's), or where only another agency has a figure (ATSDR's MRL for p,p'-DDE), the fact
  says so in its basis and its note carries the quote and URL — it's a judgment, not EPA's cPAD.
- **Agency figures aren't taken on trust.** Where EPA says it sets no chronic limit (the acute
  dose already covers it: lambda-cyhalothrin, deltamethrin, esfenvalerate; or no endpoints at all:
  ametoctradin), that goes in as a `no_chronic_limit` fact carrying EPA's own sentence. The food
  page shows it beside the pesticide, but it is never a dose: the verdict stays open. Every
  contaminant page says **Needs more research** until she has marked a study from outside the
  agencies useful (`exposurestore.research_state`). See "Combing the studies" below.

## Combing the studies (beyond the agencies)

An agent finds the studies about a contaminant and writes a plain summary of each; she judges
whether each one is useful. The door is `scripts/literature.py`:

    venv/bin/python3 scripts/literature.py progress                       # what's left, in order
    venv/bin/python3 scripts/literature.py search Deltamethrin "deltamethrin[tiab] AND toxicity"
    venv/bin/python3 scripts/literature.py study 31841155 --topic <research topic>
    venv/bin/python3 scripts/literature.py finding Deltamethrin <source id> "what it found" \
        --study-type animal --leaning "found harm" --passage "the study's exact words"

- **Any related study counts** — in vitro, animal, human, reviews — and a study that finds harm
  goes in as surely as one that finds none. The leaning is in the finding's basis
  ("animal · found harm") so she can scan them.
- **A study is a research source** whose text is its PubMed record: citation, publication type,
  funding and conflicts of interest (so she can weigh who paid for it), then the abstract. Most
  findings are read from the abstract alone; a note says so where it matters.
- **Every finding quotes the study.** Its passage must be found in the source's text or nothing is
  written; it is highlighted there, and where the source's address is a PDF, `fetch-pdf` places
  it on the page and the contaminant page's "📄 PDF" button opens it.
- **Only her judgment lifts "needs research."** An agent's finding arrives unreviewed ("waiting
  for you to judge"); ✓ Useful confirms it, ✗ Not useful disputes it. Findings never become a
  dose — a study's no-effect level stays in the finding's words for her to act on.
- **Every search is remembered** in the pull ledger (dataset `literature`, one row per
  contaminant × database × query), shown on the contaminant page, so no one repeats one blind.
- Order: the pesticides EPA sets no chronic limit for, then the largest share of a safe dose.
- **Metabolites are never matched to their parent** (clethodim sulfoxide ≠ clethodim): whether
  the parent's dose covers them is a judgment, recorded as a fact.
- **Serving sizes** use the general FDA categories (85 g vegetables, 140 g fruit); a food with no
  entry in `exposure.RACC_GRAMS` isn't scored.
- **Organic sample counts are small** (4 to 90 a year); the page says so under 30.
