import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildDiagnosticResolution, unresolvedDiagnostics } from '../ci/tools/ci-resolution.mjs'
import { standardDigest } from '../packages/delivery-assured/scripts/lib/convergence.mjs'

// Synthetic local retained-state fixtures, NOT authenticated owner approval.
function fixture() {
  const receipt = { repository: 'fixture/repo', run_id: 12, run_attempt: 2, run_key: '12-2', verifier_revision: 'a'.repeat(40), path: '.github/workflows/verify.yml', event: 'workflow_dispatch', head_branch: 'main', conclusion: 'failure' }
  const record = {
    evidence_id: 'ci:fixture:12-2', issuer: { identity: 'ci:fixture' },
    bindings: Object.fromEntries(['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'dependency_lock_digest', 'migration_digest', 'spine_manifest_digest', 'slice_manifest_digest'].map(k => [k, 'b'.repeat(64)])),
    scope: { slice_id: 'S1', slice_key: 'S1', required_case_ids: ['case-1'] },
    convergence: { hypothesis: 'Synthetic failure retained', root_cause_key: 'fixture-failure', slice_key: 'S1' },
    environment: { kind: 'production_like_ci', config_fingerprint: 'b'.repeat(64), fixture_revision: 'a'.repeat(40) },
    execution: { ci_run_id: '12-2', result: 'FAIL', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z', required_cases: 1, executed_cases: 1, skipped_required_cases: 0, case_results: [{ case_id: 'case-1', outcome: 'failed' }] },
  }
  record.bindings.verifier_config_revision = receipt.verifier_revision
  const attempt = { attempt_id: record.evidence_id, ci_ref: record.evidence_id, slice_id: 'S1', slice_key: 'S1', at: record.execution.finished_at, hypothesis: record.convergence.hypothesis, root_cause_key: record.convergence.root_cause_key, result: 'failed', standard_digest: standardDigest(record.bindings, record.environment), required_case_ids: ['case-1'], required_total: 1, required_passed: 0, spine_failures: 0, critical_violations: [] }
  return { diagnosticText: JSON.stringify({ run_key: '12-2', status: 'blocked', errors: ['retained artifact missing'], receipt, derived_attempt: true }, null, 2) + '\n', evidence: [{ record, sourceReceipt: structuredClone(receipt) }], attempts: [attempt], owner: 'alice-maintainer', confirmationRef: 'local-fixture:approval-17', at: '2026-01-01T00:02:00Z' }
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function diagnosticChange(f, mutate) { const d = JSON.parse(f.diagnosticText); mutate(d); f.diagnosticText = JSON.stringify(d) }

test('retained counted failure resolves exact original bytes without mutation or Coverage output', () => {
  const f = freeze(fixture()), before = JSON.stringify(f)
  const r = buildDiagnosticResolution(f)
  assert.deepEqual(Object.keys(r), ['run_key', 'diagnostic_digest', 'owner', 'confirmation_ref', 'resolved_at', 'disposition', 'attempt_id'])
  assert.equal(r.diagnostic_digest, createHash('sha256').update(f.diagnosticText).digest('hex'))
  assert.equal(r.disposition, 'retained-counted-failure')
  assert.deepEqual(unresolvedDiagnostics([f], [r]), [])
  assert.equal(JSON.stringify(f), before)
  assert.equal(Object.isFrozen(r), true)
})
test('retained ERROR also derives a failed counted attempt', () => {
  const f = fixture()
  f.evidence[0].record.execution.result = 'ERROR'
  assert.deepEqual(unresolvedDiagnostics([f], [buildDiagnosticResolution(f)]), [])
})
const invalid = {
  'missing evidence': f => { f.evidence = [] },
  'missing counted attempt': f => { f.attempts = [] },
  'no derived attempt': f => diagnosticChange(f, d => { d.derived_attempt = false }),
  'truthy derived attempt': f => diagnosticChange(f, d => { d.derived_attempt = 'true' }),
  'infra aborted': f => { f.attempts[0].result = 'infra_aborted' },
  'PASS attempt': f => { f.attempts[0].result = 'passed' },
  'PASS evidence': f => { f.evidence[0].record.execution.result = 'PASS' },
  'BLOCKED evidence': f => { f.evidence[0].record.execution.result = 'BLOCKED' },
  'replan': f => { f.attempts[0].replan = false },
  'ambiguous attempts': f => { f.attempts.push(structuredClone(f.attempts[0])) },
  'duplicate attempt identity': f => { f.attempts.push({ ...f.attempts[0], ci_ref: 'other' }) },
  'ambiguous evidence': f => { f.evidence.push(structuredClone(f.evidence[0])) },
  'missing source receipt': f => { delete f.evidence[0].sourceReceipt },
  'mismatched repository': f => { f.evidence[0].sourceReceipt.repository = 'other/repo' },
  'mismatched verifier source': f => { f.evidence[0].sourceReceipt.verifier_revision = 'c'.repeat(40) },
  'mismatched verifier evidence': f => { f.evidence[0].record.bindings.verifier_config_revision = 'c'.repeat(40) },
  'mismatched run': f => { f.evidence[0].record.execution.ci_run_id = '12-3' },
  'invalid attempt counts': f => { f.attempts[0].required_total = 0 },
  'unknown attempt field': f => { f.attempts[0].counted = true },
  'mismatched case accounting': f => { f.evidence[0].record.execution.executed_cases = 0 },
  'malformed owner': f => { f.owner = 42 },
  'empty owner': f => { f.owner = '' },
  'placeholder owner': f => { f.owner = 'TODO' },
  'template owner': f => { f.owner = '<owner>' },
  'malformed ref': f => { f.confirmationRef = null },
  'empty ref': f => { f.confirmationRef = ' ' },
  'placeholder ref': f => { f.confirmationRef = 'TBD' },
  'invalid timestamp': f => { f.at = 'not-a-date' },
  'non ISO timestamp': f => { f.at = 'January 1, 2026' },
  'rolled date': f => { f.at = '2026-02-30T00:00:00Z' },
  'pre-attempt timestamp': f => { f.at = '2025-01-01T00:00:00Z' },
}
for (const [name, mutate] of Object.entries(invalid)) test(`rejects ${name}`, () => {
  const good = fixture(), r = buildDiagnosticResolution(good), f = fixture(); mutate(f)
  assert.throws(() => buildDiagnosticResolution(f))
  // Bad retained context stays blocking even with an earlier valid proposal.
  const proposal = { ...r, owner: f.owner, confirmation_ref: f.confirmationRef, resolved_at: f.at }
  assert.deepEqual(unresolvedDiagnostics([f], [proposal]), [f])
})
test('wrong digest, stale bytes, duplicates, conflicts and malformed records fail closed', () => {
  const f = fixture(), r = buildDiagnosticResolution(f)
  for (const resolutions of [null, [], [{ ...r, diagnostic_digest: '0'.repeat(64) }], [r, r], [r, { ...r, owner: 'other-maintainer' }], [r, { run_key: r.run_key }], [{ ...r, attempt_id: 'other' }], [{ ...r, disposition: 'passed' }], [{ ...r, owner: 'TODO' }], [{ ...r, confirmation_ref: '' }], [{ ...r, resolved_at: 'bad' }], [{ ...r, extra: true }]]) {
    assert.deepEqual(unresolvedDiagnostics([f], resolutions), [f])
  }
  const changed = { ...f, diagnosticText: f.diagnosticText + ' ' }
  assert.deepEqual(unresolvedDiagnostics([changed], [r]), [changed])
  assert.deepEqual(unresolvedDiagnostics([JSON.parse(f.diagnosticText)], [r]), [JSON.parse(f.diagnosticText)])
  assert.deepEqual(unresolvedDiagnostics([f, f], [r]), [f, f])
})
test('a resolution never clears another diagnostic', () => {
  const f = fixture(), r = buildDiagnosticResolution(f), other = fixture()
  diagnosticChange(other, d => { d.run_key = '13-2'; d.receipt.run_id = 13; d.receipt.run_key = '13-2' })
  assert.deepEqual(unresolvedDiagnostics([f, other], [r]), [other])
})

// A successful verification whose *collection* was refused never reached an attempt.
// Nothing was counted, so it is acknowledged as unrecorded — but only while it is
// provable that no attempt or evidence for that run exists.
function bookkeepingFixture() {
  const receipt = { repository: 'fixture/repo', run_id: 21, run_attempt: 1, run_key: '21-1', verifier_revision: 'd'.repeat(40), path: '.github/workflows/verify.yml', event: 'workflow_dispatch', head_branch: 'main', conclusion: 'success' }
  return {
    diagnosticText: JSON.stringify({ run_key: '21-1', status: 'blocked', errors: ['invalid attempt history: comparison rebase missing approval'], receipt, derived_attempt: false, receipt_written: true }, null, 2) + '\n',
    evidence: [], attempts: [], owner: 'alice-maintainer', confirmationRef: 'local-fixture:root-cause-fixed-21', at: '2026-01-02T00:00:00Z',
  }
}

test('a successful run with a refused collection is acknowledged as unrecorded, not silently dropped', () => {
  const f = bookkeepingFixture(), before = JSON.stringify(f)
  const r = buildDiagnosticResolution(f)
  assert.equal(r.disposition, 'acknowledged-unrecorded-bookkeeping-failure')
  assert.equal(r.attempt_id, null)
  assert.equal(r.diagnostic_digest, createHash('sha256').update(f.diagnosticText).digest('hex'))
  assert.deepEqual(Object.keys(r), ['run_key', 'diagnostic_digest', 'owner', 'confirmation_ref', 'resolved_at', 'disposition', 'attempt_id'])
  assert.deepEqual(unresolvedDiagnostics([f], [r]), [])
  assert.equal(JSON.stringify(f), before)
  assert.equal(Object.isFrozen(r), true)
})

test('an unrecorded acknowledgement cannot swallow a real attempt, evidence or a placeholder reason', () => {
  const mutations = {
    'linked evidence exists': f => { const linked = fixture().evidence[0]; linked.record.execution.ci_run_id = '21-1'; f.evidence = [linked] },
    'linked attempt exists': f => { const linked = fixture().attempts[0]; linked.ci_ref = 'ci:verify:21-1'; linked.attempt_id = 'ci:verify:21-1'; f.attempts = [linked] },
    'placeholder reason': f => { f.confirmationRef = 'TODO' },
    'invalid timestamp': f => { f.at = 'not-a-date' },
    'missing receipt': f => { delete JSON.parse(f.diagnosticText).receipt; f.diagnosticText = JSON.stringify({ run_key: '21-1', status: 'blocked', errors: ['x'], derived_attempt: false }) },
    'unknown derived state': f => { const d = JSON.parse(f.diagnosticText); delete d.derived_attempt; f.diagnosticText = JSON.stringify(d) },
    'no retained error': f => { const d = JSON.parse(f.diagnosticText); d.errors = []; f.diagnosticText = JSON.stringify(d) },
  }
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = bookkeepingFixture()
    mutate(f)
    assert.throws(() => buildDiagnosticResolution(f), name)
    // The proposal's own owner/ref/timestamp are supplied by the caller, so only a
    // mutated retained context can make an otherwise valid proposal stop matching.
    if (!['placeholder reason', 'invalid timestamp'].includes(name)) {
      const proposal = buildDiagnosticResolution(bookkeepingFixture())
      assert.deepEqual(unresolvedDiagnostics([f], [proposal]), [f], name)
    }
  }
})
