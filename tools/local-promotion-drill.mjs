#!/usr/bin/env node
// Pure fixture exercise. No GitHub, network, real refs, or real evidence issuance.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { loadModel, classifyEvidence } from '../packages/delivery-assured/scripts/lib/model.mjs'
import { draftOwnerApproval } from '../ci/tools/ci-mvp.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'promotion-fixture-'))
const clone = join(work, 'repo')
const bare = join(work, 'remote.git')
const project = join(clone, 'project')
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function run(tool, args, env = {}) {
  const result = spawnSync(process.execPath, [join(repo, 'ci', 'tools', tool), ...args], { cwd: clone, encoding: 'utf8', env: { ...process.env, DSH_VERIFY_RUN_ID: '', DSH_VERIFIER_REVISION: '', DSH_STANDARD_REVISION: '', ...env } })
  return { code: result.status, text: `${result.stdout || ''}${result.stderr || ''}` }
}
let checks = 0
function check(value, message) { assert.ok(value, message); checks += 1 }
try {
  mkdirSync(clone)
  cpSync(join(repo, 'project'), project, { recursive: true })
  cpSync(join(repo, 'packages'), join(clone, 'packages'), { recursive: true })
  rmSync(join(project, '.agent', 'evidence'), { force: true, recursive: true })
  rmSync(join(project, '.agent', 'artifact'), { force: true, recursive: true })
  rmSync(join(project, 'ci', 'baseline'), { force: true, recursive: true })
  rmSync(join(project, 'ci', 'evidence'), { force: true, recursive: true })
  writeFileSync(join(project, '.agent', 'attempts.jsonl'), '')
  mkdirSync(bare)
  git(bare, ['init', '--bare', '--quiet'])
  git(clone, ['init', '--quiet'])
  git(clone, ['config', 'user.name', 'Fixture'])
  git(clone, ['config', 'user.email', 'fixture@example.invalid'])
  git(clone, ['remote', 'add', 'origin', bare])
  git(clone, ['add', '.'])
  git(clone, ['commit', '--quiet', '-m', 'fixture'])
  const candidate = git(clone, ['rev-parse', 'HEAD'])
  git(clone, ['push', '--quiet', 'origin', `${candidate}:refs/heads/main`])
  check(run('ci-spec-diff.mjs', ['--repo', clone, '--candidate-ref', candidate]).code === 1, 'missing protected standard fails closed')
  git(clone, ['update-ref', 'refs/heads/standards/acceptance', candidate])
  check(run('ci-spec-diff.mjs', ['--repo', clone, '--candidate-ref', candidate]).code === 0, 'real project layout matches')
  const artifact = run('verify-artifact.mjs', ['--project', project])
  check(artifact.code === 0, artifact.text)
  check(run('verify-artifact.mjs', ['--project', project, '--check']).code === 0, 'artifact read-only check')
  check(run('verify-artifact.mjs', ['--project', project]).code !== 0, 'rebuilding a retained artifact fails')
  const artifactDir = join(project, '.agent', 'artifact', 'delivery-assured')
  const artifactManifest = JSON.parse(readFileSync(join(artifactDir, 'ARTIFACT.json'), 'utf8'))
  const packagedCli = join(artifactDir, 'project', 'src', 'cli.mjs')
  const startup = spawnSync(process.execPath, [packagedCli, '--help'], { cwd: artifactDir, encoding: 'utf8' })
  check(startup.status === 0 && /Usage/.test(startup.stdout), 'packaged CLI starts with preserved relative imports')
  const observed = spawnSync(process.execPath, [packagedCli, 'status', '--project', project, '--json'], { cwd: artifactDir, encoding: 'utf8' })
  check(observed.status === 1 && JSON.parse(observed.stdout).report_kind === 'local_diagnostic', 'packaged CLI performs a real diagnostic, not just a help stub')
  check(!/DSH_DEPLOYED_CODE_REVISION=|DSH_DEPLOYMENT_ID=/.test(artifact.text), 'packaging does not invent deployment observations')
  const model = loadModel(project)
  // The fixture finalization covers the WHOLE Contract the way the real MVP flow
  // does: "MVP" scope means the frozen set required by the Contract plus the Spine
  // (never a partial Sub-selection), and the obligation surface is every declared
  // obligation. Partial Slice scopes are promoted through promote-baseline with
  // their own Slice id; this drill's single promotion is the finalization.
  const cases = [...new Set([
    ...model.acceptance.cases.filter(c => c.required && c.method === 'automated').map(c => c.id),
    ...model.spine.caseIds,
  ])].sort()
  const evidence = {
    evidence_id: 'ci:verify:fixture-1', issuer: { identity: 'ci:verify' },
    trust: { transport_verified: true, runtime_isolation_verified: true },
    convergence: { slice_key: 'MVP', root_cause_key: 'fixture-fixed-candidate', hypothesis: 'Fixture candidate satisfies the frozen Required set' },
    scope: { slice_id: 'MVP', obligation_ids: [...model.obligations.keys()], required_case_ids: cases },
    bindings: { ...model.currentBindings, code_revision: candidate, contract_revision: candidate, acceptance_revision: candidate, verifier_config_revision: candidate, parent_baseline: null },
    environment: { kind: 'production_like_ci', image_digest: `sha256:${artifactManifest.digest}`, deployed_image_digest: `sha256:${artifactManifest.digest}`, config_fingerprint: model.currentBindings.verifier_config_digest, fixture_revision: candidate, deployment_id: 'fixture-deployment', deployed_code_revision: candidate },
    execution: { ci_run_id: 'fixture-1', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z', result: 'PASS', required_cases: cases.length, executed_cases: cases.length, skipped_required_cases: 0, case_results: cases.map(case_id => ({ case_id, outcome: 'passed' })), gate_results: ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment'].map(gate => ({ gate, outcome: 'passed', exit_code: 0 })), artifacts: ['acceptance-results.json'] },
    structural_notes: [], spine_case_ids: [],
  }
  const download = join(work, 'download')
  mkdirSync(download)
  cpSync(artifactDir, join(download, 'artifact'), { recursive: true })
  const evidenceFile = join(download, 'evidence.json')
  writeFileSync(evidenceFile, JSON.stringify(evidence))
  const args = ['--fixture', '--project', project, '--evidence-dir', download, '--expected-parent', 'none', '--json']
  const ready = run('ci-promote.mjs', [...args, '--dry-run'])
  check(ready.code === 0, ready.text)
  const planned = JSON.parse(ready.text.slice(ready.text.indexOf('{'))).metadata
  check(planned.environment.deployment_id === evidence.environment.deployment_id, 'baseline records the observed deployment without calling it staging')
  check(planned.environment.staging_deployment_id === null, 'production-like CI never populates a staging deployment field')
  check(planned.environment.mvp_ready_environment === model.cfg.mvpReadyEnvironment, 'baseline records the explicitly configured MVP_READY environment')
  check(JSON.stringify(planned.environment.limitations) === JSON.stringify(model.contract.deployment.environment_limitations), 'baseline preserves the owner-approved environment limitations')
  check(!existsSync(join(project, 'ci', 'baseline')), 'dry-run does not write metadata')
  check(run('ci-promote.mjs', [...args, '--dry-run', '--mode', 'MVP_READY']).code === 1, 'MVP readiness fails closed without full proof')
  const labelOnly = structuredClone(evidence)
  labelOnly.execution.mvp_ready = true
  writeFileSync(evidenceFile, JSON.stringify(labelOnly))
  check(run('ci-promote.mjs', [...args, '--dry-run', '--mode', 'MVP_READY']).code === 1, 'a self-declared readiness marker cannot replace authenticated owner receipts')
  writeFileSync(evidenceFile, JSON.stringify(evidence))
  for (const mutate of [r => delete r.bindings.spine_manifest_digest, r => r.execution.gate_results.pop(), r => { r.execution.case_results[0].outcome = 'failed' }, r => { r.bindings.parent_baseline = 'BL-999' }]) {
    const changed = structuredClone(evidence)
    mutate(changed)
    writeFileSync(evidenceFile, JSON.stringify(changed))
    check(run('ci-promote.mjs', [...args, '--dry-run']).code === 1, 'incomplete fixture evidence blocks')
  }
  writeFileSync(evidenceFile, JSON.stringify(evidence))
  check(run('ci-promote.mjs', [...args, '--dry-run'], { DSH_VERIFY_RUN_ID: 'different-run' }).code === 1, 'cross-run identity mismatch blocks')
  // Explicit synthetic owner approval exists only inside this disposable fixture.
  // Original successful Evidence has no execution.mvp_ready marker and is untouched.
  const originalText = readFileSync(evidenceFile, 'utf8')
  const ownerDraftPath = join(work, 'review-draft.md')
  const prepared = spawnSync(process.execPath, [join(repo, 'tools', 'prepare-owner-review.mjs'), '--project', project, '--evidence', evidenceFile, '--out', ownerDraftPath], { encoding: 'utf8' })
  check(prepared.status === 0, prepared.stderr)
  check(readFileSync(ownerDraftPath, 'utf8').includes('"result": "PENDING"') && !readFileSync(ownerDraftPath, 'utf8').includes('"result": "PASS"'), 'CLI review preparation cannot manufacture an owner PASS')
  const duplicateDraft = spawnSync(process.execPath, [join(repo, 'tools', 'prepare-owner-review.mjs'), '--project', project, '--evidence', evidenceFile, '--out', ownerDraftPath], { encoding: 'utf8' })
  check(duplicateDraft.status === 2, 'preparation refuses to overwrite an existing owner document')
  const ownerApproval = draftOwnerApproval(model, evidence, originalText)
  ownerApproval.result = 'PASS'
  ownerApproval.reviews.forEach(review => {
    review.result = 'PASS'
    if (review.review_context) Object.assign(review.review_context, { replay_deployment_id: 'fixture-owner-replay-1', review_target: 'C:/explicit-fixture-owner-review', identity_context: 'synthetic fresh owner workspace; this test is not a real owner review' })
  })
  ownerApproval.release_receipt.result = 'PASS'
  ownerApproval.release_receipt.prerequisites.forEach(p => { p.result = 'PASS' })
  const approvalPath = join(work, 'owner-approval.json')
  writeFileSync(approvalPath, JSON.stringify(ownerApproval))
  const mvpArgs = [...args, '--mode', 'MVP_READY', '--owner-approval', approvalPath]
  const finalReady = run('ci-promote.mjs', [...mvpArgs, '--dry-run'])
  check(finalReady.code === 0, finalReady.text)
  check(readFileSync(evidenceFile, 'utf8') === originalText, 'finalization never rewrites the original Evidence or adds a marker')
  check(!existsSync(join(project, 'ci', 'mvp-ready.json')), 'finalization dry-run has no state side effects')
  const applied = run('ci-promote.mjs', [...mvpArgs, '--apply'])
  check(applied.code === 0, applied.text)
  check(git(bare, ['rev-parse', 'refs/heads/baseline/main']) === candidate, 'baseline points at fixture candidate')
  const state = git(bare, ['rev-parse', 'refs/heads/delivery-state/main'])
  check(Boolean(state), 'durable state ref exists')
  const files = git(bare, ['ls-tree', '-r', '--name-only', state])
  for (const name of ['project/ci/baseline/BL-000.json', 'project/ci/evidence/', 'project/tests/spine/manifest.yaml', 'project/.agent/attempts.jsonl', 'project/.agent/reviews.yaml', 'project/ci/mvp-ready.json', 'project/ci/recording/mvp-finalizations/fixture-finalization-1.json']) check(files.includes(name), `durable ${name}`)
  const retainedEvidencePath = `project/ci/evidence/${evidence.evidence_id.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`
  check(git(bare, ['show', `${state}:${retainedEvidencePath}`]) === originalText.trim(), 'durable Evidence retains exact original bytes except displayed trim')
  const durableReady = JSON.parse(git(bare, ['show', `${state}:project/ci/recording/mvp-finalizations/fixture-finalization-1.json`]))
  check(durableReady.ready && durableReady.source_run === 'fixture-1', 'restoration retains separate full-contract readiness and exact original run')
  check(loadModel(project).reviews.length === model.contract.acceptance.manual_reviews.length, 'derived owner Review projection is loadable after restoration')
  check(loadModel(project).attempts.length === 1, 'owner finalization counts no additional Candidate attempt')
  const spine = git(bare, ['show', `${state}:project/tests/spine/manifest.yaml`])
  check(cases.every(id => spine.includes(id)), 'Spine automatically accumulates required cases')
  const restoredModel = loadModel(project)
  check(classifyEvidence(evidence, { model: restoredModel, codeRevision: candidate, parentBaseline: 'BL-000', trustedIssuer: 'ci:verify' }).fresh, 'fresh session retains proof after CI accumulates the Spine')
  check(run('ci-promote.mjs', [...args, '--dry-run']).code === 1, 'creation lease fails when baseline already exists')
  const parentProof = structuredClone(evidence)
  parentProof.bindings.parent_baseline = 'BL-000'
  parentProof.bindings.spine_manifest_digest = loadModel(project).currentBindings.spine_manifest_digest
  parentProof.evidence_id = 'ci:verify:fixture-2'
  parentProof.execution.ci_run_id = 'fixture-2'
  parentProof.execution.finished_at = '2026-01-01T00:00:02Z'
  writeFileSync(evidenceFile, JSON.stringify(parentProof))
  const parentArgs = ['--fixture', '--project', project, '--evidence-dir', download, '--expected-parent', 'BL-000', '--json', '--dry-run']
  const mappedParent = run('ci-promote.mjs', parentArgs)
  check(mappedParent.code === 0, mappedParent.text)
  const metadata = JSON.parse(readFileSync(join(project, 'ci', 'baseline', 'BL-000.json'), 'utf8'))
  check(metadata.code_revision === candidate, 'parent ID maps to persisted candidate SHA')
  writeFileSync(join(clone, 'race-marker.txt'), 'race fixture\n')
  git(clone, ['add', 'race-marker.txt'])
  git(clone, ['commit', '--quiet', '-m', 'concurrent candidate fixture'])
  const racedSha = git(clone, ['rev-parse', 'HEAD'])
  git(clone, ['push', '--quiet', 'origin', `${racedSha}:refs/heads/baseline/main`])
  check(run('ci-promote.mjs', parentArgs).code === 1, 'persisted parent SHA detects concurrent baseline advance')
  const staleLease = spawnSync('git', ['push', `--force-with-lease=refs/heads/baseline/main:${candidate}`, 'origin', `${candidate}:refs/heads/baseline/main`], { cwd: clone, encoding: 'utf8' })
  check(staleLease.status !== 0 && git(bare, ['rev-parse', 'refs/heads/baseline/main']) === racedSha, 'explicit lease rejects a race without moving the ref')
  const artifactEntry = artifactManifest.entries[0].path
  writeFileSync(join(download, 'artifact', artifactEntry), 'tampered')
  check(run('ci-promote.mjs', [...args, '--dry-run']).code === 1, 'retained artifact mutation blocks')
  check(readdirSync(join(project, 'ci', 'baseline')).length === 1, 'blocked dry-run writes nothing')
} finally { rmSync(work, { recursive: true, force: true }) }
console.log(`local-promotion-drill ok: ${checks} pure fixture checks; no real CI or promotion asserted`)
