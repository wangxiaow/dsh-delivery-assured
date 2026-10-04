import assert from 'node:assert/strict'
import { validateEvidenceRecord, EVIDENCE_GATES } from '../scripts/lib/evidence.mjs'
import { classifyEvidence } from '../scripts/lib/model.mjs'
import { coverageRows, proveCase, classifyManualReview } from '../scripts/lib/coverage-core.mjs'
import { assessMvpReady } from '../scripts/lib/mvp.mjs'
import { scopeForSlice } from '../scripts/lib/selection.mjs'

const revision = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const bindings = {
  code_revision: revision, contract_revision: revision, contract_digest: digest,
  acceptance_revision: revision, acceptance_manifest_digest: digest, acceptance_digest: digest,
  verifier_config_revision: revision, verifier_config_digest: digest,
  dependency_lock_digest: null, migration_digest: null, spine_manifest_digest: digest, slice_manifest_digest: digest,
  parent_baseline: null,
}
function validRecord() {
  return {
    evidence_id: 'ci:verify:1-1', issuer: { identity: 'ci:verify' },
    trust: { transport_verified: true, runtime_isolation_verified: true },
    scope: { slice_id: 'S1', obligation_ids: ['J-TEST'], required_case_ids: ['A-TEST'] },
    bindings: structuredClone(bindings),
    environment: {
      kind: 'production_like_ci', image_digest: `sha256:${digest}`, config_fingerprint: digest,
      fixture_revision: revision, deployment_id: 'cli-run-1-1', deployed_code_revision: revision,
      deployed_image_digest: `sha256:${digest}`,
    },
    execution: {
      ci_run_id: '1-1', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z',
      result: 'PASS', required_cases: 1, executed_cases: 1, skipped_required_cases: 0,
      case_results: [{ case_id: 'A-TEST', outcome: 'passed' }],
      gate_results: EVIDENCE_GATES.map(gate => ({ gate, outcome: 'passed', exit_code: 0 })),
      artifacts: ['acceptance-results.json'],
    },
    structural_notes: [], spine_case_ids: [],
  }
}
let checks = 0
function rejects(label, mutate) {
  const record = validRecord()
  mutate(record)
  assert.ok(validateEvidenceRecord(record).length > 0, label)
  checks += 1
}
assert.deepEqual(validateEvidenceRecord(validRecord()), [])
checks += 1
for (const key of Object.keys(bindings)) rejects(`missing ${key}`, r => delete r.bindings[key])
rejects('missing environment', r => delete r.environment)
rejects('local environment', r => { r.environment.kind = 'local_diagnostic' })
rejects('mismatched deployed code', r => { r.environment.deployed_code_revision = 'c'.repeat(40) })
rejects('mismatched deployed digest', r => { r.environment.deployed_image_digest = `sha256:${'c'.repeat(64)}` })
rejects('missing configuration fingerprint', r => { r.environment.config_fingerprint = '' })
rejects('placeholder acceptance revision', r => { r.bindings.acceptance_revision = 'frozen-by-job' })
rejects('missing case scope', r => { r.scope.required_case_ids = [] })
rejects('duplicate scope', r => { r.scope.required_case_ids.push('A-TEST') })
rejects('zero tests', r => { r.execution.required_cases = 0; r.execution.executed_cases = 0; r.execution.case_results = [] })
rejects('missing results', r => { r.execution.case_results = [] })
rejects('duplicate results', r => { r.execution.case_results.push({ case_id: 'A-TEST', outcome: 'passed' }) })
rejects('extra results', r => { r.execution.case_results.push({ case_id: 'A-EXTRA', outcome: 'passed' }) })
for (const outcome of ['failed', 'errored', 'skipped', 'not_run', 'unknown']) {
  rejects(outcome, r => { r.execution.case_results[0].outcome = outcome })
}
rejects('count mismatch', r => { r.execution.executed_cases = 2 })
rejects('hidden skip', r => { r.execution.skipped_required_cases = 1 })
rejects('missing gate', r => { r.execution.gate_results.pop() })
rejects('undeclared gate', r => { r.execution.gate_results[0].undeclared = true })
rejects('unexplained exclusion', r => { r.execution.gate_results[0].outcome = 'not_applicable' })
rejects('failed gate', r => { r.execution.gate_results[0].outcome = 'failed' })
rejects('nonzero passed gate', r => { r.execution.gate_results[0].exit_code = 1 })
rejects('structural failure', r => { r.structural_notes = ['fail:SPEC_DIFF:changed'] })
rejects('timeout', r => { r.execution.timed_out = true })
rejects('filter', r => { r.execution.filter = { case_ids: ['A-TEST'] } })

