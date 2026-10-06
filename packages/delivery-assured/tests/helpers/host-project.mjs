/**
 * A throwaway committed Git project for the host-executed verification suites.
 *
 * The suites that drive `verify.mjs --backend host` need the same frozen standard:
 * a Contract, one Slice, a two-case acceptance manifest with real specs, a driver, a
 * harness and a verifier configuration. Keeping it here means the Spine,
 * environment, backend-capability and TCB suites all assert against one fixture, and
 * a change to the fixture cannot silently make one suite easier than another.
 *
 * Every subprocess this module starts runs with an *explicitly constructed*
 * environment (`buildBaseEnv()` plus what the scenario declares). Nothing here
 * inherits the ambient environment, so these suites mean the same thing whether they
 * run on a laptop or inside a GitHub Actions verification job.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const packRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const verifyScript = join(packRoot, 'scripts', 'verify.mjs')
export const resumeScript = join(packRoot, 'scripts', 'resume.mjs')

const { buildBaseEnv } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'env.mjs')).href)
const { assessDelivery, resolveVerification } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'index.mjs')).href)
const { loadModel } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'model.mjs')).href)
const { loadProjectConfig, loadEvidence } = await import(pathToFileURL(join(packRoot, 'scripts', 'lib', 'common.mjs')).href)

export { assessDelivery, loadEvidence, loadModel, loadProjectConfig, resolveVerification }

/** The allowlisted base environment every fixture subprocess starts from. */
export const SAFE_ENV = buildBaseEnv()

export const SPEC_ONE = `
export const id = 'A-HELLO-001'
export default async function run(api) { return api.greet() }
export function assertions(observed) { return [['greeting is hello', observed === 'hello', String(observed)]] }
`

export const SPEC_TWO = `
export const id = 'A-HELLO-002'
export default async function run(api) { return api.quietFailure() }
export function assertions(observed) { return [['a failure leaks nothing', observed.ok === false && !/stack|sql/i.test(String(observed.message)), JSON.stringify(observed)]] }
`

export const DRIVER = `
const state = { greeted: 0 }
export default {
  async greet() { state.greeted += 1; return 'hello' },
  async quietFailure() { return { ok: false, message: 'request rejected' } },
  async cleanup() {},
}
`

/** A minimal acceptance harness with the same contract verify.mjs depends on. */
export const HARNESS = `
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

export const CONTRACT = `schema_version: "0.5"
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

/**
 * A Contract that explicitly demands a platform-observed deployment.
 *
 * `deployment.required_observables` is the Contract's own statement that this fact must
 * be *observed*; environment names alone deliberately do not create that requirement
 * (see `lib/capability.mjs` and `templates/CONTRACT.yaml`). The host backend cannot
 * satisfy it and must not report Delivered.
 */
export const CONTRACT_REQUIRING_DEPLOYMENT = `${CONTRACT}deployment:
  slice_environment: staging
  mvp_ready_environment: staging
  release_target: "the fixture is installed and observed somewhere else"
  required_observables: [production_deployment]
  release_prerequisites:
    - id: verify-required-checks
      description: "the required checks passed on this exact candidate"
      verification: required_check_runs_on_candidate
      expects: ["structural checks"]
`

export const MANIFEST = `revision: 1
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

export const SLICE = `id: S1
slice_key: hello-v1
status: IN_PROGRESS
obligations: [J-HELLO, J-HELLO.GREETED, C-ENTRY, BR-NO-LEAK]
outcomes: [J-HELLO.GREETED]
acceptance: [A-HELLO-001, A-HELLO-002]
`

export const VERIFIER = `gates:
  - gate: build
    command: node scripts/gate.mjs build
    env:
      DSH_GATE_PROBE_OUT: "$DSH_GATE_PROBE_OUT"
      DSH_PROBE_FORWARDED: "$DSH_PROBE_FORWARDED"
  - gate: clean_boot
    command: node scripts/gate.mjs clean_boot
    env:
      DSH_GATE_PROBE_OUT: "$DSH_GATE_PROBE_OUT"
  - gate: persistence_migration
    command: node scripts/gate.mjs persistence_migration
    env:
      DSH_GATE_PROBE_OUT: "$DSH_GATE_PROBE_OUT"
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

