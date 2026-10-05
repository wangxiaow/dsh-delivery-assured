#!/usr/bin/env node
/**
 * One authoritative state view for every entry that must agree.
 *
 * `resume`, `attempts`, `coverage`, `delivery status`, the session kernel and the CI
 * promotion job read one history. When each of them chose its own source, two readers of
 * the same project reported different budgets — 7 counted attempts with 1 left versus 4
 * counted with `history_known: false` and an invented "comparison rebase is missing
 * approval" blocker — and the promotion job's numbers were only right because CI happens to
 * overlay the state ref onto its checkout first.
 *
 * This suite pins the shared loader/calculator on a real (local, network-free) Git
 * rehearsal: the same synthetic history read through the durable ref and through an
 * overlaid working tree must produce byte-identical budget signatures; a checkout that
 * does *not* carry the state must be visibly different, which is why every session entry
 * must name the ref as its source.
 *
 * Exit codes: 0 all checks passed, 1 check failed, 2 input/tool error.
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATE_SOURCE, budgetSignature, openStateView, stateAuthority } from '../scripts/lib/state-view.mjs'

const packRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packRoot, '..', '..')
const realProject = join(repoRoot, 'project')

let checks = 0
let failures = 0
function check(condition, message) {
  checks += 1
  if (!condition) {
    failures += 1
    process.stderr.write(`FAIL ${message}\n`)
  }
}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function write(root, relative, content) {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/**
 * A synthetic attempt history: three failures on one root cause and one Replan. No
 * Evidence backs it, so the budget comes from the ledger alone — which is exactly what the
 * two sources must read identically.
 */
const CASES = ['A-CLI-STATUS-JSON', 'A-CLI-INPUT-REJECTED']
const at = (day) => `2026-01-0${day}T00:00:00.000Z`
function ledger() {
  const failed = (n) => ({
    attempt_id: `S1-A${n}`, slice_id: 'S1', slice_key: 'S1', at: at(n),
    root_cause_key: 'fixture-same-root', hypothesis: `fixture attempt ${n}`,
    result: 'failed', standard_digest: 'a'.repeat(64),
    required_passed: 1, required_total: CASES.length, spine_failures: 0,
    critical_violations: [], required_case_ids: [...CASES], note: '',
  })
  return [
    failed(1), failed(2), failed(3),
    {
      attempt_id: 'S1-R1', slice_id: 'S1', slice_key: 'S1', at: at(4),
      hypothesis: 'Replan: the retry assumption was falsified',
      result: 'blocked',
      replan: {
        slice_id: 'S1', falsified_assumption: 'one more retry would pass',
        previous_approach: 'retry', new_approach: 'change the comparison identity',
        next_discriminating_checks: ['A-CLI-STATUS-JSON'],
        preserved_obligations: ['J-DELIVERY-STATUS'],
        evidence_refs: [], scope_changed: false,
      },
    },
  ]
}

const LEDGER = `${ledger().map((entry) => JSON.stringify(entry)).join('\n')}\n`
const SPINE = 'last_updated: 2026-01-04T00:00:00.000Z\nupdated_by: fixture\ncase_ids: ["A-CLI-STATUS-JSON"]\n'

