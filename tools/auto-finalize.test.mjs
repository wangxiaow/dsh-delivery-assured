import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeAutoMvp } from '../ci/tools/ci-auto-mvp.mjs'
import { EVIDENCE_GATES } from '../packages/delivery-assured/scripts/lib/evidence.mjs'
import { sha256 } from '../packages/delivery-assured/scripts/lib/common.mjs'

function fixture() {
  const revision = 'a'.repeat(40), digest = 'b'.repeat(64)
  const bindings = { code_revision: revision, contract_revision: revision, contract_digest: digest, acceptance_revision: revision, acceptance_manifest_digest: digest, acceptance_digest: digest, verifier_config_revision: revision, verifier_config_digest: digest, dependency_lock_digest: null, migration_digest: null, spine_manifest_digest: digest, slice_manifest_digest: digest, parent_baseline: null }
  const record = { evidence_id: 'ci:verify:12-1', issuer: { identity: 'ci:verify' }, scope: { slice_id: 'S1', obligation_ids: ['C-TEST'], required_case_ids: ['A-JOURNEY'] }, bindings,
    environment: { kind: 'production_like_ci', image_digest: `sha256:${digest}`, config_fingerprint: digest, fixture_revision: revision, deployment_id: 'install-12-1', deployed_code_revision: revision, deployed_image_digest: `sha256:${digest}` },
    execution: { ci_run_id: '12-1', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z', result: 'PASS', required_cases: 1, executed_cases: 1, skipped_required_cases: 0, case_results: [{ case_id: 'A-JOURNEY', outcome: 'passed' }], gate_results: EVIDENCE_GATES.map(gate => ({ gate, outcome: 'passed', exit_code: 0 })), artifacts: ['results.json'] }, structural_notes: [], spine_case_ids: [] }
  const model = { cfg: { mvpReadyEnvironment: 'production_like_ci', ci: { trusted_issuer: 'ci:verify' } }, currentBindings: bindings, spine: { caseIds: ['A-JOURNEY'] }, baselines: [], attempts: [], reviews: [], evidence: [record],
    contract: { completion_policy: { mode: 'independent_auto', authorization_ref: 'user:automatic-delivery' }, journeys: [], business_rules: [], unknowns: [], acceptance: { manual_reviews: [], automated_reviews: [{ id: 'AR-JOURNEY', obligation_ids: ['C-TEST'], case_ids: ['A-JOURNEY'] }] }, deployment: { mvp_ready_environment: 'production_like_ci', release_prerequisites: [{ id: 'protected-main', verification: 'required_checks' }], operational_acceptance_ids: ['A-JOURNEY'], environment_limitations: ['No claim about subjective usability'] } },
    obligations: new Map([['C-TEST', { id: 'C-TEST', kind: 'capability', required: true }]]), slices: [{ id: 'S1', obligations: ['C-TEST'], acceptance: ['A-JOURNEY'] }], acceptance: { cases: [{ id: 'A-JOURNEY', method: 'automated', required: true, obligation_ids: ['C-TEST'] }] } }
  const options = { sourceDigest: sha256(JSON.stringify(record)), finalizationRun: '13-1', finalizerRevision: revision, sourceReference: 'https://github.com/owner/repo/actions/runs/12/attempts/1' }
  const receipt = { result: 'PASS', confirmation_ref: 'https://api.github.com/repos/owner/repo/branches/main/protection', bindings: { ...bindings, image_digest: record.environment.image_digest, deployment_id: record.environment.deployment_id }, prerequisites: [{ id: 'protected-main', result: 'PASS', observation: { required_checks: ['structural checks', 'verify candidate'] } }] }
  return { model, record, options, receipt }
}

test('independent automated finalization needs no owner receipt and never rewrites evidence', () => {
  const { model, record, receipt, options } = fixture()
  const before = JSON.stringify({ model, record })
  const result = finalizeAutoMvp(model, record, receipt, options)
  assert.equal(result.ready, true, result.blocking?.join('\n'))
  assert.equal(result.completion_mode, 'independent_auto')
  assert.equal(result.owner_confirmation, undefined)
  assert.equal(result.automated_reviews[0].result, 'PASS')
  assert.deepEqual(result.limitations, ['No claim about subjective usability'])
  assert.equal(JSON.stringify({ model, record }), before)
})

test('auto mode does not silently drop a remaining human obligation', () => {
  const { model, record, receipt, options } = fixture()
  model.contract.acceptance.manual_reviews = [{ id: 'R-OLD', obligation_ids: ['C-TEST'], reviewer: 'product_owner' }]
  assert.equal(finalizeAutoMvp(model, record, receipt, options).ready, false)
})

test('missing, skipped, stale or failed execution and release checks cannot auto-deliver', () => {
  for (const change of [
    f => { f.record.execution.case_results = [] },
    f => { f.record.execution.case_results[0].outcome = 'skipped' },
    f => { f.record.execution.result = 'FAIL' },
    f => { f.record.bindings.contract_digest = 'c'.repeat(64) },
    f => { f.receipt.prerequisites[0].result = 'UNVERIFIED' },
    f => { f.model.contract.acceptance.automated_reviews[0].case_ids = [] },
    f => { f.model.contract.acceptance.automated_reviews[0].case_ids = ['A-NOT-EXECUTED'] },
    f => { f.model.contract.completion_policy.mode = 'human_review' },
    f => { f.options.sourceDigest = '' },
  ]) {
    const f = fixture(); change(f)
    assert.equal(finalizeAutoMvp(f.model, f.record, f.receipt, f.options).ready, false)
  }
})
