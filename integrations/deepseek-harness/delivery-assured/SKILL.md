---
name: delivery-assured
description: >-
  Work a delivery so that omissions surface, unfinished items cannot disappear, old capabilities are re-verified, and "done" is a set of checkable facts instead of a claim.
whenToUse: >-
  Use when delivering a product or a vertical slice with an agent: discovering obligations, drafting or revising the Contract, writing acceptance before implementation, planning Slices, diagnosing a failure loop, resuming after a session change, or judging whether the product is actually finished.
---
# Delivery-Assured Progressive SE

You are working inside a repository that carries four authoritative objects:
**Contract** (what must still be delivered), **Coverage** (which Slice, acceptance
and current result covers each obligation), **Evidence** (which revision, against
which standards, in which environment passed) and **Baseline** (the trusted
starting point). Coverage and every report are recomputed; there is no second
hand-written ledger.

## Authority boundary — read this first

- A local run is a **diagnostic**. It never produces evidence and never advances a Baseline.
- Only the trusted CI verification job produces `evidence.json`.
- Only the CI Promotion job holds the credential that advances `refs/heads/baseline/*`.
- `.agent/STATE.yaml` is an editable summary. A `DONE` in it is not completion evidence,
  and neither is a model answering "完成".
- You may not delete a Required obligation, weaken an assertion, add `skip`/`only` to a
  required case, or narrow the verification set to make a run pass.
- A Critical correctness violation (unauthorized access, wrong attribution, data
  corruption) blocks immediately. It is never deferred as ordinary technical debt.

## Start every session the same way

1. Load this skill and read `AGENTS.md` for the Global Kernel and the code conventions.
2. Run the resume tool (`delivery_resume`) or `node packages/delivery-assured/scripts/resume.mjs`.
   It reports the trusted starting point, what is still owed, the last failure,
   the remaining budget and the next verification step.
3. Do not restate history from memory. Recompute it.

## The three human touchpoints

The owner is asked at exactly three points, plus any real WHAT change:

1. **Unknowns Gate** — before planning: answer, exclude, or approve a bounded assumption.
   No unresolved unknown may enter planning.
2. **Acceptance summary confirmation** — before implementation: about ten minutes reading
   the per-Journey results, the persistence requirements and the negative paths.
3. **Final Journey Review** — before `MVP_READY`: the owner walks the core Journeys on the
   named staging deployment using a fresh identity.

Ordinary HOW decisions, added tests inside the agreed semantics, and automatic promotion
are not brought to the owner each time. Changing a product result, deleting an obligation
or lowering a standard always is.

## The five phases

### 1. Elicit before planning

Write `docs/INTENT.md`, then work `docs/ELICITATION.md`: for every Journey step settle
actors and entry point, preconditions, success and persistence, failure and recovery,
illegal input, retry and concurrency, identity and authorization, state feedback, and
deployment. Then disposition **every** item of every selected checklist under
`templates/checklists/` — `required`, `excluded`, `not_applicable`, `unknown` or
`deferred_with_approval`. An unhandled `unknown` is a hard stop.

Check: `delivery_gaps` with `phase=contract`.

### 2. Freeze acceptance before implementing

Draft `.agent/CONTRACT.yaml` with stable ids: `J-*` Journeys, `C-*` capabilities,
`BR-*` rules, `A-*` acceptance cases, `R-*` manual reviews. Every Critical rule declares
subjects, resources, operations, boundaries, allowed results, and the data that must not
change after a refusal.

Write the acceptance in a **separate session that does not read implementation code,
implementation plans or fix history**. Behaviour assertions and semantic interfaces go in
the protected `tests/acceptance/spec/`; the adapter that touches selectors, URLs and
storage fields goes in `tests/acceptance/driver/`. The driver returns what it observed and
never decides pass/fail: no `expect`, no `assert`, no turning an exception into success.

Check: `delivery_gaps` with `phase=acceptance`.

### 3. One vertical slice at a time

A Slice runs from an entry point through domain behaviour and persistence to an observable
result. Horizontal groundwork is allowed only with `why_not_vertical`, `unlocks` and a
`max_scope`. Each Slice declares its obligations and outcomes, its acceptance, its
dependencies, the Baseline it integrates with, the capabilities it must preserve, its
attempt budget, and any migration or external side effect.

Check: `delivery_gaps` with `phase=slice`.

### 4. Verify on a fixed candidate

```
node packages/delivery-assured/scripts/verify.mjs --local --slice <id>
```

Six gates: build, clean boot, persistence/migration, Slice acceptance, regression Spine,
deployment. A gate declared `excluded` must carry a reason. Zero tests, a missing case, a
skip, an accidental filter and a timeout are never a pass.

The Spine only grows: every verified critical case is re-run on later candidates, and
removing one needs the owner's confirmation.

### 5. Stop non-convergent patching

An attempt is one round of "form a candidate against a stated hypothesis and run the agreed
set". Count attempts against the budget; changing session, renaming a Slice or Replanning
does not reset it. Judge progress only on the same standard and the same case set: required
passes rising, Spine failures falling, Critical violations gone.

At the same-root-cause limit, the no-progress window, or repeated regressions, stop patching
and write a Replan Record: which assumption was falsified, how the new approach differs,
which checks will discriminate, and which obligations are preserved. A new prompt is not a
Replan.

Check: the attempts tool (`delivery_attempts`).

## Three-question triage for anything that changes the plan

1. Does it change an observable result of any Journey?
2. Does it touch a Critical rule's subjects, resources or operations?
3. Does it change what is in or out of scope?

All three no: it is a HOW decision. Decide it, and record one line in `.agent/STATE.yaml`.
Any yes: it is a Change Proposal. Pause the affected work and get the owner's confirmation
for the specific difference, then update the Contract, have the independent session adjust
the acceptance, refresh Coverage and re-verify in full.

## What you must not claim

Do not report a Slice as done because the local gates are green, and do not report the
product as `MVP_READY` unless the whole Contract's Required results are implemented and
mapped, every machine acceptance and the full Spine pass on the frozen revision, the real
staging deployment runs that same candidate and image, the owner has completed the final
Journey Review, and the declared release prerequisites are met.

Report what is still owed, what blocked, and how much budget is left. Never widen the
claimed scope.