/** A repository whose candidate material is committed and whose state is not. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'state-view-'))
  const root = join(base, 'repo')
  const bare = join(base, 'origin.git')
  mkdirSync(root)
  mkdirSync(bare)
  git(bare, ['init', '--quiet', '--bare'])
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(root, ['init', '--quiet', '-b', 'main'])
  git(root, ['config', 'user.name', 'Fixture'])
  git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['remote', 'add', 'origin', bare])

  // The real Contract and frozen acceptance material, so the fixture is a real project.
  for (const relative of ['.agent/CONTRACT.yaml', '.agent/project.yaml', '.agent/STATE.yaml']) {
    write(root, join('project', relative), readFileSync(join(realProject, relative), 'utf8'))
  }
  cpSync(join(realProject, '.agent', 'slices'), join(root, 'project', '.agent', 'slices'), { recursive: true })
  cpSync(join(realProject, 'tests', 'acceptance', 'spec'), join(root, 'project', 'tests', 'acceptance', 'spec'), { recursive: true })
  mkdirSync(join(root, 'project', 'ci'), { recursive: true })
  copyFileSync(join(realProject, 'ci', 'verifier.yaml'), join(root, 'project', 'ci', 'verifier.yaml'))
  // `templateChecklists: ../packages/…` is relative to the project root.
  cpSync(join(packRoot, 'templates'), join(root, 'packages', 'delivery-assured', 'templates'), { recursive: true })

  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'candidate material'])
  git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])

  // State that is deliberately NOT committed: durable state travels on its own ref.
  write(root, 'project/.agent/attempts.jsonl', LEDGER)
  write(root, 'project/tests/spine/manifest.yaml', SPINE)
  return { base, root, bare }
}

/** Publish the state the way the recorder does: a parentless tree of state scopes only. */
function publishStateRef(root, base, files) {
  const index = join(base, `state-index-${String(Math.random()).slice(2)}`)
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'State', GIT_AUTHOR_EMAIL: 'state@example.invalid',
    GIT_COMMITTER_NAME: 'State', GIT_COMMITTER_EMAIL: 'state@example.invalid',
  }
  const plumbing = (args, input) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, input }).trim()
  plumbing(['read-tree', '--empty'])
  for (const [path, content] of Object.entries(files)) {
    const blob = plumbing(['hash-object', '-w', '--stdin'], content)
    plumbing(['update-index', '--add', '--cacheinfo', '100644', blob, path])
  }
  const commit = plumbing(['commit-tree', plumbing(['write-tree']), '-m', 'state'])
  git(root, ['update-ref', 'refs/heads/delivery-state/main', commit])
  git(root, ['push', '--quiet', '--force', 'origin', 'refs/heads/delivery-state/main:refs/heads/delivery-state/main'])
  rmSync(index, { force: true })
  return commit
}

/** Run one operation-pack script and parse its JSON report even on a blocking exit code. */
function runScriptJson(script, args, cwd, options = {}) {
  const result = spawnSync(process.execPath, [join(packRoot, 'scripts', script), ...args], { cwd, encoding: 'utf8', ...options })
  const start = String(result.stdout || '').indexOf('{')
  return { exit: result.status, json: start >= 0 ? JSON.parse(String(result.stdout).slice(start)) : null, stderr: String(result.stderr || '') }
}

const CANDIDATE = 'b'.repeat(40)
const budgetOf = (view) => view.budget({ candidate: CANDIDATE, parentBaseline: null })

/** A fresh checkout of main carries the candidate but none of the uncommitted state. */
function cleanCheckout(base, bare) {
  const dir = join(base, 'clean')
  execFileSync('git', ['clone', '--quiet', bare, dir], { encoding: 'utf8' })
  git(dir, ['config', 'user.name', 'Fixture'])
  git(dir, ['config', 'user.email', 'fixture@example.invalid'])
  return dir
}

/* ------------------------------------------------------------------ the checks */

