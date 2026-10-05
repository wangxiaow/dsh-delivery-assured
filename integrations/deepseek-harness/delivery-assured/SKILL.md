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
which standards, in which environment passed) and **Baseline** (the optional
high-assurance starting point that the protected Promotion job maintains).
Coverage and every report are recomputed; there is no second hand-written ledger.

## Authority boundary — read this first

- A local run is a **diagnostic**. `delivery_verify_local` never produces evidence and cannot
  complete anything.
- Completion is decided by an **independent execution of the frozen Required acceptance on the
  exact candidate revision**. You cannot declare it: the verdict is recomputed from records,
  and `delivery_iteration action=close` is refused until that verdict is `Delivered`.
- The **default backend is the DSH host itself**: `delivery_verify_independent` runs build,
  clean boot, persistence/migration, the frozen Slice acceptance and the accumulated Spine for
  real, under a run token the verifier generates, and retains the record, the raw gate log and
  the frozen-standard digests. A hand-written record, a skipped Required case, a filtered run or
  a modified spec is not a pass.
- The **protected CI workflow, the authority refs and the Baseline are the optional
  high-assurance backend**, not a precondition. A project whose frozen Contract needs platform
  provenance declares `verification.backend: trusted_ci` and keeps exactly the old rule.
- `.agent/STATE.yaml` is an editable summary. A `DONE` in it is not completion evidence,
  and neither is a model answering "完成".
- You may not delete a Required obligation, weaken an assertion, add `skip`/`only` to a
  required case, or narrow the verification set to make a run pass. You may not re-freeze the
  standard to match a failing implementation.
- A Critical correctness violation (unauthorized access, wrong attribution, data
  corruption) blocks immediately. It is never deferred as ordinary technical debt.

## Start every session the same way

1. Load this skill and read `AGENTS.md` for the Global Kernel and the code conventions.
2. Run the resume tool (`delivery_resume`) or `node packages/delivery-assured/scripts/resume.mjs`.
   It reports the trusted starting point, what is still owed, the last failure,
   the remaining budget and the next verification step.
3. Do not restate history from memory. Recompute it.

### A new project has no Contract yet — that is a lifecycle, not an error

When the supervision summary says `bootstrap`, the project is new and the order below is
enforced by the protected-path guard. Do not go looking for the artifact formats in the
operation pack: the summary and every tool answer name the next artifact.

1. **Record the requirement first** — `delivery_iteration` with `action=open` and the user's
   requirement verbatim. A first requirement needs no existing iteration, and this is what
   makes the round recoverable after a crash, a restart or a model change.
2. Then create, in this order: `.agent/project.yaml` → `ci/verifier.yaml` →
   `tests/acceptance/spec` (+ `tests/spine/manifest.yaml`) → `.agent/slices/<id>.yaml` →
   `.agent/CONTRACT.yaml`.
   The verifier is interpreted through the project metadata, the Contract may only reference
   acceptance that is already frozen, and `verify`/`precheck` are given a Slice that must
   already be declared — hence the order. Until a step is done, the paths of the later steps
   stay refused by the guard; writing the Contract closes the bootstrap window permanently,
   and every protected standard becomes read-only again. Run `delivery_gaps --phase contract`
   **before** freezing: once the Contract exists this session cannot edit it.
3. Re-run `delivery_resume` between steps: it reports the current step, the next artifact
   and the same budget the kernel shows. `delivery_verify_local` cannot run before
   `ci/verifier.yaml` exists, and it says so instead of pretending to diagnose.

## Default completion: independent automatic acceptance

The frozen Contract declares the completion rule in `completion_policy`:

- `independent_auto` (the default for new projects): the project closes from acceptance that
  was **actually executed on the frozen revision**. On the default backend that execution is the
  host verifier; nothing about it is taken from a claim. No owner comment, no hand-edited receipt
  and no script for the user to run.
- `human_review`: a real human review record is required. An automatic run can never
  manufacture one, and an undeclared policy means `human_review` — silence never makes a
  project automatically deliverable.

The default path, end to end:

