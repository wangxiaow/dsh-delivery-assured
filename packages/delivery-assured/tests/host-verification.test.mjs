#!/usr/bin/env node
/**
 * Host-executed verification: the default completion backend.
 *
 * This suite drives the real `verify.mjs --backend host` against a throwaway Git
 * project, so what it asserts is what the product does, not what a helper returns:
 *
 *   - the frozen gates and the frozen Required acceptance really execute, and a PASS
 *     record plus its retained run log and receipt are written;
 *   - `Delivered` is then computed from that record, with no CI run, no authority ref,
 *     no push token and no Baseline promotion;
 *   - a Required case that did not execute, a record bound to another revision, a
 *     hand-written "PASS" file, a skipped acceptance gate and a standard changed after
 *     the freeze are all refused;
 *   - the trusted-CI evidence entry point is unchanged (it still needs its issuer).
 *
 * Run: node packages/delivery-assured/tests/host-verification.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const verifyScript = join(packRoot, 'scripts', 'verify.mjs')
const resumeScript = join(packRoot, 'scripts', 'resume.mjs')

const { assessDelivery, resolveVerification } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'index.mjs')).href)
const { loadModel } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'model.mjs')).href)
const { computeConvergence } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'convergence.mjs')).href)
const { loadProjectConfig, loadEvidence } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'common.mjs')).href)
const { validateHostEvidenceRecord } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'evidence.mjs')).href)
const { buildBaseEnv } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'env.mjs')).href)

/**
 * Every subprocess this suite starts runs with an explicitly constructed
 * environment: the minimal platform base plus what the scenario declares. Inheriting
 * `process.env` made the meaning of a Host-backend test depend on whether it ran
 * inside a CI job that exports `DSH_CI_ISSUER` and the deployment identity.
 */
const SAFE_ENV = buildBaseEnv()

const SPEC_ONE = `
export const id = 'A-HELLO-001'
export default async function run(api) { return api.greet() }
export function assertions(observed) { return [['greeting is hello', observed === 'hello', String(observed)]] }
`

const SPEC_TWO = `
export const id = 'A-HELLO-002'
export default async function run(api) { return api.quietFailure() }
export function assertions(observed) { return [['a failure leaks nothing', observed.ok === false && !/stack|sql/i.test(String(observed.message)), JSON.stringify(observed)]] }
`

const DRIVER = `
const state = { greeted: 0 }
export default {
  async greet() { state.greeted += 1; return 'hello' },
  async quietFailure() { return { ok: false, message: 'request rejected' } },
  async cleanup() {},
}
`

