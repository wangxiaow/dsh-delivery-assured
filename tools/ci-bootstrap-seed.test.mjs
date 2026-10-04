#!/usr/bin/env node
import assert from 'node:assert/strict'
import { validateBootstrapSeed } from '../ci/tools/ci-bootstrap-seed.mjs'
import { buildDiagnosticResolution } from '../ci/tools/ci-resolution.mjs'
import { standardDigest } from '../packages/delivery-assured/scripts/lib/convergence.mjs'
import { EVIDENCE_GATES } from '../packages/delivery-assured/scripts/lib/evidence.mjs'

let checks = 0
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++ }
const rejects = (input, pattern) => { assert.throws(() => validateBootstrapSeed(input), pattern); checks++ }
const empty = () => ({ seed: 'existing-ledger', attempts: [], evidence: [], receipts: [], diagnostics: [], resolutions: [] })
const clone = v => structuredClone(v)
function fixture(result = 'FAIL') {
  const input = empty()
  const receipt = { repository: 'offline/fixture', run_id: 12, run_attempt: 2, run_key: '12-2', verifier_revision: 'a'.repeat(40), conclusion: result === 'PASS' ? 'success' : 'failure', path: '.github/workflows/verify.yml', event: 'workflow_dispatch', head_branch: 'main', content_digest: 'c'.repeat(64) }
  const bindings = Object.fromEntries(['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'spine_manifest_digest', 'slice_manifest_digest'].map(k => [k, 'b'.repeat(64)]))
  Object.assign(bindings, { dependency_lock_digest: null, migration_digest: null, parent_baseline: null, code_revision: 'a'.repeat(40), contract_revision: 'a'.repeat(40), acceptance_revision: 'a'.repeat(40), verifier_config_revision: receipt.verifier_revision })
  const record = { evidence_id: 'ci:verify:12-2', issuer: { identity: 'ci:verify' }, bindings, environment: { kind: 'production_like_ci', config_fingerprint: 'b'.repeat(64), fixture_revision: 'a'.repeat(40), image_digest: `sha256:${'c'.repeat(64)}`, deployed_image_digest: `sha256:${'c'.repeat(64)}`, deployed_code_revision: 'a'.repeat(40), deployment_id: 'offline-deployment' }, convergence: { slice_key: 'S1', hypothesis: 'offline failure reproduction', root_cause_key: 'offline-failure' }, scope: { slice_id: 'S1', slice_key: 'S1', required_case_ids: ['C1'] }, structural_notes: [], execution: { ci_run_id: receipt.run_key, result, started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z', required_cases: 1, executed_cases: 1, skipped_required_cases: 0, case_results: [{ case_id: 'C1', outcome: result === 'PASS' ? 'passed' : 'failed' }], gate_results: EVIDENCE_GATES.map(gate => ({ gate, outcome: 'passed', exit_code: 0 })), artifacts: ['offline-results'] } }
  const attempt = { attempt_id: record.evidence_id, slice_id: 'S1', slice_key: 'S1', at: record.execution.finished_at, hypothesis: record.convergence.hypothesis, root_cause_key: record.convergence.root_cause_key, result: result === 'PASS' ? 'passed' : 'failed', standard_digest: standardDigest(bindings, record.environment), required_case_ids: ['C1'], required_total: 1, required_passed: result === 'PASS' ? 1 : 0, spine_failures: 0, critical_violations: [], ci_ref: record.evidence_id, note: '' }
  input.receipts.push(receipt); input.evidence.push(record); input.attempts.push(attempt)
  return input
}
function diagnostic(input, derived = true) {
  return JSON.stringify({ run_key: input.receipts[0].run_key, status: 'blocked', errors: ['offline artifact missing'], receipt: input.receipts[0], derived_attempt: derived }, null, 2) + '\n'
}
check(validateBootstrapSeed({ ...empty(), seed: 'owner-approved-empty' }), { diagnostic_only: true, run_keys: [] })
for (const field of ['attempts', 'evidence', 'receipts', 'diagnostics', 'resolutions']) rejects({ ...empty(), seed: 'owner-approved-empty', [field]: [{}] }, /erase/)
rejects({ ...empty(), evidence: undefined }, /array required/)
rejects({ ...empty(), seed: 'automatic' }, /decision/)
for (const outcome of ['FAIL', 'PASS', 'ERROR']) {
  const input = fixture(outcome), before = clone(input)
  check(validateBootstrapSeed(input), { diagnostic_only: true, run_keys: ['12-2'] })
  check(input, before)
}
const claimedIsolation = fixture(); claimedIsolation.evidence[0].trust = { transport_verified: true, runtime_isolation_verified: true }; rejects(claimedIsolation, /claimed runtime isolation/)
for (const change of [{ run_id: 0 }, { run_id: Number.MAX_SAFE_INTEGER + 1 }, { run_attempt: 0 }, { run_key: '012-2' }, { run_key: '12-1' }, { repository: 'unknown' }, { verifier_revision: 'unknown' }, { path: 'other.yml' }, { head_branch: 'feature' }, { event: 'pull_request' }, { conclusion: 'unknown' }, { content_digest: 'bad' }, { sourceVerified: true }]) {
  const input = fixture(); Object.assign(input.receipts[0], change); rejects(input, /invalid source receipt/)
}
for (const field of ['attempts', 'evidence', 'receipts']) { const input = fixture(); input[field].push(clone(input[field][0])); rejects(input, /duplicate/) }
for (const field of ['attempts', 'evidence', 'receipts']) { const input = fixture(); input[field] = []; rejects(input, /orphan|missing exact/) }
const runRef = fixture(); runRef.attempts[0].ci_ref = '12-2'; rejects(runRef, /missing exact/)
const mismatch = fixture(); mismatch.receipts[0].conclusion = 'success'; rejects(mismatch, /conclusion/)
const falsePass = fixture('PASS'); falsePass.evidence[0].execution.case_results[0].outcome = 'failed'; rejects(falsePass, /counts/)
const gates = fixture('PASS'); gates.evidence[0].execution.gate_results = []; rejects(gates, /incomplete PASS/)
for (const mutate of [i => { i.attempts[0].result = 'passed' }, i => { i.attempts[0].required_passed = 1 }, i => { i.evidence[0].execution.ci_run_id = '99-1' }, i => { i.evidence[0].bindings.verifier_config_revision = 'd'.repeat(40) }, i => { i.attempts[0].hypothesis = 'altered' }, i => { i.evidence[0].execution.finished_at = 'invalid' }]) { const input = fixture(); mutate(input); rejects(input) }
const infra = fixture(); infra.attempts[0].result = 'infra_aborted'; infra.evidence[0].execution.result = 'INFRA_ABORTED'; rejects(infra, /independent evidence/)
const replan = { attempt_id: 'replan-1', slice_id: 'S1', slice_key: 'S1', at: '2026-01-01T00:02:00Z', hypothesis: 'new offline approach', result: 'blocked', replan: { slice_id: 'S1', falsified_assumption: 'original assumption', previous_approach: 'previous offline approach', new_approach: 'new offline approach', next_discriminating_checks: ['C1'], preserved_obligations: ['O1'], scope_changed: false } }
const replans = fixture(); replans.attempts.push(replan); check(validateBootstrapSeed(replans).run_keys, ['12-2'])
const badReplan = clone(replans); badReplan.attempts[1].ci_ref = 'ci:verify:12-2'; rejects(badReplan, /Replan/)
const orphan = fixture(); orphan.attempts = []; orphan.evidence = []; orphan.diagnostics = [diagnostic(orphan, false)]; check(validateBootstrapSeed(orphan).run_keys, ['12-2'])
const parsed = clone(orphan); parsed.diagnostics = parsed.diagnostics.map(JSON.parse); check(validateBootstrapSeed(parsed).run_keys, ['12-2'])
const duplicateDiagnostic = clone(orphan); duplicateDiagnostic.diagnostics.push(duplicateDiagnostic.diagnostics[0]); rejects(duplicateDiagnostic, /duplicate/)
const wrongDiagnostic = clone(orphan); const wrong = JSON.parse(wrongDiagnostic.diagnostics[0]); wrong.receipt.conclusion = 'cancelled'; wrongDiagnostic.diagnostics = [wrong]; rejects(wrongDiagnostic, /source receipt mismatch/)
const countedDiagnostic = fixture(); countedDiagnostic.diagnostics = [diagnostic(countedDiagnostic)]; check(validateBootstrapSeed(countedDiagnostic).run_keys, ['12-2'])
const resolved = clone(countedDiagnostic)
resolved.resolutions = [buildDiagnosticResolution({ diagnosticText: resolved.diagnostics[0], evidence: [{ record: resolved.evidence[0], sourceReceipt: resolved.receipts[0] }], attempts: resolved.attempts, owner: 'offline-reviewer', confirmationRef: 'offline-reviewed/12-2', at: '2026-01-01T00:03:00Z' })]
check(validateBootstrapSeed(resolved), { diagnostic_only: true, run_keys: ['12-2'] })
for (const mutate of [i => { i.resolutions[0].diagnostic_digest = '0'.repeat(64) }, i => { i.resolutions[0].disposition = 'PASS' }, i => { i.resolutions[0].owner = 'unknown' }, i => { i.resolutions[0].run_key = '99-1' }, i => { i.resolutions.push(clone(i.resolutions[0])) }, i => { i.diagnostics = i.diagnostics.map(JSON.parse) }, i => { i.diagnostics[0] += ' ' }, i => { i.resolutions[0].sourceVerified = true }]) { const input = clone(resolved); mutate(input); rejects(input, /resolution|duplicate/) }
const badUncountedResolution = clone(orphan); badUncountedResolution.resolutions = clone(resolved.resolutions); rejects(badUncountedResolution, /resolution/)
console.log(`ci-bootstrap-seed.test ok: ${checks} synthesized offline checks`)