```
record the requirement (delivery_iteration action=open)
  → freeze the standard once, before implementing (delivery_verify_independent freeze_standard: true)
  → implement
  → the host executes the frozen acceptance (delivery_verify_independent)
  → on FAIL: read the gate and the Required case it names, fix, run it again
  → on PASS: the delivery is Delivered; record it and close the iteration
```

Never ask the user an ordinary technical question inside that loop: a failing gate is your
problem to diagnose and fix, not a decision for them.

Ask the user only when the decision is genuinely theirs: a substantive product trade-off
(changing an observable result, a Critical rule's subject/resource/operation, or in/out of
scope), a new permission, cost, or a destructive or irreversible operation. Ordinary HOW
decisions, added tests inside agreed semantics and automatic promotion are yours to make.

When acceptance cannot be automated, say so as a **limitation** in the delivery report
(for example subjective usability). A limitation is not a pass, and it is never quietly
dropped.

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

### 4. Freeze the standard, then verify on a fixed candidate

Freeze once, **before implementing**, and commit it:

```
node packages/delivery-assured/scripts/verify.mjs --project <project> --freeze-standard
```

That records the SHA-256 of every protected standard file (Contract, project config,
acceptance manifest and specs, verifier config, Slices) together with the revision those
bytes are committed at. Verification then compares every byte; a Required case cannot be
rewritten, added or removed after freeze without the run refusing `STANDARD_DRIFT`, and a
re-freeze is auditable (`--allow-standard-change` records the previous standard id).

For diagnosis:

```
node packages/delivery-assured/scripts/verify.mjs --project <project> --local --slice <id>
```

For the run that actually completes the delivery (the default completion path):

```
node packages/delivery-assured/scripts/verify.mjs --project <project> --backend host --write-evidence --slice <id>
```

Six gates: build, clean boot, persistence/migration, Slice acceptance, regression Spine,
deployment. The four executable gates must really run on the host backend; only a gate the
frozen verifier config marks CI-only may be `not_applicable`, and it must say why. Zero
tests, a missing case, a skip, an accidental filter and a timeout are never a pass. The
record states positively what this backend could **not** observe (a packaged deployment,
runtime isolation) instead of claiming it.

The Spine only grows: a passing run accumulates every case it verified, and a later candidate
re-runs them all. Dropping one fails the run.

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
product as delivered unless the recomputed verdict says `Delivered`: the frozen Required set
plus the accumulated Spine actually executed and passed on this exact candidate revision, from
a verification backend this project accepts. Report what is still owed, what blocked, and how
much budget is left — including the parts that could not be verified automatically. Never
widen the claimed scope, and never present a limitation as a pass.

## The automatic loop in a session

1. `delivery_iteration` with `action=open` records the user's requirement verbatim. Opening needs
   no existing iteration — a first requirement and the round after a delivered one both start from
   the journal — and `action=status` re-reads it before planning, from the same authoritative state
   `delivery_resume` reads, so the requirement and the budget survive the session.
2. `delivery_gaps` / `delivery_coverage` / `delivery_resume` / `delivery_attempts` tell you
   what is owed, what is stale and how much budget is left. Recompute; never restate from memory.
3. Freeze the standard once (`delivery_verify_independent` with `freeze_standard: true`) before
   implementing, then implement.
4. Have the host execute the frozen acceptance: `delivery_verify_independent`. It reports the
   gates, the Required cases and the retained run log, and it writes Evidence on the default
   path. A failure names the gate or case to fix; fix it and run it again. Do not ask the user.
5. Optional high assurance: if this project has a protected CI workflow, `delivery_ci` with
   `action=request` asks the platform to run the frozen verification on the exact candidate and
   `action=observe` reports the run and its jobs. It is not required to finish, and a requested
   or completed run is still not a promotion by itself.
6. On a real failure, diagnose it, record the falsified assumption with `action=note` (or a
   Replan Record when the approach must change), then form the next candidate. On a genuine
   blocker, record it with `action=blocked` and report exactly what is needed.
7. When the verdict is `Delivered`, record the outcome with `action=verified` and close the
   iteration with `action=close`. Closing recomputes the verdict and is refused until it is
   `Delivered`; it never creates the outcome.