const model = {
  cfg: { sliceEnvironment: 'production_like_container', ci: { trusted_issuer: 'ci:verify' } },
  currentBindings: bindings, spine: { caseIds: [] },
  contract: { acceptance: { manual_reviews: [] } },
  acceptance: { cases: [{ id: 'A-TEST', required: true, method: 'automated', obligation_ids: ['J-TEST', 'J-TEST.done'] }] },
  obligations: new Map([
    ['J-TEST', { id: 'J-TEST', required: true, kind: 'journey' }],
    ['J-TEST.done', { id: 'J-TEST.done', required: true, kind: 'outcome', parent: 'J-TEST' }],
  ]),
  slices: [{ id: 'S1', acceptance: ['A-TEST'], obligations: ['J-TEST', 'J-TEST.done'] }], reviews: [], evidence: [validRecord()],
}
const options = { model, codeRevision: revision, trustedIssuer: 'ci:verify', parentBaseline: null }
assert.equal(classifyEvidence(validRecord(), options).fresh, true)
checks += 1
for (const field of ['acceptance_digest', 'verifier_config_digest', 'spine_manifest_digest']) {
  const r = validRecord()
  r.bindings[field] = 'c'.repeat(64)
  assert.equal(classifyEvidence(r, options).fresh, false, `${field} drift`)
  checks += 1
}
const unexecuted = validRecord()
unexecuted.execution.case_results[0].outcome = 'not_run'
model.evidence = [unexecuted]
assert.equal(coverageRows(model, { candidate: revision, trustedIssuer: 'ci:verify' }).buckets.verified.length, 0)
checks += 1
// A later failing run must not be hidden by an older PASS for identical bindings.
const failed = validRecord()
failed.evidence_id = 'ci:verify:2-1'
failed.execution.finished_at = '2026-01-01T00:00:02Z'
failed.execution.result = 'FAIL'
failed.execution.case_results[0].outcome = 'failed'
model.evidence = [failed, validRecord()]
assert.equal(proveCase(model, 'A-TEST', options).outcome, 'failed')
checks += 1
// Journey verification includes every Required result, even if the parent has a PASS.
model.obligations.set('J-TEST.later', { id: 'J-TEST.later', required: true, kind: 'outcome', parent: 'J-TEST' })
model.evidence = [validRecord()]
const result = coverageRows(model, { candidate: revision, trustedIssuer: 'ci:verify' })
assert.notEqual(result.rows.find(r => r.id === 'J-TEST').status, 'VERIFIED')
checks += 1
const reviewModel = { ...model, currentBindings: { ...bindings }, evidence: [validRecord()], spine: { caseIds: [] }, baselines: [] }
const definition = { id: 'R-TEST', reviewer: 'product_owner' }
const review = { review_id: 'R-TEST', reviewer: 'product_owner', result: 'PASS', confirmation_ref: 'owner:review-1', bindings: { ...bindings, image_digest: validRecord().environment.image_digest, deployment_id: validRecord().environment.deployment_id } }
const reviewOptions = { candidate: revision, parentBaseline: null, trustedIssuer: 'ci:verify' }
assert.equal(classifyManualReview(review, definition, reviewModel, reviewOptions).status, 'VERIFIED'); checks++
for (const field of ['code_revision', 'contract_revision', 'acceptance_revision', 'contract_digest', 'acceptance_digest', 'image_digest', 'deployment_id']) {
  const changed = structuredClone(review); changed.bindings[field] = 'old-binding'
  assert.notEqual(classifyManualReview(changed, definition, reviewModel, reviewOptions).status, 'VERIFIED'); checks++
}
// A record's own trust flags are claims, not authentication: the real collector
// writes transport=true / isolation=false, which must still classify as fresh;
// a hand-written file claiming both must not become "attested" locally.
const collected = validRecord()
collected.trust = { transport_verified: true, runtime_isolation_verified: false }
const collectedResult = classifyEvidence(collected, { ...options, model: reviewModel })
assert.equal(collectedResult.fresh, true); checks++
assert.equal(collectedResult.attested, false); checks++
assert.deepEqual(collectedResult.claims, { transport: true, isolation: false }); checks++
const unattested = validRecord(); delete unattested.trust
const unattestedResult = classifyEvidence(unattested, { ...options, model: reviewModel })
assert.equal(unattestedResult.fresh, true); checks++
assert.equal(unattestedResult.attested, false); checks++
const claimed = validRecord()
claimed.trust = { transport_verified: true, runtime_isolation_verified: true }
assert.equal(classifyEvidence(claimed, { ...options, model: reviewModel }).attested, false); checks++
assert.equal(classifyEvidence(claimed, { ...options, model: reviewModel, attested: true }).attested, true); checks++
const incompleteScope = validRecord(); incompleteScope.scope.required_case_ids = ['A-OTHER']
assert.equal(classifyEvidence(incompleteScope, { ...options, model: reviewModel }).fresh, false); checks++
const finalRecord = validRecord(); finalRecord.environment.kind = 'staging'
finalRecord.scope.obligation_ids = ['C-TEST']
const finalModel = { ...reviewModel,
  contract: { journeys: [], business_rules: [], acceptance: { manual_reviews: [] }, deployment: { release_prerequisites: ['reviewed-release'], operational_acceptance_ids: ['A-TEST'] } },
  obligations: new Map([['C-TEST', { id: 'C-TEST', kind: 'capability', required: true }]]),
  slices: [{ id: 'S1', obligations: ['C-TEST'], acceptance: ['A-TEST'] }],
  acceptance: { cases: [{ id: 'A-TEST', method: 'automated', required: true, obligation_ids: ['C-TEST'] }] },
}
const release = { confirmation_ref: 'owner:release-1', bindings: { code_revision: revision, contract_digest: digest, acceptance_digest: digest, image_digest: finalRecord.environment.image_digest, deployment_id: finalRecord.environment.deployment_id }, prerequisites: [{ id: 'reviewed-release', result: 'PASS' }] }
assert.equal(assessMvpReady(finalModel, finalRecord, release).ready, true); checks++
assert.equal(assessMvpReady(finalModel, validRecord(), release).ready, false); checks++
assert.equal(assessMvpReady(finalModel, finalRecord, null).ready, false); checks++
// Runtime isolation is recorded as a warning, not a readiness gate (owner
// decision): a staging record without an isolation attestation is still judged
// by deployment, scope, reviews and release prerequisites alone.
const noIsolation = structuredClone(finalRecord)
noIsolation.trust = { transport_verified: true, runtime_isolation_verified: false }
assert.equal(assessMvpReady(finalModel, noIsolation, release).ready, true); checks++