const { base, root, bare } = fixture()
const project = join(root, 'project')
try {
  check(!existsSync(join(project, '.agent', 'attempts.jsonl')) === false, 'the fixture worktree carries the uncommitted ledger (CI-overlay shape)')
  const sha = publishStateRef(root, base, {
    'project/.agent/attempts.jsonl': LEDGER,
    'project/tests/spine/manifest.yaml': SPINE,
  })

  // 1. Both legal sources produce the same budget for the same history.
  const worktreeView = openStateView(project, { source: STATE_SOURCE.WORKTREE })
  const refView = openStateView(project, { source: STATE_SOURCE.DURABLE_REF, repoRoot: project, fallbackRoot: project })
  check(refView.durable.available === true, `the durable ref is readable: ${refView.durable.reason}`)
  check(refView.durable.sha === sha, 'the ref view reads the published state revision')
  check(refView.authority.kind === 'durable-ref' && refView.authority.authoritative === true, `a complete ref read is authoritative: ${JSON.stringify(refView.authority)}`)
  check(refView.durable.filled.length === 0, `the fixture ref carries every scope it needs: ${JSON.stringify(refView.durable.filled)}`)
  check(worktreeView.authority.kind === 'worktree' && worktreeView.authority.degraded === false, `choosing the worktree is not degradation: ${JSON.stringify(worktreeView.authority)}`)
  const worktreeBudget = budgetOf(worktreeView)
  const refBudget = budgetOf(refView)
  check(worktreeBudget.counted === 3 && worktreeBudget.replans === 1, `the fixture history is counted: ${worktreeBudget.counted} attempts, ${worktreeBudget.replans} replans`)
  check(worktreeBudget.history_known === true, 'the fixture history is complete')
  check(budgetSignature(worktreeBudget) === budgetSignature(refBudget), `the two sources disagree on one history:\n  worktree ${budgetSignature(worktreeBudget)}\n  ref      ${budgetSignature(refBudget)}`)

  // 2. A checkout without the state is exactly the divergence the shared source prevents:
  // the same history, a different answer — and only the ref-reading entry is right.
  const clean = cleanCheckout(base, bare)
  const cleanProject = join(clean, 'project')
  check(!existsSync(join(cleanProject, '.agent', 'attempts.jsonl')), 'the clean checkout carries no working-tree ledger')
  const cleanWorktree = openStateView(cleanProject, { source: STATE_SOURCE.WORKTREE })
  const cleanRef = openStateView(cleanProject, { source: STATE_SOURCE.DURABLE_REF, repoRoot: cleanProject, fallbackRoot: cleanProject })
  const cleanWorktreeBudget = budgetOf(cleanWorktree)
  const cleanRefBudget = budgetOf(cleanRef)
  check(cleanWorktreeBudget.counted === 0 && cleanWorktreeBudget.history_known === false, `a working-tree-only reader must not invent history: ${JSON.stringify({ counted: cleanWorktreeBudget.counted, history_known: cleanWorktreeBudget.history_known })}`)
  check(budgetSignature(cleanRefBudget) === budgetSignature(refBudget), 'the ref source reports the same history from a clean checkout')
  check(budgetSignature(cleanWorktreeBudget) !== budgetSignature(cleanRefBudget), 'the two sources are genuinely different, so the check above is not vacuous')

  // 3. The scripts agree with the shared view, each through the authoritative source.
  const resumeRef = runScriptJson('resume.mjs', ['--project', cleanProject, '--durable-state', '--json'], repoRoot)
  check(resumeRef.json !== null, `resume --durable-state printed no report: ${resumeRef.stderr.slice(0, 300)}`)
  check(budgetSignature(resumeRef.json.budget) === budgetSignature(cleanRefBudget), 'resume --durable-state agrees with the shared view')
  check(resumeRef.json.durable_state?.sha === sha, 'resume reports the state revision it read')
  // The report names the channel that answered and the ones that were not tried, so a
  // session can tell an authoritative read from a lucky one.
  check(resumeRef.json.state_authority === 'durable-ref' && resumeRef.json.state_authoritative === true, `a readable ref is authoritative: ${JSON.stringify({ kind: resumeRef.json.state_authority, authoritative: resumeRef.json.state_authoritative })}`)
  check(resumeRef.json.durable_state?.transport === 'git', `the local fixture is read over git: ${resumeRef.json.durable_state?.transport}`)
  check(
    Array.isArray(resumeRef.json.durable_state?.attempted) && resumeRef.json.durable_state.attempted.some((a) => a.transport === 'gh' && a.ok === false && /not attempted/.test(a.reason)),
    `the report says why gh was not used: ${JSON.stringify(resumeRef.json.durable_state?.attempted)}`,
  )

  const resumeTree = runScriptJson('resume.mjs', ['--project', cleanProject, '--offline', '--json'], repoRoot)
  check(budgetSignature(resumeTree.json.budget) === budgetSignature(cleanWorktreeBudget), 'resume --offline agrees with the working-tree view (and differs from the ref)')
  check(resumeTree.json.state_authority === 'worktree' && resumeTree.json.state_degraded === false, 'choosing the working tree is reported as a choice, not as degradation')

  // 3b. An authoritative read that cannot happen must fail, not answer from the working
  // tree: with no `gh` and no `git` reachable, `--durable-state --state-transport gh` is a
  // failed recovery whose numbers are explicitly labelled working-tree facts.
  const noPath = mkdtempSync(join(tmpdir(), 'no-tools-'))
  const blocked = runScriptJson(
    'resume.mjs',
    ['--project', cleanProject, '--durable-state', '--state-transport', 'gh', '--json'],
    repoRoot,
    { env: { ...process.env, PATH: noPath, DSH_DELIVERY_GH: '' } },
  )
  check(blocked.exit === 1, `an unreadable authoritative state blocks: exit ${blocked.exit}`)
  check(blocked.json !== null, `the blocked report is still machine readable: ${blocked.stderr.slice(0, 200)}`)
  check(blocked.json?.durable_state?.available === false, `the ref was not read: ${JSON.stringify(blocked.json?.durable_state)}`)
  check(blocked.json?.state_authoritative === false && blocked.json?.state_degraded === true, `the report is marked degraded: ${JSON.stringify({ a: blocked.json?.state_authoritative, d: blocked.json?.state_degraded })}`)
  check(
    (blocked.json?.blockers || []).some((b) => /working-tree facts, not a recovery result/.test(b)),
    `the blocker says the numbers are not a recovery result: ${JSON.stringify(blocked.json?.blockers)}`,
  )
  check(
    typeof blocked.json?.state_degraded_reason === 'string' && blocked.json.state_degraded_reason.length > 0,
    `the degraded report carries the reason it could not read: ${JSON.stringify(blocked.json?.state_degraded_reason)}`,
  )
  check(
    blocked.json?.durable_state?.transport === null && (blocked.json?.durable_state?.attempted || []).length === 1,
    `only the requested channel was tried: ${JSON.stringify(blocked.json?.durable_state?.attempted)}`,
  )
  rmSync(noPath, { recursive: true, force: true })

  const attemptsRef = runScriptJson('attempts.mjs', ['--project', cleanProject, '--durable-state', '--json'], repoRoot)
  check(attemptsRef.json !== null, `attempts --durable-state printed no report: ${attemptsRef.stderr.slice(0, 300)}`)
  check(budgetSignature(attemptsRef.json) === budgetSignature(cleanRefBudget), 'attempts --durable-state agrees with the shared view')

  const coverageRef = runScriptJson('coverage.mjs', ['--project', cleanProject, '--view', 'mvp', '--durable-state', '--json'], repoRoot)
  check(coverageRef.json !== null, `coverage --durable-state printed no report: ${coverageRef.stderr.slice(0, 300)}`)
  check(coverageRef.json.durable_state?.sha === sha, 'coverage reads the same state revision')

  // A write must not be gated by state it cannot write.
  const refused = runScriptJson('attempts.mjs', ['--project', cleanProject, '--durable-state', '--record', '--slice', 'S1', '--hypothesis', 'x', '--result', 'failed'], repoRoot)
  check(refused.exit === 2 && /cannot be combined/.test(refused.stderr), `a read-only state report must not gate a write: exit ${refused.exit} ${refused.stderr.slice(0, 200)}`)

  // "The platform does not hold this ref" is not "the ref could not be read". A project
  // completed by the host-executed verifier has no durable-state ref at all, and reporting
  // that as a degraded read would blame the transport for state the platform never held —
  // while a project that needs the ref must still fail closed.
  const noRef = { available: false, notFound: true, reason: 'gh: Not Found (HTTP 404)', attempted: [{ transport: 'gh', ok: false, reason: 'Not Found (HTTP 404)' }] }
  const allowed = stateAuthority({ source: STATE_SOURCE.DURABLE_REF, durable: noRef, allowMissingRef: true })
  check(allowed.kind === 'worktree-no-durable-state-ref', `a missing ref is reported as such: ${allowed.kind}`)
  check(allowed.degraded === false && allowed.authoritative === false, `a missing ref is not a failed read: ${JSON.stringify(allowed)}`)
  const required = stateAuthority({ source: STATE_SOURCE.DURABLE_REF, durable: noRef, allowMissingRef: false })
  check(required.kind === 'worktree-fallback' && required.degraded === true, `a project that requires the ref still fails closed: ${JSON.stringify(required)}`)
  const unreadable = stateAuthority({ source: STATE_SOURCE.DURABLE_REF, durable: { ...noRef, notFound: false }, allowMissingRef: true })
  check(unreadable.kind === 'worktree-fallback' && unreadable.degraded === true, 'an unreadable ref is degraded even for a host-default project')

  refView.dispose()
  worktreeView.dispose()
  cleanRef.dispose()
  cleanWorktree.dispose()
  check(!existsSync(refView.durable.root ?? '/nonexistent'), 'dispose removes the private state directory')
} finally {
  rmSync(base, { recursive: true, force: true })
}

process.stdout.write(`${checks - failures}/${checks} checks passed\n`)
process.exit(failures > 0 ? 1 : 0)