/** A minimal acceptance harness with the same contract verify.mjs depends on. */
const HARNESS = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const argv = process.argv.slice(2)
const scope = argv.includes('--scope') ? argv[argv.indexOf('--scope') + 1] : 'all'
const parse = (text) => {
  const doc = { cases: [], case_ids: [] }
  let list = null
  let current = null
  for (const line of text.split('\\n')) {
    if (/^cases:/.test(line)) { list = 'cases'; continue }
    if (/^case_ids:/.test(line)) { list = 'ids'; continue }
    if (/^\\s*- id:/.test(line) && list === 'cases') { current = { id: line.split('id:')[1].trim() }; doc.cases.push(current); continue }
    if (/^\\s*- /.test(line) && list === 'ids') { doc.case_ids.push(line.replace(/^\\s*-\\s*/, '').trim()); continue }
    if (/^\\s+required:/.test(line) && current) current.required = /true/.test(line)
    if (/^\\s+method:/.test(line) && current) current.method = line.split('method:')[1].trim()
    if (/^\\s+spec_ref:/.test(line) && current) current.spec_ref = line.split('spec_ref:')[1].trim()
    if (/^\\s+revision:/.test(line)) doc.revision = Number(line.split('revision:')[1].trim())
  }
  return doc
}
const manifest = parse(readFileSync(resolve(root, 'tests/acceptance/spec/manifest.yaml'), 'utf8'))
const spine = existsSync(resolve(root, 'tests/spine/manifest.yaml')) ? parse(readFileSync(resolve(root, 'tests/spine/manifest.yaml'), 'utf8')) : { case_ids: [] }
const automated = new Map(manifest.cases.filter((c) => c.required === true && c.method === 'automated').map((c) => [c.id, c]))
const declared = process.env.DSH_REQUIRED_CASE_IDS ? JSON.parse(process.env.DSH_REQUIRED_CASE_IDS) : null
const required = Array.isArray(declared) && declared.length > 0 ? declared : [...automated.keys(), ...spine.case_ids]
const slice = required.filter((id) => !spine.case_ids.includes(id))
const selected = [...new Set(scope === 'spine' ? required.filter((id) => spine.case_ids.includes(id)) : scope === 'slice' ? slice : required)].sort()
if (selected.length === 0) { process.stdout.write('nothing to execute\\n'); process.exit(0) }
const api = (await import(pathToFileURL(resolve(root, 'tests/acceptance/driver/index.mjs')).href)).default
const token = process.env.DSH_VERIFICATION_RUN_TOKEN || 'manual'
const out = resolve(root, '.agent/evidence/acceptance-results.json')
let merged = []
if (existsSync(out)) { try { const prior = JSON.parse(readFileSync(out, 'utf8')); if (prior.run_token === token) merged = prior.results } catch {} }
const results = []
for (const id of selected) {
  const definition = automated.get(id)
  const started = Date.now()
  if (!definition) { results.push({ case_id: id, outcome: 'errored', duration_ms: 0, message: 'not a Required automated case' }); continue }
  try {
    const spec = await import(pathToFileURL(resolve(root, definition.spec_ref)).href)
    const observed = await spec.default(api)
    const checks = spec.assertions(observed)
    const failed = checks.filter((c) => c[1] !== true)
    results.push({ case_id: id, outcome: failed.length ? 'failed' : 'passed', duration_ms: Date.now() - started, message: failed.map((c) => String(c[0])).join('; ') })
  } catch (error) { results.push({ case_id: id, outcome: 'errored', duration_ms: Date.now() - started, message: String(error && error.message) }) }
}
try { await api.cleanup() } catch {}
const kept = merged.filter((entry) => !selected.includes(entry.case_id))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ run_token: token, spec_revision: manifest.revision, scope, results: [...kept, ...results] }, null, 2) + '\\n', 'utf8')
const failed = results.filter((r) => r.outcome !== 'passed')
process.stdout.write('acceptance ' + (results.length - failed.length) + '/' + results.length + ' passed\\n')
for (const entry of failed) process.stdout.write('  FAIL ' + entry.case_id + ': ' + entry.message + '\\n')
process.exit(failed.length ? 1 : 0)
`

const CONTRACT = `schema_version: "0.5"
contract_version: 1
status: frozen
product:
  id: host-verification-fixture
  project_types: [api]
journeys:
  - id: J-HELLO
    title: 说你好
    required: true
    outcomes:
      - id: J-HELLO.GREETED
        required: true
        observable: "入口返回 hello"
capabilities:
  - id: C-ENTRY
    required: true
    observable: "入口可运行"
business_rules:
  - id: BR-NO-LEAK
    severity: critical
    required: true
    statement: 失败响应不泄漏内部细节
completion_policy:
  mode: independent_auto
  authorization_ref: "requirement:FIXTURE-1 — 用户要求可运行的自动化验收，未要求人工签收"
acceptance:
  manifest_ref: tests/acceptance/spec/manifest.yaml
  protected_revision: ""
  manual_reviews: []
  automated_reviews:
    - id: R-HELLO
      obligation_ids: [J-HELLO, J-HELLO.GREETED, C-ENTRY, BR-NO-LEAK]
      case_ids: [A-HELLO-001, A-HELLO-002]
`

const MANIFEST = `revision: 1
cases:
  - id: A-HELLO-001
    obligation_ids: [J-HELLO, J-HELLO.GREETED, C-ENTRY]
    outcome_ids: [J-HELLO.GREETED]
    required: true
    method: automated
    spec_ref: tests/acceptance/spec/A-HELLO-001.mjs
  - id: A-HELLO-002
    obligation_ids: [J-HELLO, BR-NO-LEAK]
    outcome_ids: [J-HELLO.GREETED]
    required: true
    method: automated
    spec_ref: tests/acceptance/spec/A-HELLO-002.mjs
