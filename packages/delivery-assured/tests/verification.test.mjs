import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountCases, buildEvidence } from '../scripts/verify.mjs'
import { EVIDENCE_GATES, validateEvidenceRecord } from '../scripts/lib/evidence.mjs'
import { requiredCaseIds } from '../scripts/lib/selection.mjs'
import { loadModel } from '../scripts/lib/model.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../project')
const model = loadModel(root)
const dir = mkdtempSync(join(tmpdir(), 'dapse-verification-unit-'))
const resultFile = join(dir, 'results.json')
const caseId = model.acceptance.cases[0].id
const context = {
  root, model, cfg: model.cfg, candidate: 'a'.repeat(40), parentBaseline: null, sliceId: 'S1',
  acceptance: model.acceptance, spine: model.spine, opts: { 'ci-run-id': 'unit-1' },
  expectedCaseIds: [caseId], runToken: 'unit-token', startedAt: new Date().toISOString(),
  verifier: { acceptance: { result_file: resultFile } },
}
let checks = 0
const report = () => ({ run_token: 'unit-token', filter: null, timed_out: false, results: [{ case_id: caseId, outcome: 'passed' }] })
function account(doc) {
  writeFileSync(resultFile, JSON.stringify(doc))
  return accountCases(context)
}
const env = { ...process.env }
try {
  assert.equal(accountCases(context).problems[0].code, 'NO_RESULT_FILE'); checks++
  const good = account(report())
  assert.deepEqual(good.problems, []); checks++
  const variants = [
    d => { d.results = [] },
    d => { d.run_token = 'previous-run' },
    d => { delete d.run_token },
    d => { d.results.push({ ...d.results[0] }) },
    d => { d.results.push({ case_id: 'A-UNKNOWN', outcome: 'passed' }) },
    d => { d.filter = { case_ids: [caseId] } },
    d => { d.timed_out = true },
    ...['failed', 'errored', 'skipped', 'not_run', 'garbage'].map(outcome => d => { d.results[0].outcome = outcome }),
  ]
  for (const mutate of variants) {
    const doc = report(); mutate(doc)
    assert.ok(account(doc).problems.length > 0); checks++
  }
  Object.assign(process.env, {
    DSH_STANDARD_REVISION: 'a'.repeat(40), DSH_VERIFIER_REVISION: 'a'.repeat(40),
    DSH_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`, DSH_DEPLOYED_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
    DSH_DEPLOYED_CODE_REVISION: context.candidate, DSH_DEPLOYMENT_ID: 'unit-deploy',
    DSH_CONFIG_FINGERPRINT: 'unit-config', DSH_FIXTURE_REVISION: 'unit-fixtures',
  })
  const gates = EVIDENCE_GATES.map(gate => ({ gate, outcome: 'passed', reason: '', exit_code: 0, duration_ms: 1 }))
  const make = patch => buildEvidence(context, { gateResults: gates, caseAccounting: good, issuer: 'ci:verify', structural: [], ...patch })
  assert.deepEqual(validateEvidenceRecord(make({})), []); checks++
  assert.equal(make({ structural: [{ level: 'fail', code: 'SPEC_DIFF', message: 'changed' }] }).execution.result, 'FAIL'); checks++
  assert.equal(make({ blocking: [{ code: 'GATE_FAILED' }] }).execution.result, 'FAIL'); checks++
  assert.equal(make({ gateResults: gates.slice(1) }).execution.result, 'FAIL'); checks++
  assert.equal(make({ caseAccounting: { ...good, failed: 1 } }).execution.result, 'FAIL'); checks++
  assert.deepEqual(make({ caseAccounting: { ...good, results: [] } }).scope.required_case_ids, [caseId]); checks++
  delete process.env.DSH_DEPLOYED_CODE_REVISION
  assert.ok(validateEvidenceRecord(make({})).length > 0); checks++
  const planningModel = {
    contract: { business_rules: [{ id: 'BR-CURRENT', severity: 'critical' }] },
    acceptance: { cases: [
      { id: 'A-NOW', required: true, method: 'automated', obligation_ids: ['J-NOW'] },
      { id: 'A-NEGATIVE', required: true, method: 'automated', obligation_ids: ['BR-CURRENT'] },
      { id: 'A-FUTURE', required: true, method: 'automated', obligation_ids: ['J-FUTURE'] },
      { id: 'A-OLD', required: true, method: 'automated', obligation_ids: ['J-OLD'] },
    ] },
    spine: { caseIds: ['A-OLD'] },
    slices: [{ id: 'S1', acceptance: ['A-NOW'], obligations: ['J-NOW', 'BR-CURRENT'] }],
  }
  assert.deepEqual(requiredCaseIds(planningModel, 'S1'), ['A-NEGATIVE', 'A-NOW', 'A-OLD']); checks++
  assert.throws(() => requiredCaseIds(planningModel, 'UNKNOWN'), /unknown Slice/); checks++
  planningModel.spine.caseIds.push('A-MISSING')
  assert.throws(() => requiredCaseIds(planningModel, 'S1'), /unknown acceptance/); checks++
} finally {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key]
  Object.assign(process.env, env)
  rmSync(dir, { recursive: true, force: true })
}
console.log(`verification.test ok: ${checks} checks passed`)
