import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attemptFromCI, caseSetDigest, computeConvergence, criticalOpenFromModel, resolveSlice, standardDigest, validateAttempt } from '../scripts/lib/convergence.mjs'

const revision = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const image = `sha256:${'c'.repeat(64)}`
const bindings = { code_revision: revision, contract_revision: revision, acceptance_revision: revision, verifier_config_revision: revision, contract_digest: digest, acceptance_manifest_digest: digest, acceptance_digest: digest, verifier_config_digest: digest, spine_manifest_digest: digest, slice_manifest_digest: digest, dependency_lock_digest: null, migration_digest: null, parent_baseline: null }
function model(attempts = []) {
  return {
    root: '.', cfg: { paths: { attemptsLog: 'not-present.jsonl' }, budget: { total_attempt_limit: 3, same_root_cause_limit: 3, no_progress_window: 3, replan_limit: 2 }, ci: { trusted_issuer: 'ci' } },
    slices: [{ id: 'S-NEW', slice_key: 'stable', lineage: ['S-OLD'], acceptance: ['A-1', 'A-2'], obligations: ['C-1'] }],
    attempts, evidence: [], baselines: [], state: { replans: 900, status: 'DONE' },
    currentBindings: { ...bindings },
    acceptance: { cases: ['A-1', 'A-2'].map(id => ({ id, required: true, method: 'automated', obligation_ids: ['C-1'] })) }, contract: { business_rules: [] }, spine: { caseIds: ['A-2'] },
  }
}
function attempt(n, extra = {}) {
  return { attempt_id: `A${n}`, slice_id: 'S-NEW', slice_key: 'stable', at: `2026-01-01T00:00:0${n}Z`, root_cause_key: 'bug', hypothesis: 'test assumption', result: 'failed', standard_digest: standardDigest(bindings, evidence().environment), required_case_ids: ['A-1', 'A-2'], required_passed: 0, required_total: 2, spine_failures: 1, critical_violations: [], ...extra }
}
function replan(n) {
  return { attempt_id: `R${n}`, slice_id: 'S-NEW', slice_key: 'stable', at: `2026-01-01T00:00:0${n}Z`, hypothesis: 'replan', result: 'blocked', replan: { slice_id: 'S-NEW', falsified_assumption: 'bad assumption', previous_approach: 'old', new_approach: 'new', next_discriminating_checks: ['check'], preserved_obligations: ['C-1'], scope_changed: false } }
}
const compute = (m) => computeConvergence(m, { logExists: true, candidate: revision })
function evidence(extra = {}) {
  return {
    evidence_id: 'ci:1', issuer: { identity: 'ci' }, trust: { transport_verified: true, runtime_isolation_verified: true }, scope: { slice_id: 'S-NEW', required_case_ids: ['A-1', 'A-2'] }, bindings: { ...bindings },
    environment: { kind: 'production_like_ci', image_digest: image, deployed_image_digest: image, deployed_code_revision: revision, deployment_id: 'deploy-1', config_fingerprint: 'config-1', fixture_revision: 'fixture-1' },
    convergence: { root_cause_key: 'bug', hypothesis: 'CI hypothesis' }, structural_notes: [],
    execution: { result: 'PASS', ci_run_id: 'run-1', started_at: '2026-01-01T00:00:02Z', finished_at: '2026-01-01T00:00:03Z', required_cases: 2, executed_cases: 2, skipped_required_cases: 0, artifacts: ['report.json'], gate_results: ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment'].map((gate) => ({ gate, outcome: 'passed', exit_code: 0 })), case_results: [{ case_id: 'A-1', outcome: 'passed' }, { case_id: 'A-2', outcome: 'passed' }] }, ...extra,
  }
}

test('rename shares stable budget and unknown aliases fail closed', () => {
  const m = model([attempt(1, { slice_id: 'S-OLD' }), attempt(2)])
  assert.equal(computeConvergence(m, { slice: 'S-OLD', logExists: true, candidate: revision }).total, 2)
  assert.equal(resolveSlice(m, 'S-NEW').slice_key, 'stable')
  assert.throws(() => resolveSlice(m, 'S-OTHER'), /unknown/)
  assert.match(validateAttempt(attempt(3, { slice_id: 'S-OTHER' }), m).join(), /unknown/)
  assert.match(validateAttempt(attempt(3, { slice_key: 'renamed' }), m).join(), /inconsistent/)
})

test('Replan and infrastructure abort are not ordinary attempts; STATE is ignored', () => {
  const b = compute(model([attempt(1), replan(2), attempt(3, { result: 'infra_aborted' })]))
  assert.equal(b.total, 1)
  assert.equal(b.replans, 1)
  assert.equal(b.infra_aborted, 1)
  assert.equal(b.maxSameRootCause, 1)
})

test('Replan acknowledges stop but does not reset cumulative counters', () => {
  const m = model([attempt(1), attempt(2), replan(3)])
  m.cfg.budget.same_root_cause_limit = 2
  const b = compute(m)
  assert.equal(b.total, 2)
  assert.equal(b.maxSameRootCause, 2)
  assert.equal(b.requiresReplan, false)
  m.attempts.push(attempt(4))
  assert.equal(compute(m).requiresReplan, true)
})

test('changed cases and standards never constitute numeric progress', () => {
  const b = compute(model([attempt(1), attempt(2, { required_passed: 1, standard_digest: 'weaker' }), attempt(3, { required_passed: 2, standard_digest: 'weaker', required_case_ids: ['A-3', 'A-4'] })]))
  assert.equal(b.noProgressStreak, 3)
  assert.equal(b.requiresReplan, true)
})

test('staying on a changed case set cannot establish a new progress baseline', () => {
  const m = model([attempt(1), attempt(2, { required_case_ids: ['A-3', 'A-4'], required_passed: 1 }), attempt(3, { required_case_ids: ['A-3', 'A-4'], required_passed: 2 })])
  const b = compute(m)
  assert.equal(b.noProgressStreak, 3)
  assert.deepEqual(b.changed_comparison, ['A2', 'A3'])
  assert.equal(b.fixed_comparison.stable.case_set_digest, caseSetDigest(['A-1', 'A-2']))
})

test('same standard and fixed cases support progress', () => {
  const b = compute(model([attempt(1), attempt(2, { required_passed: 1, required_case_ids: ['A-2', 'A-1'] })]))
  assert.equal(b.noProgressStreak, 0)
  assert.equal(b.progress.requiredTrend.at(-1), 1)
  assert.equal(caseSetDigest(['A-1', 'A-2']), caseSetDigest(['A-2', 'A-1']))
})

test('missing log, metrics, digest, and unknown fields block', () => {
  const m = model()
  assert.equal(computeConvergence(m, { logExists: false }).blocked, true)
  assert.equal(computeConvergence(m, { logExists: false }).remaining, null)
  assert.equal(computeConvergence(m, { logExists: false }).history_known, false)
  for (const field of ['required_passed', 'required_total', 'spine_failures', 'standard_digest', 'critical_violations', 'required_case_ids']) {
    const a = attempt(1)
    delete a[field]
    assert.ok(validateAttempt(a, m).length, field)
  }
  assert.match(validateAttempt(attempt(1, { future_result: 'PASS' }), m).join(), /unknown field/)
  assert.match(validateAttempt(attempt(1, { result: 'UNKNOWN' }), m).join(), /unknown result/)
})

test('last allowed trusted CI PASS is success, not exhausted failure', () => {
  const m = model([attempt(1), attempt(2)])
  m.evidence = [evidence()]
  const b = compute(m)
  assert.equal(b.total, 3)
  assert.equal(b.remaining, 0)
  assert.equal(b.terminal_passed, true)
  assert.equal(b.budget_blocked, false)
  assert.equal(b.requiresReplan, false)
  assert.equal(b.blocked, false)
})

test('successful verification is retained but is not a repeated failure or stalled patch', () => {
  const m = model()
  m.cfg.budget.total_attempt_limit = 8
  m.evidence = [1, 2, 3].map(n => {
    const r = evidence({ evidence_id: `ci:success-${n}` })
    r.execution = { ...r.execution, finished_at: `2026-01-01T00:00:0${n}Z` }
    return r
  })
  const successful = compute(m)
  assert.equal(successful.total, 3)
  assert.equal(successful.maxSameRootCause, 0)
  assert.equal(successful.noProgressStreak, 0)
  // A different current candidate must be verified, not forced through Replan
  // because previous candidates succeeded with the same verification hypothesis.
  const next = computeConvergence(m, { logExists: true, candidate: 'd'.repeat(40) })
  assert.equal(next.terminal_passed, false)
  assert.equal(next.requiresReplan, false)
  assert.equal(next.maxSameRootCause, 0)
})

test('a PASS on changed standards does not clear the fixed-comparison budget', () => {
  const m = model([attempt(1, { standard_digest: 'original-standard' }), attempt(2, { standard_digest: 'original-standard' })])
  m.evidence = [evidence()]
  const b = compute(m)
  assert.equal(b.terminal_passed, false)
  assert.equal(b.budget_blocked, true)
  assert.deepEqual(b.changed_comparison, ['ci:1'])
})

test('an extra attempt beyond limit still blocks even if it passes', () => {
  const m = model([attempt(0), attempt(1), attempt(2)])
  m.evidence = [evidence()]
  assert.equal(compute(m).budget_blocked, true)
})

test('a hand-labelled PASS and stale CI PASS do not clear stop', () => {
  const m = model([attempt(1), attempt(2), attempt(3, { result: 'passed' })])
  assert.equal(compute(m).terminal_passed, false)
  const old = evidence()
  old.bindings.code_revision = 'old-revision'
  m.attempts = [attempt(1), attempt(2)]
  m.evidence = [old]
  assert.equal(compute(m).terminal_passed, false)
  assert.equal(compute(m).budget_blocked, true)
})

test('CI import computes counts; missing metadata and unknown outcomes block', () => {
  const m = model()
  const record = evidence()
  const a = attemptFromCI(record, m)
  assert.equal(a.required_passed, 2)
  assert.equal(a.slice_key, 'stable')
  assert.equal(a.standard_digest, standardDigest(record.bindings, record.environment))
  delete record.convergence
  assert.throws(() => attemptFromCI(record, m), /hypothesis|root_cause/)
  record.execution.case_results[0].outcome = 'UNKNOWN'
  assert.throws(() => attemptFromCI(record, m), /unknown CI/)
})

test('CI result overrides summary and a mismatched editable summary blocks', () => {
  const m = model()
  const record = evidence()
  const a = attemptFromCI(record, m)
  m.attempts = [{ ...a, required_passed: 0 }]
  m.evidence = [record]
  const b = compute(m)
  assert.equal(b.total, 1)
  assert.equal(b.progress.requiredTrend[0], 2)
  assert.match(b.invalid_entries.map((e) => e.message).join(), /CI summary mismatch/)
  assert.equal(b.blocked, true)
})

test('latest ERROR or FAIL cannot be masked by an old PASS', () => {
  for (const result of ['ERROR', 'FAIL']) {
    const m = model()
    m.contract.business_rules = [{ id: 'BR-1', severity: 'critical' }]
    m.acceptance.cases[0].obligation_ids = ['BR-1']
    const latest = evidence({ evidence_id: 'ci:2' })
    latest.execution = { ...latest.execution, result, finished_at: '2026-01-01T00:00:04Z', case_results: [{ case_id: 'A-1', outcome: 'errored' }, { case_id: 'A-2', outcome: 'passed' }] }
    m.evidence = [latest, evidence()]
    assert.equal(criticalOpenFromModel(m, { candidate: revision }).length, 1)
    assert.equal(compute(m).terminal_passed, false)
    assert.equal(compute(m).blocked, true)
  }
})

test('Critical needs every related case and classified current bindings', () => {
  const m = model()
  m.contract.business_rules = [{ id: 'BR-1', severity: 'critical' }]
  m.acceptance.cases = [
    { id: 'A-1', required: true, method: 'automated', obligation_ids: ['BR-1'] },
    { id: 'A-2', required: true, method: 'automated', obligation_ids: ['C-1'] },
    { id: 'A-3', required: true, method: 'automated', obligation_ids: ['BR-1'] },
  ]
  m.evidence = [evidence()]
  assert.equal(criticalOpenFromModel(m, { candidate: revision }).length, 2)
  m.acceptance.cases.pop()
  assert.equal(criticalOpenFromModel(m, { candidate: revision }).length, 0)
  m.currentBindings.contract_digest = 'changed'
  assert.equal(criticalOpenFromModel(m, { candidate: revision }).length, 1)
})

test('run and deployment identifiers do not change the comparison standard', () => {
  const r = evidence()
  const first = standardDigest(r.bindings, r.environment)
  assert.equal(first, standardDigest(r.bindings, { ...r.environment, deployment_id: 'next-run', deployed_code_revision: 'd'.repeat(40), image_digest: `sha256:${'e'.repeat(64)}` }))
  assert.notEqual(first, standardDigest(r.bindings, { ...r.environment, config_fingerprint: 'changed' }))
})

test('malformed records are reported without discarding diagnostic output', () => {
  const b = compute(model([null, 42, [], attempt(1, { required_passed: -1 })]))
  assert.equal(b.blocked, true)
  assert.ok(b.invalid_entries.length >= 4)
})

test('equal-time failure beats PASS regardless of evidence enumeration order', () => {
  const m = model()
  m.contract.business_rules = [{ id: 'BR-1', severity: 'critical' }]
  m.acceptance.cases[0].obligation_ids = ['BR-1']
  const failed = evidence({ evidence_id: 'ci:2' })
  failed.execution.result = 'ERROR'
  for (const records of [[failed, evidence()], [evidence(), failed]]) {
    m.evidence = records
    assert.equal(criticalOpenFromModel(m, { candidate: revision }).length, 1)
    assert.equal(compute(m).terminal_passed, false)
  }
})

test('CI missing accounting and unknown metadata fail closed', () => {
  const m = model()
  const r = evidence()
  r.execution.executed_cases = 1
  assert.throws(() => attemptFromCI(r, m), /accounting/)
  r.execution.executed_cases = 2
  r.convergence.reset_budget = true
  assert.throws(() => attemptFromCI(r, m), /unknown CI convergence/)
})

test('CI root cause cannot be overwritten by an editable log', () => {
  const m = model()
  const r = evidence()
  assert.throws(() => attemptFromCI(r, m, { root_cause_key: 'new-name' }), /metadata mismatch/)
  const a = attemptFromCI(r, m)
  m.attempts = [a, { ...a, attempt_id: 'different-id' }]
  m.evidence = [r]
  assert.match(compute(m).invalid_entries.map((e) => e.message).join(), /duplicate CI reference/)
})

test('future Critical cases do not block the current Slice', () => {
  const m = model()
  m.slices.push({ id: 'S-FUTURE', obligations: ['BR-FUTURE'], acceptance: ['A-FUTURE'] })
  m.contract.business_rules = [{ id: 'BR-FUTURE', severity: 'critical' }]
  m.acceptance.cases.push({ id: 'A-FUTURE', required: true, method: 'automated', obligation_ids: ['BR-FUTURE'] })
  const r = evidence(); m.evidence = [r]; m.attempts = [attemptFromCI(r, m)]
  const b = computeConvergence(m, { slice: 'S-NEW', logExists: true, candidate: revision })
  assert.equal(b.terminal_passed, true); assert.equal(b.blocked, false); assert.deepEqual(b.critical_open, [])
  assert.equal(criticalOpenFromModel(m, { candidate: revision }).length, 1)
})

test('Spine failure and unexecuted case counts use the real model shape', () => {
  const m = model(), r = evidence()
  r.execution.result = 'FAIL'; r.execution.case_results[1].outcome = 'failed'
  assert.equal(attemptFromCI(r, m).spine_failures, 1)
  r.execution.case_results[1].outcome = 'not_run'; r.execution.executed_cases = 1; r.execution.skipped_required_cases = 1
  assert.equal(attemptFromCI(r, m).spine_failures, 1)
})

test('approved standard rebase preserves history and allows the last genuine PASS', () => {
  const m = model([attempt(1, { standard_digest: 'd'.repeat(64) }), attempt(2, { standard_digest: 'd'.repeat(64) })])
  const r = evidence(); r.convergence.comparison_approval_ref = 'CHANGE-1'
  const final = attemptFromCI(r, m)
  m.standardChanges = [{ id: 'CHANGE-1', status: 'approved', confirmation_ref: 'owner:change-1', slice_key: 'stable', from_standard_digest: 'd'.repeat(64), to_standard_digest: final.standard_digest, from_case_set_digest: caseSetDigest(['A-1', 'A-2']), to_case_set_digest: caseSetDigest(final.required_case_ids) }]
  m.attempts.push(final); m.evidence = [r]
  const b = compute(m)
  assert.equal(b.total, 3); assert.equal(b.remaining, 0); assert.equal(b.terminal_passed, true); assert.equal(b.budget_blocked, false)
  assert.deepEqual(b.comparison_rebases, [{ attempt_id: r.evidence_id, approval_ref: 'CHANGE-1' }])
  m.standardChanges[0].status = 'draft'
  assert.equal(compute(m).blocked, true)
  assert.match(compute(m).invalid_entries.map(e => e.message).join(), /missing approval/)
})

// A ledger entry is checked against the Evidence it references, so a fixture entry has
// to describe the same execution: result, timestamps, counts and metadata.
function record(id, bindingPatch, spineCaseIds, { result = 'PASS', finishedAt = '2026-01-01T00:00:03Z' } = {}) {
  const base = evidence()
  const caseResults = result === 'PASS'
    ? [{ case_id: 'A-1', outcome: 'passed' }, { case_id: 'A-2', outcome: 'passed' }]
    : [{ case_id: 'A-1', outcome: 'passed' }, { case_id: 'A-2', outcome: 'failed' }]
  return {
    ...base,
    evidence_id: id,
    bindings: { ...bindings, ...bindingPatch },
    spine_case_ids: spineCaseIds,
    execution: { ...base.execution, result, finished_at: finishedAt, case_results: caseResults },
  }
}
function ledger(n, entry, { result = 'failed', requiredPassed = 1, spineFailures = 1 } = {}) {
  return attempt(n, {
    ci_ref: entry.evidence_id,
    hypothesis: 'CI hypothesis',
    at: entry.execution.finished_at,
    standard_digest: standardDigest(entry.bindings, entry.environment),
    result,
    required_passed: requiredPassed,
    spine_failures: spineFailures,
  })
}

test('a promotion that accumulates the Spine does not break the comparison window', () => {
  // The second attempt runs after Baseline #0 accumulated a Spine case: the full
  // binding digest changes (spine_manifest_digest) while the comparison identity does
  // not. Before the split this left the pinned comparison unreachable, `terminal_passed`
  // false, and every later promotion blocked by the same-root-cause counter.
  const first = record('ci:legacy', { spine_manifest_digest: '1'.repeat(64) }, [], { result: 'FAIL' })
  const second = record('ci:current', { spine_manifest_digest: '2'.repeat(64) }, ['A-2'], { finishedAt: '2026-01-01T00:00:04Z' })
  const m = model([ledger(1, first), ledger(2, second, { result: 'passed', requiredPassed: 2, spineFailures: 0 })])
  m.evidence = [first, second]
  m.currentBindings = { ...second.bindings }
  const b = compute(m)
  assert.equal(b.terminal_passed, true)
  assert.equal(b.blocked, false)
  assert.deepEqual(b.changed_comparison, [])
  assert.deepEqual(b.spine_accumulations, [{ attempt_id: 'A2', added: ['A-2'] }])
})

test('an attempt whose comparison identity changed is not silently comparable', () => {
  const first = record('ci:legacy', { spine_manifest_digest: '1'.repeat(64) }, [], { result: 'FAIL' })
  const weakened = record('ci:weakened', { acceptance_digest: 'f'.repeat(64), spine_manifest_digest: '2'.repeat(64) }, ['A-2'], { finishedAt: '2026-01-01T00:00:04Z' })
  const m = model([ledger(1, first), ledger(2, weakened, { result: 'passed', requiredPassed: 2, spineFailures: 0 })])
  m.evidence = [first, weakened]
  m.currentBindings = { ...weakened.bindings }
  const b = compute(m)
  assert.equal(b.terminal_passed, false)
  assert.deepEqual(b.changed_comparison, ['A2'])
})

test('the Spine may only grow: a dropped case is reported', () => {
  const withSpine = record('ci:with-spine', { spine_manifest_digest: '2'.repeat(64) }, ['A-2'])
  const withoutSpine = record('ci:dropped', { spine_manifest_digest: '3'.repeat(64) }, [], { finishedAt: '2026-01-01T00:00:04Z' })
  const m = model([ledger(1, withSpine, { result: 'passed', requiredPassed: 2, spineFailures: 0 }), ledger(2, withoutSpine, { result: 'passed', requiredPassed: 2, spineFailures: 0 })])
  m.evidence = [withSpine, withoutSpine]
  const b = compute(m)
  assert.match(b.invalid_entries.map((e) => e.message).join(' | '), /Spine shrank at A2: dropped A-2/)
  assert.equal(b.history_known, false)
  assert.equal(b.blocked, true)
})

test('both CLIs use only shared convergence budget computation', () => {
  for (const name of ['attempts', 'resume']) {
    const source = readFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), 'utf8')
    assert.match(source, /computeConvergence\(model/)
    assert.doesNotMatch(source, /function budgetPosition|function progressSignal|state\?\.replans/)
  }
})