`

const SLICE = `id: S1
slice_key: hello-v1
status: IN_PROGRESS
obligations: [J-HELLO, J-HELLO.GREETED, C-ENTRY, BR-NO-LEAK]
outcomes: [J-HELLO.GREETED]
acceptance: [A-HELLO-001, A-HELLO-002]
`

const VERIFIER = `gates:
  - gate: build
    command: node scripts/gate.mjs build
  - gate: clean_boot
    command: node scripts/gate.mjs clean_boot
  - gate: persistence_migration
    command: node scripts/gate.mjs persistence_migration
  - gate: slice_acceptance
    command: node tests/harness/run-acceptance.mjs --scope slice
  - gate: regression_spine
    command: node tests/harness/run-acceptance.mjs --scope spine
  - gate: deployment
    local: skip
    description: only the protected CI job can observe a packaged deployment
    command: node scripts/gate.mjs deployment
acceptance:
  result_file: .agent/evidence/acceptance-results.json
`

/** Create a committed fixture project and freeze its standard. */
function makeProject({ freeze = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'da-host-verify-'))
  const write = (relative, content) => {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  write('.agent/project.yaml', 'project:\n  id: host-verification-fixture\nattempt_budget:\n  total_attempt_limit: 8\n  same_root_cause_limit: 3\n  no_progress_window: 3\n  replan_limit: 2\n')
  write('.agent/CONTRACT.yaml', CONTRACT)
  write('.agent/slices/S1.yaml', SLICE)
  write('tests/acceptance/spec/manifest.yaml', MANIFEST)
  write('tests/acceptance/spec/A-HELLO-001.mjs', SPEC_ONE)
  write('tests/acceptance/spec/A-HELLO-002.mjs', SPEC_TWO)
  write('tests/acceptance/driver/index.mjs', DRIVER)
  write('tests/harness/run-acceptance.mjs', HARNESS)
  write('tests/spine/manifest.yaml', 'revision: 1\ncase_ids: []\n')
  write('ci/verifier.yaml', VERIFIER)
  write('scripts/gate.mjs', 'process.exit(0)\n')
  write('.gitattributes', '* text=auto eol=lf\n')
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'fixture@example.com'])
  git(root, ['config', 'user.name', 'fixture'])
  git(root, ['config', 'core.autocrlf', 'false'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'fixture: frozen standard and implementation'])
  if (freeze) {
    const result = run([verifyScript, '--project', root, '--freeze-standard', '--json'], root)
    assert.equal(result.status, 0, `freeze failed: ${result.stderr || result.stdout}`)
  }
  return { root, write }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function run(argv, cwd, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, argv, { cwd, encoding: 'utf8', env: { ...SAFE_ENV, ...env } })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }
  }
}

function hostVerify(root, extra = []) {
  return run([verifyScript, '--project', root, '--backend', 'host', '--write-evidence', '--slice', 'S1', '--json', ...extra], root)
}

function deliveredIn(root) {
  const cfg = loadProjectConfig(root)
  const model = loadModel(root)
  const verification = resolveVerification(cfg)
  const candidate = git(root, ['rev-parse', 'HEAD']).trim()
  return {
    verification,
    model,
    verdict: assessDelivery(model, { candidate, acceptedIssuers: verification.acceptedIssuers, verification }),
  }
}

/* --------------------------------------------------------------- the happy path */

test('the host executes the frozen acceptance and the delivery is Delivered with no CI, ref or Baseline', () => {
  const { root } = makeProject()
  try {
    const attemptsPath = join(root, '.agent', 'attempts.jsonl')
    writeFileSync(attemptsPath, `${JSON.stringify({ attempt_id: 'A-1', result: 'failed', note: 'historical failure that must not be rewritten' })}\n`, 'utf8')
    const attemptsBefore = readFileSync(attemptsPath)

    const result = hostVerify(root)
    assert.equal(result.status, 0, `host verification must pass: ${result.stderr || result.stdout}`)
    const report = JSON.parse(result.stdout)
    assert.equal(report.mode, 'evidence')
    assert.equal(report.verification_backend, 'host_executed')
    assert.equal(report.cases.executed, 2)
    assert.equal(report.cases.skipped, 0)

    // The record, its gate log and its receipt all exist and are bound to each other.
    const evidence = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    assert.equal(evidence.environment.kind, 'host_independent')
    assert.equal(evidence.environment.observed.deployment, false)
    assert.deepEqual(validateHostEvidenceRecord(evidence), [])
    assert.ok(evidence.execution.artifacts.includes(evidence.execution.run_log))
    const logPath = join(root, evidence.execution.run_log)
    assert.ok(existsSync(logPath), 'the retained gate log exists')
    assert.ok(readFileSync(logPath, 'utf8').includes('gate build'), 'the log carries the real gate output')
    const receipt = JSON.parse(readFileSync(join(root, '.agent/evidence/runs', evidence.execution.ci_run_id, 'receipt.json'), 'utf8'))
    assert.equal(receipt.evidence_ref, evidence.evidence_id)
    assert.equal(receipt.result, 'PASS')
    assert.equal(receipt.spine.added.length, 2)
    // A run artifact must never be loaded as a second evidence record for the same id.
    assert.equal(receipt.evidence_id, undefined)

    // A passing host run is what freezes the candidate, so it grows the Spine itself.
    const spine = readFileSync(join(root, 'tests/spine/manifest.yaml'), 'utf8')
    assert.ok(spine.includes('A-HELLO-001') && spine.includes('A-HELLO-002'), spine)

    // History is not rewritten: the pre-existing failure line survives byte-for-byte and
    // the host attempt is appended to it. No Baseline is invented.
    const ledgerAfter = readFileSync(attemptsPath)
    assert.ok(ledgerAfter.subarray(0, attemptsBefore.length).equals(attemptsBefore), 'the historical failure line was rewritten')
    const ledgerLines = ledgerAfter.toString('utf8').trim().split('\n')
    assert.equal(ledgerLines.length, 2, ledgerAfter.toString('utf8'))
    assert.equal(JSON.parse(ledgerLines[1]).result, 'passed', 'the host attempt is recorded with its real result')
    assert.equal(existsSync(join(root, 'ci', 'baseline')), false, 'no Baseline metadata was written')
    const refs = git(root, ['for-each-ref', '--format=%(refname)'])
    assert.ok(!/refs\/heads\/(baseline|delivery-state|standards)/.test(refs), refs)

    // The verdict recomputes from the record alone.
    const { verdict, verification } = deliveredIn(root)
    assert.equal(verification.backend, 'host_executed')
    assert.deepEqual(verification.acceptedIssuers, ['host:independent-verifier'])
    assert.equal(verdict.delivered, true, JSON.stringify(verdict.blocking))
    assert.equal(verdict.verification.evidence_id, evidence.evidence_id)
    assert.equal(verdict.verification.backend, 'host_executed')
    assert.match(verdict.limitations.join(' '), /no packaged deployment or runtime isolation/)
    // …and the retained run artifacts are not loaded as evidence of their own, which
    // would both duplicate the record and give the budget a record with no issuer.
    const loaded = loadEvidence(root, loadProjectConfig(root))
    assert.equal(loaded.length, 1, JSON.stringify(loaded.map((entry) => entry.__file)))
    assert.equal(loaded[0].evidence_id, evidence.evidence_id)
    assert.equal(loaded[0].issuer?.identity, verification.hostIssuer)

    // …and `resume` reports the same verdict for the same project.
    const resume = run([resumeScript, '--project', root, '--offline', '--json'], root)
    const resumeReport = JSON.parse(resume.stdout)
    assert.equal(resumeReport.delivered, true, JSON.stringify(resumeReport.delivery?.blocking))
    assert.equal(resumeReport.delivery.backend, 'host_executed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two host runs on one candidate share a comparison identity, so no false Replan appears', () => {
  const { root } = makeProject()
  try {
    assert.equal(hostVerify(root).status, 0)
    assert.equal(hostVerify(root).status, 0)
    const cfg = loadProjectConfig(root)
    const model = loadModel(root)
    const verification = resolveVerification(cfg)
    const candidate = git(root, ['rev-parse', 'HEAD']).trim()
    const budget = computeConvergence(model, { candidate, acceptedIssuers: verification.acceptedIssuers })
    // The environment identity of a run must not include the run itself: with a per-run
    // fingerprint every host pass looked like a changed standard, the no-progress window
    // filled up with identical passes and the budget demanded a Replan that was not needed.
    assert.equal(budget.counted, 2, JSON.stringify(budget.per_root_cause))
    assert.deepEqual(budget.changed_comparison, [], JSON.stringify(budget.changed_comparison))
    assert.equal(budget.noProgressStreak, 0, JSON.stringify(budget.progress))
    assert.equal(budget.requires_replan, false)
    assert.equal(budget.budget_blocked, false)
    assert.equal(budget.terminal_passed, true)
    assert.deepEqual(budget.invalid_entries, [])
    assert.equal(assessDelivery(model, { candidate, acceptedIssuers: verification.acceptedIssuers, verification, budget }).delivered, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a required case that did not execute can never become a PASS', () => {
  const { root, write } = makeProject()
  try {
    // The second case is required by the frozen manifest but its spec now errors.
    write('tests/acceptance/driver/index.mjs', DRIVER.replace("return { ok: false, message: 'request rejected' }", "throw new Error('driver broke')"))
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'candidate: break the driver'])

    const result = hostVerify(root)
    assert.equal(result.status, 1)
    const report = JSON.parse(result.stdout)
    assert.equal(report.cases.failed, 1, JSON.stringify(report.cases))
    assert.ok(report.blocking.some((entry) => entry.code === 'CASE_NOT_PASSED'), JSON.stringify(report.blocking))
    // The failing run is retained as evidence of the failure, never as a pass.
    const record = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    assert.equal(record.execution.result, 'FAIL')
    assert.deepEqual(record.execution.case_results.map((entry) => entry.outcome), ['passed', 'errored'])
    const { verdict } = deliveredIn(root)
    assert.equal(verdict.delivered, false)
    assert.equal(verdict.verification, null)
    assert.ok(verdict.blocking.some((line) => /not proved on this candidate/.test(line)), JSON.stringify(verdict.blocking))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ refusals */

test('a standard changed after the freeze refuses the run instead of verifying something nobody froze', () => {
  const { root, write } = makeProject()
  try {
    write('tests/acceptance/spec/manifest.yaml', MANIFEST.replace(/  - id: A-HELLO-002\n(?:    .*\n)+/, ''))
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'candidate: drop a required case'])
    const result = hostVerify(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /STANDARD_DRIFT/, result.stderr)
    assert.equal(existsSync(join(root, '.agent', 'evidence')), false, 'nothing was recorded for a drifted standard')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a spec edited after the freeze is refused even when its digest record is untouched', () => {
  const { root, write } = makeProject()
  try {
    write('tests/acceptance/spec/A-HELLO-001.mjs', SPEC_ONE.replace("return [['greeting is hello', observed === 'hello', String(observed)]]", "return [['greeting is hello', true, 'trimmed']]"))
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'candidate: weaken the assertion'])
    const result = hostVerify(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /STANDARD_DRIFT|FREEZE_UNCOMMITTED_EDIT|FREEZE_NOT_FROZEN_BY_COMMIT/, result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a run without a frozen standard is refused before a single gate executes', () => {
  const { root } = makeProject({ freeze: false })
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /FREEZE_MISSING/, result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an uncommitted candidate cannot be verified as if it were the committed revision', () => {
  const { root, write } = makeProject()
  try {
    // A tracked source file modified in the worktree. Git reports this as
    // ` M scripts/gate.mjs`, which is the exact shape a naive porcelain parser mangled.
    write('scripts/gate.mjs', 'process.exit(0)\n// touched by the candidate\n')
    const result = hostVerify(root)
    assert.equal(result.status, 1)
    const report = JSON.parse(result.stdout)
    // The failure names the real path: a status letter left on the path would both
    // un-match the exclusions and misreport what changed.
    assert.ok(
      report.structural.some((entry) => entry.code === 'CANDIDATE_DIRTY' && /scripts\/gate\.mjs/.test(entry.message)),
      JSON.stringify(report.structural),
    )
    assert.deepEqual(report.blocking.map((entry) => entry.code), ['CANDIDATE_DIRTY'])

    // An edited frozen spec is caught as standard drift, before the dirty check — even
    // when the edit is a comment that changes no behaviour.
    const specPath = join(root, 'tests/acceptance/spec/A-HELLO-002.mjs')
    writeFileSync(specPath, `${readFileSync(specPath, 'utf8')}// candidate edit: the standard must not move\n`)
    const drifted = hostVerify(root)
    assert.equal(drifted.status, 1)
    assert.match(drifted.stderr, /STANDARD_DRIFT/, drifted.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the state a session legitimately writes does not make the candidate dirty', () => {
  const { root, write } = makeProject()
  try {
    // Exactly what a session does before asking for verification: it appends to its own
    // iteration journal and the editable STATE hint. Treating those as candidate changes
    // refused the run and pushed a real session into parking them with `git stash`.
    write('.agent/ITERATIONS.jsonl', `${JSON.stringify({ id: 'IT-001', kind: 'opened', at: new Date().toISOString(), requirement: '要求原文' })}\n`)
    write('.agent/STATE.yaml', 'current_slice: S1\n')
    write('.agent/reviews.yaml', 'reviews: []\n')
    write('.agent/STANDARD_CHANGES.yaml', 'changes: []\n')
    write('ci/mvp-ready.json', '{}\n')
    // The grown Spine is tracked, so it shows as ` M tests/spine/manifest.yaml`: the exact
    // shape that a naive porcelain parser turned into a bogus candidate change.
    write('tests/spine/manifest.yaml', 'last_updated: "x"\nupdated_by: "x"\ncase_ids: ["A-HELLO-001","A-HELLO-002"]\n')
    const result = hostVerify(root)
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
    const report = JSON.parse(result.stdout)
    assert.ok(!report.structural.some((entry) => entry.code === 'CANDIDATE_DIRTY'), JSON.stringify(report.structural))
    const record = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    assert.deepEqual(record.execution.host.dirty_paths, [])
    assert.ok(record.execution.host.state_excluded.includes('.agent/ITERATIONS.jsonl'), JSON.stringify(record.execution.host.state_excluded))
    assert.equal(record.execution.host.candidate_clean, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the acceptance gate cannot be declared away: a host record that skipped it fails validation', () => {
  const { root } = makeProject()
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 0)
    const evidencePath = resolve(root, JSON.parse(result.stdout).evidence_path)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    // Simulate a forged record with the acceptance gate marked not_applicable.
    const forged = {
      ...evidence,
      execution: {
        ...evidence.execution,
        gate_results: evidence.execution.gate_results.map((gate) =>
          gate.gate === 'slice_acceptance' ? { ...gate, outcome: 'not_applicable', exit_code: null, exclusion: 'declared', reason: 'nothing to do' } : gate,
        ),
      },
    }
    const problems = validateHostEvidenceRecord(forged)
    assert.ok(problems.some((message) => /slice_acceptance must really execute/.test(message)), JSON.stringify(problems))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a hand-written PASS file with the host issuer is not proof', () => {
  const { root } = makeProject()
  try {
    mkdirSync(join(root, '.agent', 'evidence'), { recursive: true })
    const candidate = git(root, ['rev-parse', 'HEAD']).trim()
    writeFileSync(
      join(root, '.agent', 'evidence', 'evidence-host-forged.json'),
      `${JSON.stringify({
        evidence_id: 'host:independent-verifier:forged',
        scope: { slice_id: 'S1', required_case_ids: ['A-HELLO-001', 'A-HELLO-002'] },
        bindings: { code_revision: candidate, parent_baseline: null },
        environment: { kind: 'host_independent', backend: 'host_executed', observed: { deployment: false, runtime_isolation: false, container: false }, not_observed: ['nothing'], config_fingerprint: 'forged' },
        execution: {
          ci_run_id: 'forged',
          result: 'PASS',
          required_cases: 2,
          executed_cases: 2,
          skipped_required_cases: 0,
          case_results: [
            { case_id: 'A-HELLO-001', outcome: 'passed' },
            { case_id: 'A-HELLO-002', outcome: 'passed' },
          ],
        },
        issuer: { identity: 'host:independent-verifier' },
      }, null, 2)}\n`,
      'utf8',
    )
    const { verdict } = deliveredIn(root)
    assert.equal(verdict.delivered, false, 'a hand-written file satisfied the verdict')
    assert.equal(verdict.verification, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a skipped Required case in a record is never a pass', () => {
  const { root } = makeProject()
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 0)
    const evidence = JSON.parse(readFileSync(resolve(root, JSON.parse(result.stdout).evidence_path), 'utf8'))
    const withSkip = {
      ...evidence,
      execution: {
        ...evidence.execution,
        skipped_required_cases: 1,
        case_results: evidence.execution.case_results.map((entry) => (entry.case_id === 'A-HELLO-002' ? { case_id: entry.case_id, outcome: 'skipped', duration_ms: 0 } : entry)),
      },
    }
    const problems = validateHostEvidenceRecord(withSkip)
    assert.ok(problems.some((message) => /a case failed, was skipped/.test(message)), JSON.stringify(problems))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a record bound to another revision is stale, not proof', () => {
  const { root, write } = makeProject()
  try {
    assert.equal(hostVerify(root).status, 0)
    write('src/hello.mjs', 'export const hello = 1\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'candidate: a new revision'])
    const { verdict } = deliveredIn(root)
    assert.equal(verdict.delivered, false)
    assert.ok(verdict.blocking.some((line) => /no fresh independent execution/.test(line)), JSON.stringify(verdict.blocking))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------- the CI backend is intact */

test('the trusted-CI evidence entry point still requires its issuer and its protected acceptance', () => {
  const { root } = makeProject()
  try {
    const noIssuer = run([verifyScript, '--project', root, '--write-evidence', '--slice', 'S1', '--json'], root)
    assert.equal(noIssuer.status, 2, noIssuer.stdout + noIssuer.stderr)
    assert.match(noIssuer.stderr, /DSH_CI_ISSUER/)

    // With its issuer set, trusted-CI evidence mode is still the same path: it demands the
    // protected acceptance revision and reports a CI-shaped environment, not a host one.
    const withIssuer = run([verifyScript, '--project', root, '--write-evidence', '--slice', 'S1', '--json'], root, { DSH_CI_ISSUER: 'ci:verify', DSH_CI_RUN_ID: '4242-1' })
    assert.equal(withIssuer.status, 1, withIssuer.stdout + withIssuer.stderr)
    const report = JSON.parse(withIssuer.stdout)
    assert.equal(report.verification_backend, 'trusted_ci')
    assert.ok(report.structural.some((entry) => entry.code === 'PROTECTED_ACCEPTANCE_UNAVAILABLE'), JSON.stringify(report.structural))
    const record = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    assert.equal(record.environment.kind, 'production_like_ci')
    assert.equal(record.execution.result, 'FAIL')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a project that declares trusted_ci cannot be completed by the host backend', () => {
  const { root, write } = makeProject()
  try {
    write('.agent/project.yaml', 'project:\n  id: host-verification-fixture\nverification:\n  backend: trusted_ci\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'declare the high-assurance backend'])
    const result = hostVerify(root)
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.match(result.stderr, /may not stand in for it/)
    const { verification, verdict } = deliveredIn(root)
    assert.equal(verification.backend, 'trusted_ci')
    assert.deepEqual(verification.acceptedIssuers, [], 'no issuer is accepted without a configured trusted issuer')
    assert.equal(verdict.delivered, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
