import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { parseYaml } from '../packages/delivery-assured/scripts/lib/yaml.mjs'
import { recordReplan } from '../ci/tools/ci-replan.mjs'
import { loadModel } from '../packages/delivery-assured/scripts/lib/model.mjs'
import { requiredObligations, sha256 } from '../packages/delivery-assured/scripts/lib/common.mjs'
import { requiredCaseIds } from '../packages/delivery-assured/scripts/lib/selection.mjs'
import { attemptFromCI } from '../packages/delivery-assured/scripts/lib/convergence.mjs'
import { budgetPrecheck } from '../ci/tools/ci-record.mjs'
import { EVIDENCE_GATES } from '../packages/delivery-assured/scripts/lib/evidence.mjs'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'ci-replan-fixture-')), fixture = join(work, 'repo'), remote = join(work, 'remote.git')
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks++ }
const throws = (fn, pattern) => { assert.throws(fn, pattern); checks++ }
git(work, ['clone', '--quiet', '--local', '--no-hardlinks', repo, fixture])
git(work, ['init', '--bare', '--quiet', remote])
git(fixture, ['remote', 'set-url', 'origin', remote])
git(fixture, ['config', 'user.name', 'Synthetic Replan Fixture'])
git(fixture, ['config', 'user.email', 'fixture@example.invalid'])
const project = join(fixture, 'project'), initial = loadModel(project), revision = git(fixture, ['rev-parse', 'HEAD']), cases = requiredCaseIds(initial, 'S1')
const image = `sha256:${'b'.repeat(64)}`
const records = [1, 2, 3].map(n => ({
  evidence_id: `ci:fixture:${n}`, issuer: { identity: initial.cfg.ci.trusted_issuer }, trust: { transport_verified: true, runtime_isolation_verified: false },
  bindings: { ...initial.currentBindings, code_revision: revision, parent_baseline: null }, scope: { slice_id: 'S1', required_case_ids: cases }, spine_case_ids: [],
  environment: { kind: 'production_like_ci', image_digest: image, deployed_image_digest: image, deployed_code_revision: revision, deployment_id: `fixture-${n}`, config_fingerprint: initial.currentBindings.verifier_config_digest, fixture_revision: revision },
  convergence: { root_cause_key: n === 2 ? 'GATE_FAILED' : 'fixed-candidate-verification', hypothesis: 'explicitly synthetic offline fixture' },
  execution: { result: n === 2 ? 'FAIL' : 'PASS', ci_run_id: `fixture-${n}`, started_at: `2026-01-01T00:00:0${n}Z`, finished_at: `2026-01-01T00:00:0${n + 1}Z`, required_cases: cases.length, executed_cases: cases.length, skipped_required_cases: 0, case_results: cases.map(case_id => ({ case_id, outcome: 'passed' })), gate_results: EVIDENCE_GATES.map(gate => ({ gate, outcome: n === 2 && gate === 'build' ? 'failed' : 'passed', exit_code: n === 2 && gate === 'build' ? 1 : 0 })), artifacts: ['fixture-report.json'] },
}))
mkdirSync(join(project, 'ci', 'evidence'), { recursive: true })
records.forEach(r => writeFileSync(join(project, 'ci/evidence', `${sha256(r.evidence_id)}.json`), JSON.stringify(r)))
const ledger = records.map(r => JSON.stringify(attemptFromCI(r, initial))).join('\n') + '\n'
writeFileSync(join(project, '.agent/attempts.jsonl'), ledger)
git(fixture, ['add', '-f', 'project/.agent/attempts.jsonl', 'project/ci/evidence'])
git(fixture, ['commit', '--quiet', '-m', 'synthetic state and new candidate; never genuine CI'])
const sourceRevision = git(fixture, ['rev-parse', 'HEAD'])
git(fixture, ['push', '--quiet', 'origin', 'HEAD:refs/heads/delivery-state/main'])
check(budgetPrecheck(loadModel(project), 'S1', 'S1').blockers.some(s => s.includes('Replan')), 'real-shaped pass/fail/pass history blocks a newer candidate without a formal Replan')
const proposal = { id: 'RP-MVP-FINALIZATION', previous_evidence_ref: records[2].evidence_id, slice_id: 'S1', falsified_assumption: 'a later owner Review could be followed by redeploying without changing receipt bindings', previous_approach: 'rerun verification after review', new_approach: 'authenticate original immutable source and separate final owner readiness', next_discriminating_checks: ['same original image and deployment, no extra Candidate attempt', 'all Required and Spine cases'], preserved_obligations: requiredObligations(initial.contract).map(o => o.id), scope_changed: false }
const options = { repo: fixture, project, proposal, sourceRevision, runKey: '101-1', expectedState: sourceRevision }
const result = recordReplan(options)
check(result.status === 'recorded', 'trusted state-only CI service persists a formal Replan')
const nextLedger = git(fixture, ['show', `${result.state_sha}:project/.agent/attempts.jsonl`]) + '\n'
check(nextLedger.startsWith(ledger), 'all original attempts remain byte-for-byte unchanged')
writeFileSync(join(project, '.agent/attempts.jsonl'), nextLedger)
const receiptFile = join(fixture, result.receipt_ref)
mkdirSync(dirname(receiptFile), { recursive: true })
writeFileSync(receiptFile, git(fixture, ['show', `${result.state_sha}:${result.receipt_ref}`]) + '\n')
const after = budgetPrecheck(loadModel(project), 'S1', 'S1')
check(after.budget.counted === 3 && after.budget.replans === 1 && after.budget.remaining === 5, 'Replan consumes 1/2 Replan quota, not a fourth Candidate attempt and never resets 3/8')
check(!after.blockers.length, 'formal recorded Replan permits the next fixed candidate under unchanged budgets')
const fresh = { ...options, expectedState: result.state_sha }
check(recordReplan(fresh).status === 'duplicate', 'retry is idempotent and consumes no additional Replan quota')
throws(() => recordReplan({ ...fresh, proposal: { ...proposal, new_approach: 'rewritten same identity' } }), /immutable.*conflict/)
throws(() => recordReplan(options), /state moved/)
const changed = { ...proposal, id: 'RP-SECOND' }
throws(() => recordReplan({ ...fresh, proposal: changed }), /duplicate.*run/ )
throws(() => recordReplan({ ...fresh, runKey: '102-1', proposal: { ...changed, previous_evidence_ref: records[0].evidence_id } }), /latest counted/)
throws(() => recordReplan({ ...fresh, runKey: '102-1', proposal: { ...changed, preserved_obligations: proposal.preserved_obligations.slice(1) } }), /preserve every/)
throws(() => recordReplan({ ...fresh, runKey: '102-1', proposal: { ...changed, scope_changed: true } }), /identity\/scope changed/)
throws(() => recordReplan({ ...fresh, sourceRevision: 'a'.repeat(40) }), /source\/state\/run identity/)
writeFileSync(join(project, '.agent/attempts.jsonl'), nextLedger + '{}\n')
throws(() => recordReplan({ ...fresh, runKey: '102-1', proposal: changed }), /snapshot.*mismatch/)
writeFileSync(join(project, '.agent/attempts.jsonl'), nextLedger)
const cfgPath = join(project, '.agent/project.yaml'), originalCfg = readFileSync(cfgPath, 'utf8')
const corruptedCfg = originalCfg.replace('replan_limit: 2', 'replan_limit: 9')
check(corruptedCfg !== originalCfg, 'negative control really changes the frozen Replan limit')
writeFileSync(cfgPath, corruptedCfg)
throws(() => recordReplan({ ...fresh, runKey: '102-1', proposal: changed }), /project inputs differ/)
writeFileSync(cfgPath, originalCfg)
const loosePath = join(project, '.agent/evidence/non-durable-control.json')
mkdirSync(dirname(loosePath), { recursive: true })
const loose = structuredClone(records[2])
loose.evidence_id = 'ci:fixture:non-durable'
loose.execution.finished_at = new Date(Date.now() - 30000).toISOString()
writeFileSync(loosePath, JSON.stringify(loose))
throws(() => recordReplan({ ...fresh, runKey: '104-1', proposal: { ...changed, previous_evidence_ref: loose.evidence_id } }), /non-durable evidence/)
writeFileSync(loosePath, '{}')
const second = recordReplan({ ...fresh, runKey: '102-1', proposal: changed })
const secondLedger = git(fixture, ['show', `${second.state_sha}:project/.agent/attempts.jsonl`]) + '\n'
writeFileSync(join(project, '.agent/attempts.jsonl'), secondLedger)
const secondReceipt = join(fixture, second.receipt_ref)
writeFileSync(secondReceipt, git(fixture, ['show', `${second.state_sha}:${second.receipt_ref}`]) + '\n')
throws(() => recordReplan({ ...fresh, runKey: '103-1', expectedState: second.state_sha, proposal: { ...proposal, id: 'RP-THIRD' } }), /quota exhausted/)
const marker = git(fixture, ['ls-tree', '-r', '--name-only', second.state_sha, 'project/ci/mvp-ready.json'])
check(marker === '' && git(fixture, ['show', `${second.state_sha}:project/ci/evidence/${sha256(records[1].evidence_id)}.json`]) === JSON.stringify(records[1]), 'Replan never creates readiness or converts the original failed Evidence into PASS')
const workflow = parseYaml(readFileSync(join(repo, '.github/workflows/record-replan.yml'), 'utf8'))
const job = workflow.jobs['record-replan'], text = JSON.stringify(job)
check(workflow.concurrency.group === 'delivery-state-main' && workflow.concurrency['cancel-in-progress'] === false && job.if.includes("refs/heads/main"), 'Replan shares the protected state writer serialization and admits main only')
check(job.environment === 'delivery-state-recording' && text.includes('STATE_PUSH_TOKEN') && !text.includes('BASELINE_PUSH_TOKEN') && !text.includes('ci-promote.mjs') && !text.includes('verify.mjs'), 'Replan workflow holds state-only capability and does not execute Candidate or promote')
check(text.includes('DSH_STATE_REVISION') && text.includes('EXPECTED_STATE') && text.includes('project/.agent/CONTRACT.yaml') && text.includes('standards/acceptance'), 'CI wrapper pins state and checks approved Contract/config before appending')
const denied = spawnSync(process.execPath, [join(repo, 'ci/tools/ci-replan.mjs')], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } })
check(denied.status === 2 && denied.stderr.includes('trusted main CI environment'), 'local CLI forgery cannot call platform API or write real state')
console.log(`ci-replan.test ok: ${checks} offline fixture checks; no real state or Candidate execution`)
