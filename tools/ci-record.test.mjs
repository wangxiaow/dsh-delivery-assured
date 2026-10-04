#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateProvenance, validateRecord, budgetPrecheck, recordAttempt, persistState, stateParent, restoreTrustedProject, STATE_REF } from '../ci/tools/ci-record.mjs'
import { loadModel } from '../packages/delivery-assured/scripts/lib/model.mjs'
import { sha256, standardBindings } from '../packages/delivery-assured/scripts/lib/common.mjs'
import { requiredCaseIds } from '../packages/delivery-assured/scripts/lib/selection.mjs'
import { parseYaml } from '../packages/delivery-assured/scripts/lib/yaml.mjs'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
function check(condition, message) { assert.ok(condition, message); checks += 1 }
function throws(fn, pattern) { assert.throws(fn, pattern); checks += 1 }
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
const verify = parseYaml(readFileSync(join(repo, '.github/workflows/verify.yml'), 'utf8'))
const promote = parseYaml(readFileSync(join(repo, '.github/workflows/promote.yml'), 'utf8'))
const collector = promote.jobs['record-attempt']
check(promote.on.workflow_run.workflows.includes('verify') && promote.on.workflow_run.types.includes('completed'), 'completed successes and failures trigger collector')
check(!collector.if.includes('success') && collector.if.includes('workflow_dispatch') && collector.if.includes("'main'"), 'collector admits failures but excludes PR and non-main dispatch')
check(collector.environment === 'delivery-state-recording' && collector.environment !== verify.jobs.verify.environment, 'independent protected state environment')
const collectorText = JSON.stringify(collector)
check(collectorText.includes('STATE_PUSH_TOKEN') && !collectorText.includes('BASELINE_PUSH_TOKEN') && !collectorText.includes('ci-promote.mjs') && !collectorText.includes('candidate/'), 'collector has state-only capability and never executes Candidate')
const sourceStep = collector.steps.find(s => s.id === 'source')
const download = collector.steps.find(s => s.uses?.startsWith('actions/download-artifact')).with
check(download.name === 'verify-report-${{ steps.source.outputs.run_id }}-${{ steps.source.outputs.run_attempt }}' && download['run-id'] === '${{ steps.source.outputs.run_id }}', 'artifact name binds exact authenticated attempt')
check(sourceStep.with.script.includes('run.run_attempt !== attempt_number') && sourceStep.with.script.includes("core.setOutput('run_attempt', String(attempt_number))") && sourceStep.with.script.includes('Number.isSafeInteger'), 'only authenticated positive exact attempt reaches artifact selector')
check(collector.if.includes("inputs.mode == 'record-attempt'") && collector.if.includes("github.ref == 'refs/heads/main'"), 'manual collector retry is restricted to main')
check(promote.on.workflow_dispatch.inputs.mode.options.includes('record-attempt') && promote.jobs['promote-baseline'].if.includes("inputs.mode == 'promote-baseline' || inputs.mode == 'MVP_READY'"), 'record-only dispatch does not grant promotion capability')
check(collector.steps.find(s => s.uses?.startsWith('actions/download-artifact'))['continue-on-error'] === true, 'missing artifact still reaches diagnostic persistence')
check(promote.concurrency.group === 'delivery-state-main' && promote.concurrency['cancel-in-progress'] === false, 'all state writers and promotion serialize')
check(promote.jobs['bootstrap-state'].environment === 'delivery-state-bootstrap', 'bootstrap requires separate approval environment')
check(promote.jobs['bootstrap-state'].permissions.actions === 'read' && promote.jobs['bootstrap-state'].permissions.contents === 'read', 'bootstrap seed confirmation has actions read, not workflow dispatch authority')
check(JSON.stringify(promote.jobs['bootstrap-state']).includes('DSH_GITHUB_READ_TOKEN') && !JSON.stringify(promote.jobs['bootstrap-state']).includes('BASELINE_PUSH_TOKEN'), 'bootstrap independently reads exact source without Baseline credentials')
const resolutionJob = promote.jobs['resolve-diagnostic']
check(resolutionJob.environment === 'delivery-state-resolution' && resolutionJob.if.includes("github.ref == 'refs/heads/main'"), 'resolution needs its own approved main environment')
const resolutionText = JSON.stringify(resolutionJob)
check(resolutionText.includes('STATE_PUSH_TOKEN') && !resolutionText.includes('BASELINE_PUSH_TOKEN') && !resolutionText.includes('ci-promote.mjs'), 'resolution is state-only, never promotion')
check(resolutionText.includes('--expected-state') && resolutionText.includes('git rev-parse FETCH_HEAD') && resolutionText.includes('--confirmation-ref'), 'resolution pins explicit reviewed state and owner confirmation')
const deniedResolution = spawnSync(process.execPath, [join(repo, 'ci/tools/ci-record.mjs'), '--mode', 'resolve-diagnostic', '--repo', repo, '--project', join(repo, 'project')], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } })
check(deniedResolution.status === 2 && deniedResolution.stderr.includes('approved state-resolution environment'), 'local forged resolution cannot run source API or persist state')
const steps = verify.jobs.verify.steps
check(steps.findIndex(s => s.name?.startsWith('Check budget')) < steps.findIndex(s => s.name?.startsWith('Produce artifact')), 'budget precheck precedes Candidate build/artifact execution')
check(verify.jobs.verify.env.DSH_SLICE_ID.includes("'S1'") && !JSON.stringify(verify).includes("'auto'"), 'PR uses frozen S1, not unknown auto')
check(verify.on.workflow_dispatch.inputs.hypothesis.required && verify.on.workflow_dispatch.inputs.sliceKey.required && verify.jobs.verify.env.DSH_HYPOTHESIS.includes('inputs.hypothesis') && verify.jobs.verify.env.DSH_SLICE_KEY.includes('inputs.sliceKey'), 'dispatch convergence metadata is wired')
check(JSON.stringify(verify).includes('canonical/project/ci/verifier.yaml') && JSON.stringify(verify).includes('DSH_FIXTURE_REVISION=$env:DSH_STANDARD_REVISION'), 'protected environment digest and frozen STD fixture revision')
const promotionSteps = promote.jobs['promote-baseline'].steps
check(promotionSteps.findIndex(s => s.name?.startsWith('Report runtime isolation')) < promotionSteps.findIndex(s => s.env?.GH_TOKEN?.includes('BASELINE_PUSH_TOKEN')), 'isolation is reported before any baseline credential is used')
check(!promotionSteps.some(s => s.run?.includes('PROMOTION BLOCKED')), 'unimplemented runtime isolation no longer blocks promotion (owner decision: warning plus metadata)')
check(promotionSteps.find(s => s.name?.startsWith('Report runtime isolation')).run.includes('does not block this promotion'), 'isolation warning states the recorded, non-blocking policy')
// The durable Baseline metadata and the spine manifest name the run that wrote them.
// Without DSH_CI_RUN_ID the first real promotion recorded "local-dry-run" and the
// promoting run became unattributable — a gap only visible by reading the state ref.
const promoteStep = promotionSteps.find(s => s.env?.GH_TOKEN?.includes('BASELINE_PUSH_TOKEN'))
check(promoteStep?.env?.DSH_CI_RUN_ID?.includes('github.run_id'), 'the promotion records the exact CI run that performed it')
check(promote.on.workflow_dispatch.inputs.owner_approval_ref && promoteStep.env.DSH_OWNER_APPROVAL_REF === '${{ inputs.owner_approval_ref }}', 'MVP_READY consumes a typed exact owner confirmation pointer')
check(promote.jobs['promote-baseline'].permissions.issues === 'read', 'finalization independently reads the platform owner comment')
check(promotionSteps.some(s => s.run?.includes('DSH_STATE_REVISION=$STATE_SHA')), 'promotion pins the restored state before reassessing and CAS')
const promotionRetention = promotionSteps.find(s => s.uses?.startsWith('actions/upload-artifact')).with.path
check(promotionRetention.includes('mvp-finalizations') && promotionRetention.includes('reviews.yaml') && promotionRetention.includes('mvp-ready.json'), 'derived readiness and owner review are retained with promotion state')
const promoteSource = readFileSync(join(repo, 'ci/tools/ci-promote.mjs'), 'utf8')
check(promoteSource.includes('await historyBlockers(root)') && promoteSource.includes('auditCompletedHistory') && promoteSource.includes('audit.examined !== audit.completed'), 'promotion blocks uncollected completed and in-flight verification history')
check(promoteSource.includes('unresolvedDiagnostics(diagnostics.wrappers, diagnostics.resolutions)') && !JSON.stringify(promotionSteps).includes('test ! -d project/ci/recording/diagnostics'), 'promotion respects immutable resolved diagnostics instead of demanding history deletion')
const source = readFileSync(join(repo, 'ci/tools/ci-record.mjs'), 'utf8')
check(source.includes('https://api.github.com/repos/') && source.includes('/attempts/${receipt.run_attempt}') && source.includes('await confirmReceipt'), 'consumer confirms receipt externally rather than trusting issuer')
const receipt = { repository: 'fixture/repo', run_id: 12, run_attempt: 2 }
const baseRun = { id: 12, run_attempt: 2, repository: { full_name: 'fixture/repo' }, path: '.github/workflows/verify.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure' }
check(validateProvenance(receipt, baseRun, 'fixture/repo').run_key === '12-2', 'failed exact attempt is attributable')
for (const mutation of [{ run_attempt: 1 }, { id: 13 }, { repository: { full_name: 'other/repo' } }, { path: 'other.yml' }, { event: 'pull_request' }, { head_branch: 'feature' }, { status: 'in_progress' }, { head_sha: 'unknown' }]) throws(() => validateProvenance(receipt, { ...baseRun, ...mutation }, 'fixture/repo'))
const work = mkdtempSync(join(tmpdir(), 'ci-record-fixture-'))
try {
  const canonical = join(work, 'canonical')
  const remote = join(work, 'state.git')
  mkdirSync(canonical)
  for (const name of ['project', 'packages', '.gitattributes']) cpSync(join(repo, name), join(canonical, name), { recursive: true })
  git(canonical, ['init', '--quiet'])
  git(canonical, ['config', 'user.name', 'Fixture'])
  git(canonical, ['config', 'user.email', 'fixture@example.invalid'])
  git(canonical, ['add', '.'])
  git(canonical, ['commit', '--quiet', '-m', 'protected fixture'])
  const revision = git(canonical, ['rev-parse', 'HEAD'])
  git(work, ['init', '--bare', '--quiet', remote])
  git(canonical, ['remote', 'add', 'origin', remote])
  git(canonical, ['push', '--quiet', 'origin', `${revision}:refs/heads/standards/acceptance`])
  throws(() => stateParent(canonical), /bootstrap required/)
  const project = join(canonical, 'project')
  const seedLedger = join(project, '.agent/attempts.jsonl')
  writeFileSync(seedLedger, '')
  const initialModel = loadModel(project)
  const missingPass = budgetPrecheck(initialModel, 'S1', 'S1')
  check(missingPass.budget.critical_open.length > 0 && missingPass.blockers.length === 0, 'missing current Critical PASS does not stop a repair Candidate')
  check(budgetPrecheck(initialModel, 'S1', 'S1', false).blockers.length > 0, 'missing ledger is not an empty budget')
  throws(() => budgetPrecheck(initialModel, 'unapproved'), /unknown/)
  throws(() => budgetPrecheck(initialModel, 'S1', 'renamed'), /inconsistent/)
  const seed = new Map([['project/.agent/attempts.jsonl', ''], ['project/tests/spine/manifest.yaml', readFileSync(join(project, 'tests/spine/manifest.yaml'))], ['project/ci/recording/bootstrap.json', '{"owner":"fixture"}\n'], ['untouched/history.txt', 'keep forever\n']])
  const initialState = persistState(canonical, null, seed)
  const baselineBefore = git(canonical, ['ls-remote', 'origin', 'refs/heads/baseline/main'])
  const run = { ...baseRun, head_sha: revision }
  const provenance = validateProvenance(receipt, run, 'fixture/repo')
  const downloaded = join(work, 'downloaded')
  mkdirSync(join(downloaded, 'artifact'), { recursive: true })
  const bytes = Buffer.from('export const fixture = true\n')
  const entry = { path: 'src/fixture.mjs', bytes: bytes.length, sha256: sha256(bytes) }
  const manifestText = `${entry.path}\t${entry.bytes}\t${entry.sha256}\n`
  const digest = sha256(manifestText)
  mkdirSync(join(downloaded, 'artifact/src'))
  writeFileSync(join(downloaded, 'artifact/src/fixture.mjs'), bytes)
  writeFileSync(join(downloaded, 'artifact/MANIFEST.tsv'), manifestText)
  writeFileSync(join(downloaded, 'artifact/ARTIFACT.json'), JSON.stringify({ code_revision: revision, entries: [entry], digest }))
  const ids = requiredCaseIds(initialModel, 'S1')
  function evidence(runKey, outcome = 'FAIL') {
    const current = standardBindings(project, initialModel.cfg)
    return {
      evidence_id: `ci:verify:${runKey}`, issuer: { identity: 'ci:verify' },
      convergence: { hypothesis: 'Fixture reproduces failed required cases', root_cause_key: 'fixture-failure', slice_key: 'S1' },
      bindings: { ...current, code_revision: revision, contract_revision: revision, acceptance_revision: revision, verifier_config_revision: revision, parent_baseline: null },
      scope: { slice_id: 'S1', slice_key: 'S1', required_case_ids: ids },
      environment: { kind: 'production_like_ci', config_fingerprint: current.verifier_config_digest, fixture_revision: revision, image_digest: `sha256:${digest}`, deployed_image_digest: `sha256:${digest}`, deployed_code_revision: revision, deployment_id: 'fixture-deployment' },
      structural_notes: [],
      execution: { ci_run_id: runKey, result: outcome, started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z', required_cases: ids.length, executed_cases: outcome === 'PASS' ? ids.length : 1, skipped_required_cases: outcome === 'PASS' ? 0 : ids.length - 1, case_results: ids.map((case_id, i) => ({ case_id, outcome: outcome === 'PASS' ? 'passed' : i === 0 ? 'failed' : 'not_run' })), gate_results: ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment'].map(gate => ({ gate, outcome: 'passed', exit_code: 0 })), artifacts: ['acceptance-results.json'] },
    }
  }
  const failed = evidence('12-2')
  writeFileSync(join(downloaded, 'evidence.json'), JSON.stringify(failed))
  check(validateRecord(failed, initialModel, provenance).result === 'failed', 'complete FAIL with not_run derives a counted attempt')
  throws(() => validateRecord(evidence('12-2', 'INFRA_ABORTED'), initialModel, provenance), /independent infrastructure-abort proof/)
  throws(() => validateRecord({ ...failed, execution: { ...failed.execution, executed_cases: ids.length } }, initialModel, provenance), /accounting/)
  throws(() => validateRecord({ ...failed, environment: { ...failed.environment, config_fingerprint: 'wrong' } }, initialModel, provenance), /environment/)
  throws(() => validateRecord({ ...failed, execution: { ...failed.execution, ci_run_id: '12-1' } }, initialModel, provenance), /run binding/)
  const first = recordAttempt({ repo: canonical, project, provenance, evidenceDir: downloaded })
  check(first.status === 'recorded', JSON.stringify(first))
  const ledger1 = git(canonical, ['show', `${first.state_sha}:project/.agent/attempts.jsonl`])
  check(JSON.parse(ledger1).result === 'failed', 'failed run survives on protected state')
  check(git(canonical, ['show', `${first.state_sha}:untouched/history.txt`]) === 'keep forever', 'state writer retains unrelated history')
  check(git(canonical, ['ls-remote', 'origin', 'refs/heads/baseline/main']) === baselineBefore, 'state recording never advances Baseline')
  const repeat = recordAttempt({ repo: canonical, project, provenance, evidenceDir: downloaded })
  check(repeat.status === 'duplicate' && repeat.state_sha === first.state_sha, 'identical exact-attempt repeat is a no-op')
  writeFileSync(join(downloaded, 'evidence.json'), JSON.stringify({ ...failed, convergence: { ...failed.convergence, hypothesis: 'changed bytes' } }))
  throws(() => recordAttempt({ repo: canonical, project, provenance, evidenceDir: downloaded }), /immutable/)
  writeFileSync(join(downloaded, 'evidence.json'), JSON.stringify(failed))
  throws(() => persistState(canonical, initialState, new Map([['project/ci/recording/race.json', '{}']])), /git/)
  check(stateParent(canonical) === first.state_sha, 'stale lease cannot overwrite newer state')
  const restored = restoreTrustedProject(canonical, 'origin', provenance, downloaded)
  check(restored.parent === first.state_sha && restored.standard === revision, 'independent collector restores frozen standard and durable failed history')
  const restoredModel = loadModel(project)
  const recovered = budgetPrecheck(restoredModel, 'S1', 'S1')
  check(recovered.budget.counted === 1 && recovered.budget.remaining === 7, 'failed attempt counts after clean restoration')
  const diagnosticText = JSON.stringify({ run_key: '12-2', status: 'blocked', errors: ['synthetic retained counted failure note'], receipt: JSON.parse(git(canonical, ['show', `${first.state_sha}:project/ci/recording/receipts/12-2.json`])), derived_attempt: true }) + '\n'
  const resolutionBase = persistState(canonical, first.state_sha, new Map([['project/ci/recording/diagnostics/12-2.json', diagnosticText]]))
  restoreTrustedProject(canonical, 'origin', provenance, downloaded)
  const resolutionMock = join(work, 'source-mock.mjs')
  writeFileSync(resolutionMock, `globalThis.fetch = async url => { if (!String(url).endsWith('/actions/runs/12/attempts/2')) throw new Error('unexpected mocked request'); return { ok: true, status: 200, json: async () => (${JSON.stringify(run)}) }; };`)
  const resolveFailure = expected => spawnSync(process.execPath, ['--import', pathToFileURL(resolutionMock).href, join(repo, 'ci/tools/ci-record.mjs'), '--mode', 'resolve-diagnostic', '--repo', canonical, '--project', project, '--environment', 'delivery-state-resolution', '--owner', 'fixture-operator', '--expected-state', expected, '--diagnostic-run', '12-2', '--confirmation-ref', 'fixture-reviewed-failure/12-2'], { cwd: canonical, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'fixture-operator', GITHUB_REPOSITORY: 'fixture/repo', DSH_RESOLUTION_ENVIRONMENT: 'delivery-state-resolution', DSH_RESOLUTION_OWNER: 'fixture-operator', DSH_GITHUB_READ_TOKEN: 'offline-source-mock-only' } })
  const approved = resolveFailure(resolutionBase)
  check(approved.status === 0, `synthetic approved counted failure resolution: ${approved.stderr}`)
  const resolvedSHA = stateParent(canonical)
  check(git(canonical, ['show', `${resolvedSHA}:project/.agent/attempts.jsonl`]) === ledger1, 'resolution never edits or removes failed budget history')
  check(git(canonical, ['show', `${resolvedSHA}:project/ci/recording/diagnostics/12-2.json`]) === git(canonical, ['show', `${resolutionBase}:project/ci/recording/diagnostics/12-2.json`]), 'resolution retains original diagnostic bytes')
  check(JSON.parse(git(canonical, ['show', `${resolvedSHA}:project/ci/recording/resolutions/12-2.json`])).disposition === 'retained-counted-failure', 'only append-only counted-failure disposition persists')
  check(resolveFailure(first.state_sha).status === 2 && stateParent(canonical) === resolvedSHA, 'stale reviewed state cannot resolve or overwrite newer state')
  check(resolveFailure(resolvedSHA).status === 2 && stateParent(canonical) === resolvedSHA, 'latest SHA with stale restored resolution files still fails closed')
  restoreTrustedProject(canonical, 'origin', provenance, downloaded)
  check(resolveFailure(resolvedSHA).status === 0 && stateParent(canonical) === resolvedSHA, 'same reviewed resolution retries after full state restoration without resetting history')
  check(git(canonical, ['ls-remote', 'origin', 'refs/heads/baseline/main']) === baselineBefore, 'resolution never advances Baseline')
  // Seed migration is a separate local bare target, never the real remote/state.
  const seedRemote = join(work, 'bootstrap-seed.git')
  execFileSync('git', ['init', '--bare', '--quiet', seedRemote])
  git(canonical, ['remote', 'add', 'seed-target', seedRemote])
  const bootstrapSeed = (seed, environmentOverrides = {}) => spawnSync(process.execPath, ['--import', pathToFileURL(resolutionMock).href, join(repo, 'ci/tools/ci-record.mjs'), '--mode', 'bootstrap', '--repo', canonical, '--project', project, '--remote', 'seed-target', '--environment', 'delivery-state-bootstrap', '--owner', 'fixture-operator', '--seed', seed], { cwd: canonical, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'fixture-operator', GITHUB_REPOSITORY: 'fixture/repo', DSH_BOOTSTRAP_ENVIRONMENT: 'delivery-state-bootstrap', DSH_BOOTSTRAP_OWNER: 'fixture-operator', DSH_GITHUB_READ_TOKEN: 'offline-source-mock-only', ...environmentOverrides } })
  check(bootstrapSeed('owner-approved-empty').status === 2 && stateParent(canonical, 'seed-target', false) === null, 'empty seed cannot erase retained recording/evidence history')
  check(bootstrapSeed('existing-ledger', { GITHUB_ACTIONS: 'false' }).status === 2 && stateParent(canonical, 'seed-target', false) === null, 'bootstrap requires the CI entry point before any state write')
  check(bootstrapSeed('existing-ledger', { DSH_GITHUB_READ_TOKEN: '' }).status === 2 && stateParent(canonical, 'seed-target', false) === null, 'existing seed cannot bypass independent exact-source API confirmation')
  const seededHistory = bootstrapSeed('existing-ledger')
  check(seededHistory.status === 0, `bootstrap preserves validated source graph: ${seededHistory.stderr}`)
  const seededSHA = stateParent(canonical, 'seed-target')
  const originalSeedMarker = readFileSync(join(project, 'ci/recording/bootstrap.json'))
  check(git(canonical, ['show', `${seededSHA}:project/ci/recording/seed-initializations/${sha256(originalSeedMarker)}.json`]) === originalSeedMarker.toString().trim(), 'original initialization marker is archived by raw-byte digest, never overwritten')
  check(JSON.parse(git(canonical, ['show', `${seededSHA}:project/ci/recording/bootstrap.json`])).owner === 'fixture-operator', 'new initialization records its own synthetic reviewed owner')
  for (const path of ['project/.agent/attempts.jsonl', 'project/ci/recording/receipts/12-2.json', 'project/ci/recording/diagnostics/12-2.json', 'project/ci/recording/resolutions/12-2.json']) check(git(canonical, ['show', `${seededSHA}:${path}`]) === git(canonical, ['show', `${resolvedSHA}:${path}`]), `bootstrap preserves original bytes: ${path}`)
  check(bootstrapSeed('existing-ledger').status === 2 && stateParent(canonical, 'seed-target') === seededSHA, 'bootstrap cannot reset the initialized target')
  check(stateParent(canonical) === resolvedSHA && git(canonical, ['ls-remote', 'origin', 'refs/heads/baseline/main']) === baselineBefore, 'seed migration never modifies donor state or Baseline')
  const successRun = { ...run, id: 13, run_attempt: 1, conclusion: 'success' }
  const successProvenance = validateProvenance({ ...receipt, run_id: 13, run_attempt: 1 }, successRun, 'fixture/repo')
  const rawSuccess = evidence('13-1', 'PASS')
  rawSuccess.trust = { transport_verified: true, runtime_isolation_verified: true }
  writeFileSync(join(downloaded, 'evidence.json'), JSON.stringify(rawSuccess))
  const second = recordAttempt({ repo: canonical, project, provenance: successProvenance, evidenceDir: downloaded })
  check(second.status === 'recorded', JSON.stringify(second))
  const stored = JSON.parse(git(canonical, ['show', `${second.state_sha}:project/ci/evidence/${sha256(rawSuccess.evidence_id)}.json`]))
  check(stored.trust.transport_verified === true && stored.trust.runtime_isolation_verified === false, 'Candidate-supplied isolation claim is replaced, not promoted to authoritative proof')
  const ledger2 = git(canonical, ['show', `${second.state_sha}:project/.agent/attempts.jsonl`]).split('\n')
  check(ledger2.length === 2 && JSON.parse(ledger2[1]).result === 'passed' && ledger2[0] === ledger1, 'PASS appends without overwriting failed attempt')
  const missingProvenance = { ...provenance, run_id: 14, run_attempt: 1, run_key: '14-1' }
  restoreTrustedProject(canonical, 'origin', missingProvenance, join(work, 'absent'))
  const absent = recordAttempt({ repo: canonical, project, provenance: missingProvenance, evidenceDir: join(work, 'absent') })
  check(absent.status === 'blocked' && git(canonical, ['show', `${absent.state_sha}:project/ci/recording/diagnostics/14-1.json`]).includes('exactly one'), 'missing artifact becomes durable blocking diagnostic')
  const absentRepeat = recordAttempt({ repo: canonical, project, provenance: missingProvenance, evidenceDir: join(work, 'absent') })
  check(absentRepeat.status === 'blocked' && absentRepeat.duplicate && absentRepeat.state_sha === absent.state_sha, 'repeating a blocked record retains its diagnostic without claiming success')
  const corruptedProvenance = { ...provenance, run_id: 15, run_attempt: 1, run_key: '15-1' }
  restoreTrustedProject(canonical, 'origin', corruptedProvenance, join(work, 'absent'))
  writeFileSync(join(downloaded, 'evidence.json'), '{broken-json')
  const corrupted = recordAttempt({ repo: canonical, project, provenance: corruptedProvenance, evidenceDir: downloaded })
  check(corrupted.status === 'blocked' && corrupted.errors.length > 0, 'corrupt artifact produces blocking state')
  check(budgetPrecheck(loadModel(project), 'S1', 'S1', true, [{ run_key: '14-1' }]).blockers.some(b => b.includes('diagnostic')), 'diagnostic is fail-closed at next precheck')
  const damagedProvenance = { ...provenance, run_id: 16, run_attempt: 1, run_key: '16-1' }
  restoreTrustedProject(canonical, 'origin', damagedProvenance, join(work, 'absent'))
  writeFileSync(join(downloaded, 'evidence.json'), JSON.stringify(evidence('16-1')))
  writeFileSync(join(downloaded, 'artifact/src/fixture.mjs'), 'damaged')
  const damaged = recordAttempt({ repo: canonical, project, provenance: damagedProvenance, evidenceDir: downloaded })
  check(damaged.status === 'blocked' && damaged.attempt_id && git(canonical, ['show', `${damaged.state_sha}:project/.agent/attempts.jsonl`]).includes('ci:verify:16-1'), 'damaged binary does not erase a valid failed attempt')
  const invalidModel = loadModel(project)
  invalidModel.attempts = [{ bad: true }]
  check(budgetPrecheck(invalidModel, 'S1').blockers.length > 0, 'invalid history blocks execution')
  const exhaustedModel = loadModel(project)
  exhaustedModel.cfg.budget.total_attempt_limit = 1
  check(budgetPrecheck(exhaustedModel, 'S1').blockers.includes('attempt budget exhausted'), 'counted history enforces budget')
  const bootstrap = spawnSync(process.execPath, [join(repo, 'ci/tools/ci-record.mjs'), '--mode', 'bootstrap', '--repo', canonical, '--project', project, '--owner', 'fixture', '--environment', 'delivery-state-bootstrap', '--seed', 'owner-approved-empty'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_ACTOR: 'fixture', GITHUB_REF: 'refs/heads/main', DSH_BOOTSTRAP_OWNER: 'fixture', DSH_BOOTSTRAP_ENVIRONMENT: 'delivery-state-bootstrap' } })
  check(bootstrap.status === 2 && bootstrap.stderr.includes('cannot be reset'), 'explicit bootstrap never resets existing state')
  check(!existsSync(join(project, 'ci/recording/race.json')), 'fixture did not materialize stale race state')
  const ledgerlessRemote = join(work, 'ledgerless.git')
  git(work, ['init', '--bare', '--quiet', ledgerlessRemote])
  git(canonical, ['remote', 'add', 'ledgerless', ledgerlessRemote])
  persistState(canonical, null, new Map([['project/ci/recording/bootstrap.json', '{}\n']]), 'ledgerless')
  const ledgerless = recordAttempt({ repo: canonical, project, remote: 'ledgerless', provenance: { ...provenance, run_key: '17-1', run_id: 17, run_attempt: 1 }, evidenceDir: downloaded })
  check(ledgerless.status === 'blocked' && ledgerless.errors.some(e => e.includes('attempt log missing')), 'ledgerless existing state gets durable diagnostic, never a reset')
  throws(() => git(canonical, ['show', `${ledgerless.state_sha}:project/.agent/attempts.jsonl`]))
  const bootRoot = join(work, 'bootstrap')
  const bootRemote = join(work, 'bootstrap.git')
  git(canonical, ['worktree', 'add', '--detach', bootRoot, revision])
  git(work, ['init', '--bare', '--quiet', bootRemote])
  git(bootRoot, ['remote', 'add', 'bootstrap', bootRemote])
  const bootEnv = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_ACTOR: 'fixture', GITHUB_REF: 'refs/heads/main', DSH_BOOTSTRAP_OWNER: 'fixture', DSH_BOOTSTRAP_ENVIRONMENT: 'delivery-state-bootstrap' }
  function boot(owner, seed) { return spawnSync(process.execPath, [join(repo, 'ci/tools/ci-record.mjs'), '--mode', 'bootstrap', '--repo', bootRoot, '--project', join(bootRoot, 'project'), '--remote', 'bootstrap', '--owner', owner, '--environment', 'delivery-state-bootstrap', '--seed', seed], { encoding: 'utf8', env: bootEnv }) }
  check(boot('wrong-owner', 'owner-approved-empty').status === 2, 'bootstrap rejects owner mismatch before state creation')
  check(boot('fixture', 'existing-ledger').status === 2 && stateParent(bootRoot, 'bootstrap', false) === null, 'missing existing seed is never silently initialized')
  const orphanSeedPath = join(bootRoot, 'project/ci/recording/diagnostics/orphan.json')
  mkdirSync(dirname(orphanSeedPath), { recursive: true })
  writeFileSync(orphanSeedPath, '{"orphan":true}\n')
  const orphanModel = loadModel(join(bootRoot, 'project'))
  check(orphanModel.attempts.length === 0 && orphanModel.evidence.length === 0 && orphanModel.baselines.length === 0, 'raw orphan initialization fixture is invisible to model history lists')
  check(boot('fixture', 'owner-approved-empty').status === 2 && stateParent(bootRoot, 'bootstrap', false) === null, 'empty seed rejects orphan raw recording even when all model history lists are empty')
  assert.ok(resolve(orphanSeedPath).startsWith(`${resolve(bootRoot)}${sep}`))
  rmSync(orphanSeedPath)
  const approvedEmpty = boot('fixture', 'owner-approved-empty')
  check(approvedEmpty.status === 0, `explicit owner-approved empty first initialization: ${approvedEmpty.stderr}`)
  const bootSHA = stateParent(bootRoot, 'bootstrap')
  check(git(bootRoot, ['show', `${bootSHA}:project/.agent/attempts.jsonl`]) === '', 'explicit first bootstrap creates known-empty ledger')
  check(boot('fixture', 'owner-approved-empty').status === 2 && stateParent(bootRoot, 'bootstrap') === bootSHA, 'bootstrap replay cannot reset initialized state')
  const abortRun = { ...run, id: 99, run_attempt: 1, conclusion: 'failure' }
  const abortSource = validateProvenance({ ...receipt, run_id: 99, run_attempt: 1 }, abortRun, 'fixture/repo')
  restoreTrustedProject(canonical, 'origin', abortSource, downloaded)
  const budgetBeforeAbort = budgetPrecheck(loadModel(project), 'S1').budget.counted
  const abortClaim = evidence('99-1', 'INFRA_ABORTED')
  writeFileSync(join(downloaded, 'evidence.json'), JSON.stringify(abortClaim))
  writeFileSync(join(downloaded, 'artifact/src/fixture.mjs'), bytes) // Undo earlier intentional byte-corruption fixture.
  const countedAbort = recordAttempt({ repo: canonical, project, provenance: abortSource, evidenceDir: downloaded })
  check(countedAbort.status === 'recorded', `unproven abort conservatively retained: ${JSON.stringify(countedAbort)}`)
  const retainedAbort = JSON.parse(git(canonical, ['show', `${countedAbort.state_sha}:project/ci/evidence/${sha256(abortClaim.evidence_id)}.json`]))
  check(retainedAbort.execution.result === 'ERROR' && retainedAbort.collection.source_execution_result === 'INFRA_ABORTED' && retainedAbort.trust.runtime_isolation_verified === false, 'collector keeps original abort claim but never grants exemption or runtime trust')
  restoreTrustedProject(canonical, 'origin', abortSource, downloaded)
  const abortBudget = budgetPrecheck(loadModel(project), 'S1').budget
  check(abortBudget.counted === budgetBeforeAbort + 1 && abortBudget.infra_aborted === 0, 'unproven infrastructure abort consumes one failure, not zero attempts')
  check(git(canonical, ['ls-remote', 'origin', 'refs/heads/baseline/main']) === baselineBefore, 'abort accounting never advances Baseline')
} finally { rmSync(work, { recursive: true, force: true }) }
console.log(`ci-record.test ok: ${checks} offline bare-fixture and static workflow checks`)
