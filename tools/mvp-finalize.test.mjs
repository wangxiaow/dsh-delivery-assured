#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { decodeEvidence, draftOwnerApproval, parseOwnerComment, confirmOwnerApproval, finalizeMvp } from '../ci/tools/ci-mvp.mjs'
import { sha256 } from '../packages/delivery-assured/scripts/lib/common.mjs'
import { EVIDENCE_GATES } from '../packages/delivery-assured/scripts/lib/evidence.mjs'
import { attemptFromCI, computeConvergence } from '../packages/delivery-assured/scripts/lib/convergence.mjs'

let checks = 0
const check = (value, message) => { assert.ok(value, message); checks++ }
const throws = (fn, pattern) => { assert.throws(fn, pattern); checks++ }
const revision = 'a'.repeat(40), digest = 'b'.repeat(64)
const bindings = { code_revision: revision, contract_revision: revision, contract_digest: digest, acceptance_revision: revision, acceptance_manifest_digest: digest, acceptance_digest: digest, verifier_config_revision: revision, verifier_config_digest: digest, dependency_lock_digest: null, migration_digest: null, spine_manifest_digest: digest, slice_manifest_digest: digest, parent_baseline: null }
const record = {
  evidence_id: 'ci:verify:12-1', issuer: { identity: 'ci:verify' },
  scope: { slice_id: 'S1', obligation_ids: ['C-TEST'], required_case_ids: ['A-TEST'] },
  bindings,
  environment: { kind: 'production_like_ci', image_digest: `sha256:${digest}`, config_fingerprint: digest, fixture_revision: revision, deployment_id: 'artifact-install-12-1', deployed_code_revision: revision, deployed_image_digest: `sha256:${digest}` },
  execution: { ci_run_id: '12-1', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z', result: 'PASS', required_cases: 1, executed_cases: 1, skipped_required_cases: 0, case_results: [{ case_id: 'A-TEST', outcome: 'passed' }], gate_results: EVIDENCE_GATES.map(gate => ({ gate, outcome: 'passed', exit_code: 0 })), artifacts: ['results.json'] },
  structural_notes: [], spine_case_ids: [],
}
const model = {
  cfg: { mvpReadyEnvironment: 'production_like_ci', ci: { trusted_issuer: 'ci:verify' } },
  currentBindings: bindings, spine: { caseIds: ['A-TEST'] }, baselines: [], attempts: [], reviews: [], evidence: [record],
  contract: { journeys: [], business_rules: [], unknowns: [], acceptance: { manual_reviews: [{ id: 'R-TEST', reviewer: 'product_owner', obligation_ids: ['C-TEST'] }] }, deployment: { mvp_ready_environment: 'production_like_ci', release_prerequisites: ['required-verify-check'], operational_acceptance_ids: ['A-TEST'] } },
  obligations: new Map([['C-TEST', { id: 'C-TEST', kind: 'capability', required: true }]]),
  slices: [{ id: 'S1', obligations: ['C-TEST'], acceptance: ['A-TEST'] }],
  acceptance: { cases: [{ id: 'A-TEST', method: 'automated', required: true, obligation_ids: ['C-TEST'] }] },
}
const original = JSON.stringify(record, null, 2) + '\n'
const raw = Buffer.from(original)
check(decodeEvidence(raw).digest === sha256(raw), 'raw evidence digest hashes original bytes including whitespace')
check(decodeEvidence(Buffer.from(JSON.stringify(record))).digest !== decodeEvidence(raw).digest, 'reformatting bytes requires a new owner hash')
const invalidA = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0x80]), Buffer.from('"}')])
const invalidB = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0x81]), Buffer.from('"}')])
check(invalidA.toString('utf8') === invalidB.toString('utf8') && sha256(invalidA) !== sha256(invalidB), 'malformed UTF-8 collision exists only after lossy decoding')
throws(() => decodeEvidence(invalidA), /encoded data|encoding/i)
throws(() => decodeEvidence(invalidB), /encoded data|encoding/i)
const draft = draftOwnerApproval(model, record, raw)
check(draft.result === 'PENDING' && draft.reviews.every(r => r.result === 'PENDING') && draft.release_receipt.prerequisites.every(p => p.result === 'PENDING'), 'draft never grants an owner PASS')
check(draft.evidence_digest === sha256(original) && draft.bindings.deployment_id === record.environment.deployment_id, 'draft binds exact source bytes and actual run deployment')
const approval = structuredClone(draft)
approval.result = 'PASS'
approval.reviews.forEach(r => { r.result = 'PASS' })
approval.release_receipt.result = 'PASS'
approval.release_receipt.prerequisites.forEach(p => { p.result = 'PASS' })
const reference = 'https://github.com/owner/repo/issues/1#issuecomment-42'
const comment = { id: 42, html_url: reference, user: { login: 'owner', type: 'User' }, body: 'Owner confirmation\n```delivery-approval\n' + JSON.stringify(approval, null, 2) + '\n```', created_at: '2026-01-01T00:00:02Z', updated_at: '2026-01-01T00:00:02Z' }
const owner = parseOwnerComment(comment, { repository: 'owner/repo', reference, owner: 'owner' })
const options = { sourceDigest: sha256(original), finalizationRun: '13-1', finalizerRevision: revision, parentBaseline: null }
const final = finalizeMvp(model, record, owner, options)
check(final.ready && final.blocking.length === 0, 'later authenticated receipts can finalize original successful verification')
check(!Object.hasOwn(record.execution, 'mvp_ready') && JSON.stringify(record, null, 2) + '\n' === original, 'finalization leaves original evidence bytes and marker untouched')
check(model.reviews.length === 0 && model.attempts.length === 0, 'pure finalization mutates neither model, ledger nor budget')
check(final.source_run === '12-1' && final.finalization_run === '13-1' && final.evidence_digest === sha256(original), 'readiness has separate attributable CI identity and original hash')
check(final.reviews[0].confirmation_ref === reference && final.reviews[0].reviewer === 'owner' && final.reviews[0].reviewer_role === 'product_owner', 'review authentication is from platform comment, not a caller issuer label')
check(final.release_receipt.confirmation_ref === reference, 'release receipt links the same real owner comment')
for (const changed of [
  { user: { login: 'attacker', type: 'User' } },
  { user: { login: 'owner', type: 'Bot' } },
  { html_url: 'https://github.com/other/repo/issues/1#issuecomment-42' },
  { id: 43 },
  { performed_via_github_app: { id: 123 } },
  { body: 'No structured approval' },
  { body: comment.body + '\n```delivery-approval\n{}\n```' },
]) throws(() => parseOwnerComment({ ...comment, ...changed }, { repository: 'owner/repo', reference, owner: 'owner' }))
const envelope = a => ({ ...owner, approval: a })
const blocked = (mutate, message) => { const a = structuredClone(approval); mutate(a); check(!finalizeMvp(model, record, envelope(a), options).ready, message) }
blocked(a => { a.result = 'PENDING' }, 'pending owner review blocks')
blocked(a => { a.evidence_digest = 'c'.repeat(64) }, 'changed original evidence bytes block')
blocked(a => { a.evidence_id = 'ci:verify:other' }, 'cross-evidence approval blocks')
blocked(a => { a.source_run = '99-1' }, 'cross-run approval blocks')
blocked(a => { a.bindings.deployment_id = 'artifact-install-99-1' }, 'cross-deployment approval blocks')
blocked(a => { a.reviews[0].bindings.code_revision = 'c'.repeat(40) }, 'cross-candidate review blocks')
blocked(a => { a.reviews[0].bindings.acceptance_digest = 'c'.repeat(64) }, 'changed standard review blocks')
blocked(a => { a.reviews[0].reviewer_role = 'agent' }, 'wrong review role blocks')
blocked(a => { a.reviews[0].result = 'FAIL' }, 'failed review blocks')
blocked(a => { a.reviews = [] }, 'missing required review blocks')
blocked(a => { a.reviews.push(a.reviews[0]) }, 'duplicate reviews block')
blocked(a => { a.release_receipt.result = 'PENDING' }, 'unsigned release receipt blocks')
blocked(a => { a.release_receipt.prerequisites[0].result = 'PENDING' }, 'unconfirmed prerequisite blocks')
blocked(a => { a.release_receipt.bindings.image_digest = `sha256:${'c'.repeat(64)}` }, 'cross-image release receipt blocks')
const nextRun = structuredClone(record)
nextRun.environment.deployment_id = 'artifact-install-14-1'
nextRun.execution.ci_run_id = '14-1'
nextRun.evidence_id = 'ci:verify:14-1'
check(!finalizeMvp({ ...model, evidence: [record, nextRun] }, nextRun, owner, options).ready, 'a new deployment cannot borrow old owner receipts')
const unresolved = { ...model, contract: { ...model.contract, unknowns: [{ id: 'U-LATER', status: 'deferred_with_approval' }] } }
check(!finalizeMvp(unresolved, record, owner, options).ready, 'unresolved unknowns remain blocking')
let fetched = 0
const mockFetch = async (url, init) => { fetched++; check(url === 'https://api.github.com/repos/owner/repo/issues/comments/42', 'fetch exact same-repository owner comment'); check(init.redirect === 'error', 'never forward read token on redirects'); return { ok: true, json: async () => comment } }
check((await confirmOwnerApproval(reference, 'owner/repo', 'read-token', 'owner', mockFetch)).owner === 'owner', 'owner approval confirmed independently via API')
for (const ref of ['https://evil.invalid/owner/repo/issues/1#issuecomment-42', 'https://github.com/other/repo/issues/1#issuecomment-42', 'file:///approval.json', 'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/issues/1/../issues/1#issuecomment-42']) {
  await assert.rejects(() => confirmOwnerApproval(ref, 'owner/repo', 'read-token', 'owner', mockFetch)); checks++
}
check(fetched === 1, 'reject wrong URLs before any authenticated network request')
const replayModel = structuredClone(model)
replayModel.contract.acceptance.manual_reviews[0].target_method = 'retained_artifact_replay_with_ci_observation'
check(!finalizeMvp(replayModel, record, owner, options).ready, 'approved replay policy requires an explicit honest human execution context, not a legacy live-deployment claim')
const replayDraft = draftOwnerApproval(replayModel, record, raw)
replayDraft.result = 'PASS'; replayDraft.reviews.forEach(r => { r.result = 'PASS' })
replayDraft.release_receipt = structuredClone(approval.release_receipt)
check(!finalizeMvp(replayModel, record, envelope(replayDraft), options).ready, 'PENDING replay installation/location cannot be promoted even with owner PASS')
const replayCtx = replayDraft.reviews[0].review_context
Object.assign(replayCtx, { replay_deployment_id: 'fixture-owner-replay-1', review_target: 'C:/explicit-fixture-review', identity_context: 'owner using a fresh local workspace; read-only CLI has no application login' })
check(finalizeMvp(replayModel, record, envelope(replayDraft), options).ready, 'explicitly approved identical artifact replay records distinct actual and historical installation identities')
check(!finalizeMvp(model, record, envelope(replayDraft), options).ready, 'other projects cannot adopt replay without explicit frozen Contract approval')
for (const patch of [{ replay_deployment_id: record.environment.deployment_id }, { artifact_digest: 'sha256:' + 'f'.repeat(64) }, { source_deployment_id: 'other-ci-install' }, { review_target: 'PENDING' }]) {
  const bad = structuredClone(replayDraft); Object.assign(bad.reviews[0].review_context, patch)
  check(!finalizeMvp(replayModel, record, envelope(bad), options).ready, 'replay refuses placeholder, false live identity or differing original artifact/installation')
}
const laterFailure = structuredClone(record)
laterFailure.evidence_id = 'ci:verify:99-1'
laterFailure.execution.ci_run_id = '99-1'
laterFailure.execution.finished_at = '2026-01-01T00:00:05Z'
laterFailure.execution.result = 'FAIL'
laterFailure.execution.case_results[0].outcome = 'failed'
check(!finalizeMvp({ ...model, evidence: [record, laterFailure] }, record, owner, options).ready, 'finalization retains later applicable failures instead of erasing history')
const rebaseRecord = { ...structuredClone(record), convergence: { slice_key: 'S1', root_cause_key: 'fixed-candidate-verification', hypothesis: 'owner-approved environment change', comparison_approval_ref: 'DEC-8-ENVIRONMENT' } }
const oldRecord = structuredClone(rebaseRecord)
oldRecord.evidence_id = 'ci:verify:11-1'
oldRecord.execution.ci_run_id = '11-1'
oldRecord.execution.finished_at = '2025-12-31T23:59:59Z'
oldRecord.execution.started_at = '2025-12-31T23:59:58Z'
oldRecord.bindings.contract_digest = 'c'.repeat(64)
delete oldRecord.convergence.comparison_approval_ref
const rebaseModel = { ...model, cfg: { ...model.cfg, budget: { total_attempt_limit: 8, same_root_cause_limit: 3, no_progress_window: 3, replan_limit: 2 } }, evidence: [oldRecord], attempts: [] }
rebaseModel.attempts = [attemptFromCI(oldRecord, rebaseModel)]
const rebaseText = JSON.stringify(rebaseRecord)
const rebaseDraft = draftOwnerApproval(rebaseModel, rebaseRecord, rebaseText)
check(rebaseDraft.comparison_rebase.status === 'PENDING', 'changed comparison is explicitly pending, never implicitly approved')
rebaseDraft.result = 'PASS'; rebaseDraft.reviews.forEach(r => { r.result = 'PASS' })
rebaseDraft.release_receipt.result = 'PASS'; rebaseDraft.release_receipt.prerequisites.forEach(p => { p.result = 'PASS' })
check(!finalizeMvp(rebaseModel, rebaseRecord, envelope(rebaseDraft), { ...options, sourceDigest: sha256(rebaseText) }).ready, 'unapproved standard comparison transition blocks finalization')
rebaseDraft.comparison_rebase.status = 'approved'
const rebased = finalizeMvp(rebaseModel, rebaseRecord, envelope(rebaseDraft), { ...options, sourceDigest: sha256(rebaseText) })
check(rebased.ready && rebased.standard_change.confirmation_ref === reference, 'exact comparison target can be approved in the same authenticated owner receipt')
const rebasedBudget = computeConvergence({ ...rebaseModel, standardChanges: [rebased.standard_change], evidence: [oldRecord, rebaseRecord], attempts: [...rebaseModel.attempts, attemptFromCI(rebaseRecord, rebaseModel)] }, { logExists: true, candidate: revision, parentBaseline: null })
check(rebasedBudget.counted === 2 && rebasedBudget.terminal_passed && !rebasedBudget.blocked, 'comparison rebase preserves every old attempt and budget while admitting the new genuine PASS')
const localFile = spawnSync(process.execPath, ['ci/tools/ci-promote.mjs', '--owner-approval', 'caller-approval.json', '--mode', 'MVP_READY'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } })
check(localFile.status === 1 && localFile.stderr.includes('fixture-only'), 'real finalization rejects local caller-authored owner files before reading them')
console.log(`mvp-finalize.test ok: ${checks} checks passed`)