const partial = { ...reviewModel,
  contract: { journeys: [{ id: 'J-TEST', outcomes: [{ id: 'J-TEST.done', required: true }, { id: 'J-TEST.accepted', required: true }] }], business_rules: [], acceptance: { manual_reviews: [] } },
  obligations: new Map([
    ['J-TEST', { id: 'J-TEST', kind: 'journey', required: true }],
    ['J-TEST.done', { id: 'J-TEST.done', kind: 'outcome', parent: 'J-TEST', required: true }],
    ['J-TEST.accepted', { id: 'J-TEST.accepted', kind: 'outcome', parent: 'J-TEST', required: true }],
  ]),
  slices: [{ id: 'S1', obligations: ['J-TEST'], outcomes: ['J-TEST.done'], acceptance: ['A-TEST'] }, { id: 'S2', obligations: ['J-TEST'], outcomes: ['J-TEST.accepted'], acceptance: ['A-FUTURE'] }],
  acceptance: { cases: [...reviewModel.acceptance.cases, { id: 'A-FUTURE', method: 'automated', required: true, obligation_ids: ['J-TEST.accepted'] }] },
}
const partialCoverage = coverageRows(partial, reviewOptions)
assert.equal(partialCoverage.rows.find(r => r.id === 'J-TEST').status, 'PENDING_IMPLEMENTATION'); checks++
assert.equal(partialCoverage.rows.find(r => r.id === 'J-TEST.done').status, 'VERIFIED'); checks++
const selected = scopeForSlice(partial, 'S1')
assert.deepEqual(selected.caseIds, ['A-TEST']); checks++
assert.equal(selected.obligationIds.includes('J-TEST'), false); checks++
assert.equal(partialCoverage.rows.filter(r => selected.obligationIds.includes(r.id)).every(r => r.status === 'VERIFIED'), true); checks++

// Promotion adds the already-passing cases to the Spine. The CI-bound metadata
// must link both digests, otherwise the post-promotion PASS is stale immediately.
model.currentBindings = { ...bindings, spine_manifest_digest: 'c'.repeat(64) }
model.spine.caseIds = ['A-TEST']
model.baselines = [{
  baseline_id: 'BL-000', code_revision: revision, parent_baseline: null,
  evidence_refs: ['ci:verify:1-1'], accumulated_spine_case_ids: ['A-TEST'],
  accumulated_spine_manifest_digest: 'c'.repeat(64),
  verification_scope: { spine_manifest_digest: digest },
}]
assert.equal(classifyEvidence(validRecord(), { ...options, parentBaseline: 'BL-000' }).fresh, true); checks++
delete model.baselines[0].accumulated_spine_manifest_digest
assert.equal(classifyEvidence(validRecord(), { ...options, parentBaseline: 'BL-000' }).fresh, false); checks++
console.log(`evidence.test ok: ${checks} checks passed`)
