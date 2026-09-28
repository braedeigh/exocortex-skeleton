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