/**
 * The fixture gate. It can append what its own process actually saw to a file, which
 * is how the environment suite proves that a verifier run is constructed rather than
 * inherited: `DSH_GATE_PROBE_OUT` reaches this process only because the frozen
 * verifier configuration declares the forward, and `DSH_CI_ISSUER` is declared too —
 * so the probe shows whether ambient authority leaked in.
 */
export const GATE_SCRIPT = `import { appendFileSync } from 'node:fs'
const out = process.env.DSH_GATE_PROBE_OUT
if (out) {
  appendFileSync(out, JSON.stringify({
    gate: process.env.DSH_GATE || null,
    candidate: process.env.DSH_CANDIDATE || null,
    issuer: process.env.DSH_CI_ISSUER ?? null,
    standard_revision: process.env.DSH_STANDARD_REVISION ?? null,
    image_digest: process.env.DSH_IMAGE_DIGEST ?? null,
    forwarded: process.env.DSH_PROBE_FORWARDED ?? null,
    dsh_keys: Object.keys(process.env).filter((key) => key.startsWith('DSH_')).sort(),
  }) + '\\n')
}
process.exit(0)
`

/** A fixture acceptance manifest listing one case per fixture obligation surface. */
export const manifestWith = (cases) => `revision: 1\ncases:\n${cases.map((entry) => `  - id: ${entry.id}\n    obligation_ids: [${entry.obligation_ids.join(', ')}]\n    outcome_ids: [${entry.outcome_ids.join(', ')}]\n    required: true\n    method: automated\n    spec_ref: ${entry.spec_ref}\n`).join('')}`

/**
 * Create a committed fixture project and freeze its standard.
 *
 * `contract`, `manifest`, `slice`, `spine` and `extra.gate` let a suite change exactly
 * one fact at a time (a Contract that requires a deployment, a Spine that already
 * holds a case, a gate that records its own environment).
 */
export function makeProject({
  freeze = true,
  contract = CONTRACT,
  manifest = MANIFEST,
  slice = SLICE,
  spine = 'revision: 1\ncase_ids: []\n',
  extra = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'da-host-verify-'))
  const write = (relative, content) => {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  write('.agent/project.yaml', 'project:\n  id: host-verification-fixture\nattempt_budget:\n  total_attempt_limit: 8\n  same_root_cause_limit: 3\n  no_progress_window: 3\n  replan_limit: 2\n')
  write('.agent/CONTRACT.yaml', contract)
  write('.agent/slices/S1.yaml', slice)
  write('tests/acceptance/spec/manifest.yaml', manifest)
  write('tests/acceptance/spec/A-HELLO-001.mjs', SPEC_ONE)
  write('tests/acceptance/spec/A-HELLO-002.mjs', SPEC_TWO)
  write('tests/acceptance/driver/index.mjs', DRIVER)
  write('tests/harness/run-acceptance.mjs', HARNESS)
  write('tests/spine/manifest.yaml', spine)
  write('ci/verifier.yaml', extra.verifier || VERIFIER)
  write('scripts/gate.mjs', extra.gate || GATE_SCRIPT)
  write('src/app.mjs', 'export const app = 1\n')
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

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/**
 * Run one subprocess. `env` is the scenario's explicit environment, never a patch on
 * the ambient one — a Host scenario cannot inherit `DSH_CI_ISSUER` from the machine.
 */
export function run(argv, cwd, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, argv, { cwd, encoding: 'utf8', env: { ...SAFE_ENV, ...env } })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }
  }
}

export function hostVerify(root, extra = [], env = {}) {
  return run([verifyScript, '--project', root, '--backend', 'host', '--write-evidence', '--slice', 'S1', '--json', ...extra], root, env)
}

export function deliveredIn(root, options = {}) {
  const cfg = loadProjectConfig(root)
  const model = loadModel(root)
  const verification = resolveVerification(cfg)
  const candidate = git(root, ['rev-parse', 'HEAD']).trim()
  return {
    verification,
    model,
    candidate,
    verdict: assessDelivery(model, {
      candidate,
      acceptedIssuers: verification.acceptedIssuers,
      verification,
      ...options,
    }),
  }
}

export function readSpine(root) {
  const text = readFileSync(join(root, 'tests', 'spine', 'manifest.yaml'), 'utf8')
  const line = /case_ids:\s*(\[[^\]]*\])/.exec(text)
  return line ? JSON.parse(line[1].replace(/'/g, '"')) : []
}

export function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}
