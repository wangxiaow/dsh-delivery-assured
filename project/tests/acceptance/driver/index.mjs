/**
 * Semantic driver for the `delivery status` acceptance specs.
 *
 * A driver connects the spec to the real system under test and returns what it
 * actually observed. It must not decide pass/fail: no `expect`, no `assert`, no
 * swallowing exceptions into success, no fabricating a denial that was never
 * requested. The implementation session may change this file; the specs are
 * frozen.
 *
 * Every returned file/process observation comes from the real CLI process or the
 * real filesystem — nothing here is simulated.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** tests/acceptance/driver → repository root */
export const PROJECT_ROOT = join(here, '..', '..', '..')
export const CLI = join(PROJECT_ROOT, 'src', 'cli.mjs')

/**
 * The shipped operation pack, beside this project rather than inside it. Both the
 * staged verification tree and a plain checkout put `packages/delivery-assured`
 * next to `project/`.
 */
const PACK_LIB = join(PROJECT_ROOT, '..', 'packages', 'delivery-assured', 'scripts', 'lib')

/**
 * The environment a fixture subprocess runs with.
 *
 * This driver starts the real CLI, so its environment decides what the observation
 * means. Inheriting `process.env` made that meaning depend on where the suite was
 * launched: inside a GitHub Actions verification job the ambient environment holds
 * `DSH_CI_ISSUER`, the deployment identity and the frozen-standard revisions, so a
 * Host-shaped scenario could silently be given trusted-CI authority. The fixture
 * therefore builds its environment from an explicit allowlist and adds only what
 * the scenario it is proving declares.
 */
const { buildBaseEnv } = await import(pathToFileURL(join(PACK_LIB, 'env.mjs')).href)

const BASE_PROJECT_YAML = `project:
  id: spec-fixture
  name: acceptance fixture
baseline_ref: refs/heads/baseline/main
baseline_remote: origin
slice_environment: production_like_container
bootstrap_environment: staging
mvp_ready_environment: staging
ci_provider: github-actions
paths:
  acceptanceManifest: .agent/fixture-manifest.yaml
  acceptanceSpec: .
  acceptanceDriver: .
  spineManifest: .agent/fixture-spine.yaml
  templateChecklists: templates/checklists
  evidenceDir: .agent/evidence
  attemptsLog: .agent/attempts.jsonl
attempt_budget:
  same_root_cause_limit: 3
  total_attempt_limit: 8
  no_progress_window: 3
  replan_limit: 2
ci:
  verify_workflow: ci/verify.yml
  promote_workflow: ci/promote.yml
  trusted_issuer: spec-trusted-verifier
`

const BASE_CONTRACT = {
  schemaVersion: '0.5',
  contractVersion: 1,
  status: 'approved',
  product: { id: 'spec-fixture', project_types: ['cli'], release_goal: 'internal demo' },
  journeys: [
    {
      id: 'J-SPEC',
      title: 'fixture journey',
      required: true,
      source_refs: ['spec:fixture'],
      outcomes: [{ id: 'J-SPEC.done', required: true, observable: 'the fixture journey completes' }],
      exceptional_outcomes: [{ id: 'J-SPEC.rejected', required: true, observable: 'illegal input is rejected' }],
    },
  ],
  capabilities: [{ id: 'C-SPEC', required: true, observable: 'the fixture capability is checkable' }],
  business_rules: [
    {
      id: 'BR-SPEC-CRITICAL',
      required: true,
      severity: 'critical',
      rule: 'fixture critical rule',
      subjects: ['subject'],
      resources: ['resource'],
      operations: ['derive_status'],
      boundaries: ['current', 'stale'],
      acceptance_requirements: {
        positive: ['spec_positive_allowed'],
        negative: ['spec_negative_denied'],
        forbidden_effects: ['spec_forbidden_effect'],
      },
    },
  ],
  implicit_obligations: [
    { checklist_id: 'CLI-INPUT', disposition: 'required', obligation_ids: ['J-SPEC'] },
    { checklist_id: 'CLI-OUTPUT', disposition: 'required', obligation_ids: ['J-SPEC.done'] },
    { checklist_id: 'CLI-EMPTY', disposition: 'required', obligation_ids: ['J-SPEC.done'] },
    { checklist_id: 'CLI-RETRY', disposition: 'required', obligation_ids: ['J-SPEC.done'] },
    { checklist_id: 'CLI-INTERRUPT', disposition: 'not_applicable', reason: 'fixture writes nothing', approval_ref: 'SPEC-DEC-1' },
    { checklist_id: 'CLI-PERMISSION', disposition: 'not_applicable', reason: 'fixture is single-user', approval_ref: 'SPEC-DEC-1' },
    { checklist_id: 'CLI-CONFIG', disposition: 'required', obligation_ids: ['C-SPEC'] },
    { checklist_id: 'CLI-DESTRUCTIVE', disposition: 'not_applicable', reason: 'fixture has no destructive operation', approval_ref: 'SPEC-DEC-1' },
    { checklist_id: 'CLI-ENV', disposition: 'required', obligation_ids: ['C-SPEC'] },
    { checklist_id: 'CLI-OBSERVABILITY', disposition: 'required', obligation_ids: ['BR-SPEC-CRITICAL'] },
  ],
  unknowns: [],
  approved_assumptions: [],
  out_of_scope: [{ item: 'none', reason: 'fixture', approval_ref: 'SPEC-DEC-1' }],
  deployment: {
    slice_environment: 'production_like_container',
    bootstrap_environment: 'staging',
    mvp_ready_environment: 'staging',
    release_target: 'internal demo',
    environment_sensitive_paths: ['ci/verifier.yaml'],
    release_prerequisites: ['fixture prerequisite'],
    operational_acceptance_ids: ['A-SPEC-STATUS-JSON'],
  },
  acceptance: {
    manifest_ref: 'tests/acceptance/spec/manifest.yaml',
    protected_revision: 'spec-fixture-revision',
    manual_reviews: [],
  },
  approval: {
    status: 'approved',
    unknowns_decision_ref: 'SPEC-DEC-1',
    acceptance_summary_ref: 'SPEC-DEC-1',
  },
}

