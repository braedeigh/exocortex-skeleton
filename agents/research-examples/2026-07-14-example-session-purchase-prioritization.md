<!-- Origin: personal vault research/2026-07-14-example-session-purchase-prioritization.md.
     Copied verbatim — no personal identifiers (name/email/vault paths) were
     present in the source; content is a real chat transcript kept as sample
     corpus for the research pipeline, per the migration's explicit
     instruction to preserve it as an exemplar. See docs/scrub-log/C-research.md. -->
# Example session — "Are there algorithms for prioritizing what to buy?" (2026-07-14)

**What this is:** A saved record of a live Spark research session, kept as an **exemplar of the kind of question my research sessions exist to answer** — like the mattress-decision session saved the same day, but a different species: not *"help me make this one decision"* but *"find me a reusable procedure so this whole class of decisions stops costing cognition."* Meta-decision research. The output isn't a buy button — it's an algorithm my buy tab can eventually run for me.

**The driving question (verbatim):** "i'm really wondering if there are any like, algorithms or guides out there to how to prioritize buying things or not. i'm trying to minimize the cognition that i need for this kind of thing."

**Why it's a good specimen:**
1. **The question was split before it was searched.** "Prioritize buying things" is actually two problems — *should this be bought at all?* (a gate) and *what order?* (a ranker) — and the literature for each lives in different fields (personal finance heuristics vs. product-management economics). Unsplit, the search returns mush.
2. **Cross-domain transfer.** The best ranker came from software product management (WSJF / cost-of-delay), not personal finance. Preppers independently converged on the same shape (criticality rank → ascending cost). Convergent evolution across domains is evidence the shape is right.
3. **Findings mapped onto existing infrastructure instead of spawning new features.** The buy list *already is* the 30-day rule (`added` date + add-instead-of-buy friction); the priority dot *becomes* cost-of-delay by redefinition, not by new UI.
4. **Honest edge-marking:** no framework ranks *across* fronts (health purchase vs living-space purchase). That's a values call — per-front budgets, not formulas. Named as open rather than papered over.

**Fronts:** Finances, Exocortex.

---

## Findings

### The gate — "should this be bought at all?"
All variants of *add friction, let desire decay*:
- **30-day rule** — want it → it goes on a list for 30 days; still wanted after, buy guilt-free. Consumer-behavior data: ~50–70% of waited-on items are no longer wanted after 30 days. Price-scaled variant: wait ~1 day per $10.
- **Cost-per-use ($1 rule)** — price ÷ realistic lifetime uses, aim ≤$1/use. Brutal on trend purchases, generous on daily-use durables (the shikibuton is ~$0.30/use). Buy-it-for-life wins this math automatically.
- **1% rule** — anything over 1% of annual income gets a mandatory pause. Its inverse (0.01% rule) matters just as much for cognition-minimizing: purchases under ~0.01% *don't deserve deliberation at all*.
- **10/10/10** — feelings at 10 minutes / 10 months / 10 years. Emotional-wobble tool, not an algorithm.

**Key realization: the buy list already implements the gate.** Adding-instead-of-buying is the friction; `added` is the timestamp. Zero new cognition required.

### The ranker — "it passed the gate; what order?"
- **WSJF (Weighted Shortest Job First)** = cost of delay ÷ job size. For purchases: *what does NOT having it cost per week* ÷ price. Sooner-value compounds; delayed-value decays. A moderately useful cheap thing correctly outranks a very useful expensive thing.
- **Prepper convergence:** rank by criticality within category, then buy top-ranked items cheapest-first. Same algorithm, folk form.

### The zero-math waterfall (adopted)
1. **Deadline items** (`by` date) — the calendar sorts them. No thinking.
2. **Restocks** — already auto-high via the running-low loop. No thinking.
3. **Everything else:** one question, asked once at add-time — *"what does not-having-this cost me per week?"*
   - 🔴 high = costs health, sleep, or money every week I wait
   - 🟡 medium = costs friction / a workaround
   - ⚪ low = costs nothing to wait
   Ties break cheapest-first (cheap unblocks fast).

The priority dot stops being a vibe and becomes a measurement of cost-of-delay. That one question is the entire per-item cognitive load.

### Marked edge — what no framework solves
Ranking *across* fronts (is a health buy worth more than a living-space buy?) is a values allocation, not a formula. Closest prior art: Ramit Sethi-style "money dials" / conscious-spending — spend lavishly on the loved categories, cut ruthlessly elsewhere. That's a per-front budget. Open thread.

## Threads to follow
- [ ] Per-front budget allocation ("money dials" for fronts) — the cross-front ranking problem.
- [ ] Encode the waterfall into the buy tab's sort (deadline → restock → priority → ascending cost) so the list *renders* pre-decided.
- [ ] Measure my own 30-day decay rate: how many buy-list items die on the vine? (The `added` dates make this computable.)

## The record

**B:** i'm realyl wondering if there are any like, algorithms or guides out there to how to prioritize buying things or not. i'm trying to minimize the cognition that i need for this kind of thing. can you look for me?

**Spark:** *(searched: prioritization frameworks, purchase heuristics, cost-per-use / 30-day / 10-10-10 rules, prepper gear-prioritization systems, WSJF / cost-of-delay)* Found it — it splits into two problems people smush together. **Gate** ("should I buy at all?"): 30-day rule (the buy list already IS this — `added` date + add-instead-of-buy friction), cost-per-use ≤$1 (shikibuton ≈ $0.30/use), 1% rule with its 0.01% inverse (small stuff doesn't deserve deliberation at all), 10/10/10 for wobbles. **Ranker** ("what order?"): WSJF = cost of delay ÷ price — what does NOT having it cost per week; preppers converge on the same shape (criticality rank → cheapest-first). Adopted as a zero-math waterfall: deadline → restock → 🔴/🟡/⚪ one-question priority → ties cheapest-first. Flagged honestly: nothing ranks across fronts — that's per-front budgets (money dials), a values call.

**B:** this is another example of a research thread that i'd like to follow so yes

**Spark:** Saved this note to the library + opened the live thread **Purchase prioritization** (💵 Finances, 🧠 Exocortex) seeded with the two open questions: cross-front ranking, and my measurable 30-day decay rate.

## Sources
- Finny — the 30-day rule: https://getfinny.app/blog/what-is-the-30-day-rule
- TheStreet — the $1/cost-per-use rule: https://www.thestreet.com/personal-finance/the-one-dollar-rule-how-a-personal-finance-expert-justifies-any-purchase
- HeyGoTrade — the 1% rule: https://www.heygotrade.com/en/blog/1-rule-in-spending-explained/
- Good Life Journey — the 0.01% rule: https://www.thegoodlifejourney.com/home/the-0-01-percent-rule-personal-finance
- Inc — 10/10/10: https://www.inc.com/jessica-stillman/personal-finance-decision-making-10-10-10-rule.html
- ProductPlan — WSJF: https://www.productplan.com/glossary/weighted-shortest-job-first
- Selleo — cost of delay per week: https://selleo.com/blog/cost-of-delay-cod-how-to-calculate-delay-cost-per-week-use-wsjf-and-decide-if-buying-time-is-worth-it
- The Prepared forum — gear prioritization systems: https://theprepared.com/forum/thread/how-do-you-prioritize-gear-purchases-anyone-have-an-organized-system/
