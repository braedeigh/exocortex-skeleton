# Why the notes are shaped the way they are — the evidence

`CLAUDE.md` ("Plain-language layer") tells every agent how to write the plain-English
notes inside the code. This file is the *why* behind the shape rules, kept here so the
rules can stay short. It is a reading of published studies, checked twice (2026-09-18),
and it says plainly how much weight each piece will bear. **Nothing here was measured on
this codebase or its owner** — every study is on students or working developers.

Tiers: **read** = the paper's own text was opened. **reported** = only a summary of it.

## 1. First line says what the chunk is FOR · one note per chunk

**Basis: subgoal labels** — short plain-language headings over a group of steps in a
worked example, naming the *purpose* of the group.

- Margulieux, Catrambone & Guzdial 2016, *Computer Science Education*
  (doi 10.1080/08993408.2016.1144429). **read.** Experiment 1: 40 students from a
  psychology pool with no programming background learned to build apps from worked
  examples, with or without labels. The labelled group solved **36% more** of the
  problem-solving tasks (F(1,38)=11.16, p=.002, f=.53, a large effect), still ahead a
  week later (46% more on the delayed test), and finished 11% faster. A third experiment
  found the same or stronger effect online with working K-12 teachers.
- The paper's own account of why: labels "highlight the underlying structure" and
  "visually chunk problem-solving steps", so less attention goes to incidental detail.
- Catrambone 1998 (cited there): labels that state the purpose in meaningful words
  worked better for novices; abstract labels that make the reader work out the purpose
  worked better for advanced learners.

**What weakens it — say this whenever the rule is quoted as "proven":**
- Nearly all of it is one research group (Georgia Tech and its later CS1 subgoals
  project). No commercial tie; still, replication is mostly in-house.
- In *text* programming languages the picture is mixed. Morrison, Margulieux & Guzdial,
  ICER 2015: given labels did **not** cleanly replicate; the result depended on other
  features of the material. **reported.** The same group's SIGCSE 2016 study did find
  given labels beat no labels, and beat labels the students wrote themselves. **reported.**
- A semester-long field study (Margulieux, Morrison & Decker 2020, *Int. J. STEM
  Education*; 265 students): better quizzes, **no average gain on exams**, but lower
  variance and fewer students dropping or failing — the least experienced gained most.
  **reported** (via one author's summary).
- The outcome measured is *solving new problems after studying an example*, not
  *reading a codebase*. Applying it to code notes is an inference.

## 2. Notes go ON concrete code, not in abstract prose about it

Margulieux, Catrambone & Schaeffer 2018, *Instructional Science* 46(5). **reported** (the
first author's own summary). Labels on **worked examples** helped in every field tested.
Labels on **explanatory text alone** did nothing for programming unless paired with
examples. So the weight is on the inline note at the chunk; a top-of-file block orients,
but it is not where the measured benefit lives.

Backed in general by the **split-attention effect** (Chandler & Sweller 1992, *British J.
Educational Psychology*): an explanation physically beside what it explains beats the same
explanation placed elsewhere. Established on text-and-diagram material, not code. **reported.**

## 3. Same kind of chunk, same words

Subgoal labels are deliberately generic — the same label reused over different problems.
The 2016 paper (**read**) says comparison across examples is part of the mechanism:
readers ask "why two groups of steps are both characterized by the same subgoal label."
No study isolates consistent wording as its own variable, so this is *part of a method
that works*, not a separately proven rule.

## 4. If it's a known pattern, name it

"Providing Information About Implemented Algorithms Improves Program Comprehension",
EASE 2025 (arXiv 2504.19225). **reported.** 56 participants; code annotated with the name
of the algorithm each part implements. Comprehension up a median ~23% (p=.040), time
unchanged (p=.991); most helpful at medium experience. One study, thin p-value, by a
group building a tool that generates such labels. Light weight.

## 5. Detail must be skippable

**Expertise reversal effect.** Tetzlaff, Simonsmeier, Peters & Brod 2025, *Learning and
Instruction* 98 — meta-analysis, 60 experiments, 5,924 participants. **reported** (the
paper itself could not be opened; pooled effect sizes unknown to us). Guidance that helps
low-knowledge learners is neutral-to-harmful for high-knowledge ones; helping novices is
the stronger of the two effects. Consistent with Nielebock et al. 2019 (*Empirical Software
Engineering*, 277 mostly-professional developers): documentation comments made small
tasks slower, with no gain in correctness. **reported.**

Hence: a first line that stands alone, detail after it. The same reader will need less
over time, and should be able to read only first lines.

## 6. Names are whole words

Hofmeister, Siegmund & Holt, "Shorter Identifier Names Take Longer to Comprehend"
(SANER 2017; *Empirical Software Engineering* 24, 2019). **read.** 72 professional C#
developers, within-subject, finding defects: whole words were **19% faster** than single
letters or abbreviations; letters and abbreviations did not differ. An aggregation of three
further studies (*Empirical Software Engineering*, 2023) found novices and experts both
*judge* full-word names more readable. **reported.**

## What the literature does NOT settle

- **"Comment the why, not the what."** No controlled comparison was found. Untested.
- **Top-of-file overview blocks** as such. Untested.
- **Stale notes** — what a confident note that no longer matches the code costs a reader.
  Untested. "The note must never lie" rests on its own reasoning, which is sound.
- **Baking in the prompt.** Nothing addresses it.
- **Comments in general** are mixed: Abdelsalam et al. 2025 (*Empirical Software
  Engineering*, 20 students, eye tracking, **read**) found their effect ran from a 30%
  decrease to a 34% increase depending on the snippet, and that readers rated comments
  helpful whether or not they were. **Liked is not the same as helped** — the loudest
  lesson in this literature, and the reason these rules lean on performance studies.
- Machine-written explanations were rated clearer than students' (Leinonen et al. 2023,
  ~1,000 students) — ratings only, nothing on learning. **reported.**

## If you change the rules

Re-check the sources first; summaries of these papers get things wrong (one search
summary attributed a 2025 study's numbers to a 1996 paper during this review). Keep the
tier on every claim. Where you only honestly know a region, say a region.