/** Emit the fixture contract as block-style YAML the operation pack can read. */
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    const lines = []
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item)
        if (entries.length === 0) {
          lines.push(`${pad}- {}`)
          continue
        }
        const [firstKey, firstValue] = entries[0]
        lines.push(emitEntry(`${pad}- `, firstKey, firstValue, indent + 2))
        // A sequence row starts a fresh mapping: the remaining keys are indented
        // past the dash rather than emitted beside it.
        for (const [key, child] of entries.slice(1)) {
          lines.push(emitEntry(`${pad}  `, key, child, indent + 4))
        }
        continue
      }
      if (Array.isArray(item)) {
        lines.push(`${pad}-`)
        lines.push(toYaml(item, indent + 2))
        continue
      }
      lines.push(`${pad}- ${scalar(item)}`)
    }
    return lines.join('\n')
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return `${pad}{}`
    return entries.map(([key, child]) => emitEntry(pad, key, child, indent + 2)).join('\n')
  }
  return `${pad}${scalar(value)}`
}

/**
 * One `key: value` line. A non-empty container becomes a block on the following
 * lines; an empty one is emitted inline, because `[]` and `{}` are flow scalars
 * and would otherwise be re-read as the text of a mapping entry.
 */
function emitEntry(pad, key, value, childIndent) {
  if (hasBlockBody(value)) return `${pad}${key}:\n${toYaml(value, childIndent)}`
  return `${pad}${key}: ${scalar(value)}`
}

function hasBlockBody(value) {
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0
  return false
}

function scalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = String(value)
  if (text === '' || /[:#\-?,[\]{}&*!|>'"%@`]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return text
}

/**
 * Create an isolated fixture repository in a temp directory. Returns the paths
 * and the raw contract object so a spec can mutate one decision at a time.
 */
export function makeWorkspace({ contract = {}, omitContract = false, state = null, evidence = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dapse-spec-'))
  mkdirSync(join(dir, '.agent'), { recursive: true })
  mkdirSync(join(dir, '.agent', 'slices'), { recursive: true })
  mkdirSync(join(dir, 'templates', 'checklists'), { recursive: true })
  mkdirSync(join(dir, '.agent', 'evidence'), { recursive: true })
  writeFileSync(join(dir, '.agent', 'project.yaml'), BASE_PROJECT_YAML, 'utf8')
  const merged = omitContract ? null : deepMerge(structuredClone(BASE_CONTRACT), contract)
  if (merged) {
    writeFileSync(join(dir, '.agent', 'CONTRACT.yaml'), `${toYaml(merged)}\n`, 'utf8')
    writeFileSync(join(dir, '.agent', 'slices', 'S1.yaml'), `${toYaml(buildFixtureSlice(merged))}\n`, 'utf8')
    writeFileSync(join(dir, '.agent', 'fixture-manifest.yaml'), `${toYaml(buildFixtureManifest())}\n`, 'utf8')
    writeFileSync(join(dir, '.agent', 'fixture-spine.yaml'), 'last_updated: null\nupdated_by: null\ncase_ids: []\n', 'utf8')
  }
  if (state) writeFileSync(join(dir, '.agent', 'STATE.yaml'), `${toYaml(state)}\n`, 'utf8')
  for (const record of evidence) {
    writeFileSync(join(dir, '.agent', 'evidence', `${record.evidence_id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }
  return { dir, contract: merged }
}

/**
 * The fixture acceptance manifest: four frozen cases, one per fixture obligation
 * surface, including the negative case a Critical rule must derive.
 */
function buildFixtureManifest() {
  return {
    revision: 1,
    protected_revision: 'spec-fixture-revision',
    cases: [
      {
        id: 'A-SPEC-STATUS-JSON',
        obligation_ids: ['J-SPEC', 'J-SPEC.done', 'C-SPEC'],
        outcome_ids: ['J-SPEC.done'],
        required: true,
        method: 'automated',
        assertions: ['status_from_contract_and_ci'],
        critical_scenarios: ['status_from_contract_and_ci'],
        spec_ref: '.agent/fixture-manifest.yaml',
      },
      {
        id: 'A-SPEC-STALE',
        obligation_ids: ['J-SPEC.done'],
        outcome_ids: ['J-SPEC.done'],
        required: true,
        method: 'automated',
        assertions: ['stale_evidence_not_verified'],
        critical_scenarios: ['stale_evidence_not_verified'],
        spec_ref: '.agent/fixture-manifest.yaml',
      },
      {
        id: 'A-SPEC-INPUT-REJECTED',
        obligation_ids: ['J-SPEC.rejected', 'C-SPEC'],
        outcome_ids: ['J-SPEC.rejected'],
        required: true,
        method: 'automated',
        assertions: ['no_silent_pass'],
        critical_scenarios: ['no_silent_pass'],
        spec_ref: '.agent/fixture-manifest.yaml',
      },
      {
        id: 'A-SPEC-CRITICAL-NOT-LOCAL',
        obligation_ids: ['BR-SPEC-CRITICAL'],
        outcome_ids: ['J-SPEC.done'],
        required: true,
        method: 'automated',
        assertions: ['spec_positive_allowed', 'spec_negative_denied', 'spec_forbidden_effect'],
        critical_scenarios: ['spec_positive_allowed', 'spec_negative_denied', 'spec_forbidden_effect'],
        spec_ref: '.agent/fixture-manifest.yaml',
      },
    ],
  }
}

/**
 * The fixture Slice claims every fixture obligation and its acceptance cases, so
 * coverage reports a real planning gap rather than an unmapped obligation.
 */
function buildFixtureSlice(contract) {
  const obligations = []
  for (const journey of contract.journeys || []) {
    obligations.push(journey.id)
    for (const outcome of [...(journey.outcomes || []), ...(journey.exceptional_outcomes || [])]) {
      obligations.push(outcome.id)
    }
  }
  for (const capability of contract.capabilities || []) obligations.push(capability.id)
  for (const rule of contract.business_rules || []) obligations.push(rule.id)
  return {
    id: 'S1',
    title: 'fixture slice',
    status: 'LOCAL_VERIFY',
    obligations,
    acceptance: ['A-SPEC-STATUS-JSON', 'A-SPEC-STALE', 'A-SPEC-INPUT-REJECTED', 'A-SPEC-CRITICAL-NOT-LOCAL'],
    depends_on: [],
    baseline: 'Baseline #0',
    preserve: ['fixture behaviour stays observable'],
    attempt_budget: {
      same_root_cause_limit: 3,
      total_attempt_limit: 8,
      no_progress_window: 3,
      replan_limit: 2,
    },
    migration_steps: [],
    external_side_effects: [],
  }
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}

/**
 * Run one CLI invocation and return the real process observation.
 *
 * `env` is the scenario's explicit environment, never a patch on the ambient one:
 * a Host scenario omits the CI authority variables by construction rather than
 * deleting them one by one from an inherited environment.
 */
export function runDeliveryRaw(args, { cwd = PROJECT_ROOT, env = {}, scenario = null } = {}) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...buildBaseEnv(), ...(scenario || {}), ...env },
    encoding: 'utf8',
  })
  return {
    args: [...args],
    exit_code: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawn_error: result.error ? String(result.error.message) : null,
    duration_ms: Date.now() - started,
  }
}

/** Run `delivery status` and return both the process result and parsed JSON. */
export async function status(workspace, extraArgs = [], options = {}) {
  const result = runDeliveryRaw(['status', '--project', workspace.dir, ...extraArgs], options)
  let json = null
  let json_error = null
  if (extraArgs.includes('--json')) {
    try {
      json = JSON.parse(result.stdout)
    } catch (error) {
      json_error = String(error.message)
    }
  }
  return { ...result, json, json_error }
}

/** Parse the human table into rows so a spec can reason about it. */
export function parseStatusTable(stdout) {
  const rows = []
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z][A-Z0-9-]*(?:\.[A-Za-z0-9_-]+)?)\s+(journey|outcome|capability|rule)\s+(\S+)\s+(.*)$/.exec(line.trim())
    if (match) rows.push({ id: match[1], kind: match[2], status: match[3], reason: match[4] })
  }
  return rows
}

/** Recursive snapshot of every file (path, size, mtime) under a directory. */
export function snapshotTree(dir, { ignore = ['.git'] } = {}) {
  const out = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignore.includes(entry.name)) continue
      const full = join(current, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, name)
      else {
        const stat = statSync(full)
        out.push({ path: name, size: stat.size, mtime_ms: Math.floor(stat.mtimeMs) })
      }
    }
  }
  walk(dir, '')
  return out
}

/** Read one file's text, or null when it does not exist. */
export function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function cleanup(workspace) {
  try {
    rmSync(workspace.dir, { recursive: true, force: true })
  } catch {
    // A leftover temp directory must not turn into a fake failure.
  }
}

/** Names of git refs the working tree currently knows about. */
export function gitRefs(dir) {
  const result = spawnSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/* ------------------------------------------- automatic completion observation */

/**
 * The shipped delivery toolchain, as it exists in the staged verification tree:
 * protected packages, protected CI tools and the DSH plugin. The specs observe
 * their *decisions*; nothing here decides pass/fail for them.
 */
const STAGED_ROOT = join(PROJECT_ROOT, '..')
const CI_TOOLS = join(STAGED_ROOT, 'ci', 'tools')
const PLUGIN_LIB = join(STAGED_ROOT, 'plugins', 'dsh-delivery-assured', 'lib')

const loadModule = async (path) => import(pathToFileURL(path).href)

/** What the frozen Contract's completion policy resolves to, and which gaps it has. */
export async function completionPolicyObservation(contract, { model = null, phase = 'contract' } = {}) {
  const completion = await loadModule(join(PACK_LIB, 'completion.mjs'))
  const resolved = completion.resolveCompletionPolicy(contract)
  if (!model) return { resolved, issues: [] }
  const issues = []
  completion.checkCompletionPolicy(model, issues, { phase })
  return { resolved, issues }
}

/** What the shipped automatic finalizer decides for one exact execution record. */
export async function autoFinalizationObservation({ model, record, receipt, options }) {
  const { finalizeAutoMvp } = await loadModule(join(CI_TOOLS, 'ci-auto-mvp.mjs'))
  const before = JSON.stringify({ model, record, receipt, options })
  const result = finalizeAutoMvp(model, record, receipt, options)
  return {
    ready: result.ready === true,
    blocking: result.blocking || [],
    completion_mode: result.completion_mode ?? null,
    automated_reviews: result.automated_reviews || [],
    limitations: result.limitations || [],
    inputs_unchanged: JSON.stringify({ model, record, receipt, options }) === before,
  }
}

/** What the platform-derived release observations would be, for an injected transport. */
export async function releaseObservationOutcome({ model, fetchImpl, repository = 'owner/repo', candidate = 'a'.repeat(40) }) {
  const { observeReleasePrerequisites } = await loadModule(join(CI_TOOLS, 'ci-release-observer.mjs'))
  const receipt = await observeReleasePrerequisites(model, { repository, candidate, token: 'spec-read-token', reference: 'spec:observation', fetchImpl })
  return { result: receipt.result, prerequisites: receipt.prerequisites, confirmation_ref: receipt.confirmation_ref }
}

/**
 * Durable iteration journal observed across a restart: events are appended, the
 * directory is re-read from disk, and one invalid event is offered to the writer.
 */
export async function iterationObservation({ events = [], invalidEvent = null } = {}) {
  const iterations = await loadModule(join(PLUGIN_LIB, 'iterations.js'))
  const dir = mkdtempSync(join(tmpdir(), 'spec-iterations-'))
  let invalid_refused = false
  try {
    for (const event of events) iterations.appendIteration(dir, event)
    if (invalidEvent) {
      try {
        iterations.appendIteration(dir, invalidEvent)
      } catch {
        invalid_refused = true
      }
    }
    // A fresh read is the restart: nothing is carried in memory.
    const loaded = iterations.loadIterations(dir)
    const reduced = iterations.reduceIterations(loaded.events)
    return {
      dir,
      iterations: reduced.iterations,
      current: reduced.current,
      blocked: reduced.blocked,
      closed: reduced.closed,
      unreadable_lines: loaded.problems.length,
      invalid_refused,
      summary: iterations.summarizeRecovery({ iterations: reduced, problems: loaded.problems }),
      bytes: readIfExists(join(dir, '.agent', 'ITERATIONS.jsonl')),
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a leftover temp directory is not a product failure
    }
  }
}

export { cpSync }
