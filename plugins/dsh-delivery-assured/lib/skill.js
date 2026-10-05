/**
 * The runtime skill this plugin publishes into the session catalog.
 *
 * It carries the working procedure — the order of operations, the three human
 * touchpoints, and the authority boundary — so a session can organize its own work
 * without re-deriving the rules. The Contract, the standards and the Baseline stay
 * authoritative in the repository and in CI; this text is instructions, not state.
 */

export const SKILL_NAME = 'delivery-assured'

export const SKILL_DESCRIPTION =
  'Work a delivery so that omissions surface, unfinished items cannot disappear, old capabilities are re-verified, and "done" is a set of checkable facts instead of a claim.'

export const SKILL_WHEN_TO_USE =
  'Use when delivering a product or a vertical slice with an agent: discovering obligations, drafting or revising the Contract, writing acceptance before implementation, planning Slices, diagnosing a failure loop, resuming after a session change, or judging whether the product is actually finished.'

export const SKILL_MARKDOWN = `# Delivery-Assured Progressive SE

You are working inside a repository that carries four authoritative objects:
**Contract** (what must still be delivered), **Coverage** (which Slice, acceptance
and current result covers each obligation), **Evidence** (which revision, against
which standards, in which environment passed) and **Baseline** (the trusted
starting point). Coverage and every report are recomputed; there is no second
hand-written ledger.

## Authority boundary — read this first

- A local run is a **diagnostic**. It never produces evidence and never advances a Baseline.
- Only the trusted CI verification job produces \`evidence.json\`.
- Only the CI Promotion job holds the credential that advances \`refs/heads/baseline/*\`.
- \`.agent/STATE.yaml\` is an editable summary. A \`DONE\` in it is not completion evidence,
  and neither is a model answering "完成".
- You may not delete a Required obligation, weaken an assertion, add \`skip\`/\`only\` to a
  required case, or narrow the verification set to make a run pass.
- A Critical correctness violation (unauthorized access, wrong attribution, data
  corruption) blocks immediately. It is never deferred as ordinary technical debt.

## Start every session the same way

1. Load this skill and read \`AGENTS.md\` for the Global Kernel and the code conventions.
2. Run the resume tool (\`delivery_resume\`) or \`node packages/delivery-assured/scripts/resume.mjs\`.
   It reports the trusted starting point, what is still owed, the last failure,
   the remaining budget and the next verification step.
3. Do not restate history from memory. Recompute it.

## Default completion: independent automatic acceptance

The frozen Contract declares the completion rule in \`completion_policy\`:

- \`independent_auto\` (the default for new projects): the project closes from acceptance that
  was actually executed on the frozen revision plus release prerequisites observed on the
  platform. No owner comment, no hand-edited receipt and no script for the user to run.
- \`human_review\`: a real human review record is required. An automatic run can never
  manufacture one, and an undeclared policy means \`human_review\` — silence never makes a
  project automatically deliverable.

Ask the user only when the decision is genuinely theirs: a substantive product trade-off
(changing an observable result, a Critical rule's subject/resource/operation, or in/out of
scope), a new permission, cost, or a destructive or irreversible operation. Ordinary HOW
decisions, added tests inside agreed semantics and automatic promotion are yours to make.

When acceptance cannot be automated, say so as a **limitation** in the delivery report
(for example subjective usability). A limitation is not a pass, and it is never quietly
dropped.

## The five phases

### 1. Elicit before planning

Write \`docs/INTENT.md\`, then work \`docs/ELICITATION.md\`: for every Journey step settle
actors and entry point, preconditions, success and persistence, failure and recovery,
illegal input, retry and concurrency, identity and authorization, state feedback, and
deployment. Then disposition **every** item of every selected checklist under
\`templates/checklists/\` — \`required\`, \`excluded\`, \`not_applicable\`, \`unknown\` or
\`deferred_with_approval\`. An unhandled \`unknown\` is a hard stop.

Check: \`delivery_gaps\` with \`phase=contract\`.

### 2. Freeze acceptance before implementing

Draft \`.agent/CONTRACT.yaml\` with stable ids: \`J-*\` Journeys, \`C-*\` capabilities,
\`BR-*\` rules, \`A-*\` acceptance cases, \`R-*\` manual reviews. Every Critical rule declares
subjects, resources, operations, boundaries, allowed results, and the data that must not
change after a refusal.

Write the acceptance in a **separate session that does not read implementation code,
implementation plans or fix history**. Behaviour assertions and semantic interfaces go in
the protected \`tests/acceptance/spec/\`; the adapter that touches selectors, URLs and
storage fields goes in \`tests/acceptance/driver/\`. The driver returns what it observed and
never decides pass/fail: no \`expect\`, no \`assert\`, no turning an exception into success.

Check: \`delivery_gaps\` with \`phase=acceptance\`.

### 3. One vertical slice at a time

A Slice runs from an entry point through domain behaviour and persistence to an observable
result. Horizontal groundwork is allowed only with \`why_not_vertical\`, \`unlocks\` and a
\`max_scope\`. Each Slice declares its obligations and outcomes, its acceptance, its
dependencies, the Baseline it integrates with, the capabilities it must preserve, its
attempt budget, and any migration or external side effect.

Check: \`delivery_gaps\` with \`phase=slice\`.

### 4. Verify on a fixed candidate

\`\`\`
node packages/delivery-assured/scripts/verify.mjs --local --slice <id>
\`\`\`

Six gates: build, clean boot, persistence/migration, Slice acceptance, regression Spine,
deployment. A gate declared \`excluded\` must carry a reason. Zero tests, a missing case, a
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

Check: the attempts tool (\`delivery_attempts\`).

## Three-question triage for anything that changes the plan

1. Does it change an observable result of any Journey?
2. Does it touch a Critical rule's subjects, resources or operations?
3. Does it change what is in or out of scope?

All three no: it is a HOW decision. Decide it, and record one line in \`.agent/STATE.yaml\`.
Any yes: it is a Change Proposal. Pause the affected work and get the owner's confirmation
for the specific difference, then update the Contract, have the independent session adjust
the acceptance, refresh Coverage and re-verify in full.

## What you must not claim

Do not report a Slice as done because the local gates are green, and do not report the
product as \`MVP_READY\` unless the whole Contract's Required results are implemented and
mapped, every machine acceptance and the full Spine pass on the frozen revision, the
declared environment runs that same candidate and image, the declared completion rule is
actually satisfied, and the declared release prerequisites were observed. Report what is
still owed, what blocked, and how much budget is left — including the parts that could not
be verified automatically. Never widen the claimed scope.

## The automatic loop in a session

1. \`delivery_iteration\` with \`action=open\` records the user's requirement verbatim; before
   planning, re-read it with \`action=status\` so the requirement survives the session.
2. \`delivery_gaps\` / \`delivery_coverage\` / \`delivery_resume\` / \`delivery_attempts\` tell you
   what is owed, what is stale and how much budget is left. Recompute; never restate from memory.
3. Implement, then verify locally for diagnosis (\`delivery_verify_local\`).
4. \`delivery_ci\` with \`action=request\` asks the platform to run the frozen verification on the
   exact candidate; \`action=observe\` reports the run and its jobs. A requested or completed run
   is still not a promotion, and an ambiguous dispatch is never retried blindly.
5. On a real failure, diagnose it, record the falsified assumption with \`action=note\` (or a
   Replan Record when the approach must change), then form the next candidate. On a genuine
   blocker, record it with \`action=blocked\` and report exactly what is needed.
6. When everything the Contract requires has passed and the prerequisites were observed, ask
   the promotion workflow to close the delivery. \`action=close\` records the outcome; it does
   not create one.
`
