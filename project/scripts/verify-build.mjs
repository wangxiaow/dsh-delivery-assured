#!/usr/bin/env node
/**
 * Gate 1 — Build.
 *
 * "Production build" for this CLI means: the declared Node engine is satisfied,
 * every shipped source module parses, the CLI is loadable, and no npm runtime
 * dependency was introduced (the operation pack must stay dependency-free).
 * Exit codes follow the pack convention: 0 pass, 1 failed check, 2 input error.
 */

import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** The shipped operation pack and the plugin sit beside this project, not inside it. */
const repoRoot = resolve(root, '..')
const packRoot = join(repoRoot, 'packages', 'delivery-assured')
const failures = []
const notes = []

/**
 * One failing suite's diagnostic, sized so the CI log is enough to act on.
 *
 * A short tail hid the real assertion once: the run reported only "diff: 'simple'",
 * and the failure had to be reproduced locally. Keep the head of the error (where the
 * assertion message is) plus the last lines, and cap it so one noisy suite cannot
 * bury the others.
 */
function failureDetail(result, { head = 6, tail = 4, maxChars = 1800 } = {}) {
  const lines = `${result.stderr || ''}${result.stdout || ''}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
  const interesting = lines.filter((line) => /AssertionError|Error|FAIL|expected|actual|at file:/.test(line))
  const picked = [...new Set([...interesting.slice(0, head), ...lines.slice(-tail)])]
  const text = picked.join(' / ')
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

const pkgPath = join(root, 'package.json')
if (!existsSync(pkgPath)) {
  process.stderr.write('verify-build: package.json is missing at the repository root\n')
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const engine = String(pkg.engines?.node || '')
const major = Number(process.versions.node.split('.')[0])
const required = Number((/(\d+)/.exec(engine) || [])[1] || 0)
if (required && major < required) {
  failures.push(`Node ${process.versions.node} does not satisfy engines.node ${engine}`)
}
const runtimeDeps = Object.keys(pkg.dependencies || {})
if (runtimeDeps.length > 0) {
  failures.push(`the operation pack must ship without runtime dependencies, found: ${runtimeDeps.join(', ')}`)
}

// The YAML subset reader decides every fact the pack reports, so its regression
// suite is part of the build gate rather than an optional extra.
const yamlTests = spawnSync(process.execPath, [join(packRoot, 'tests', 'yaml.test.mjs')], {
  cwd: root,
  encoding: 'utf8',
})
if (yamlTests.status !== 0) {
  failures.push(`yaml.test.mjs failed: ${failureDetail(yamlTests)}`)
}

// The DSH plugin ships in the same repository, so its own suites run here too: the
// smoke test needs no DSH packages, while the skill-registry contract test needs the
// DSH side.
//
// Two limits are reported explicitly instead of being turned into failures or silent
// skips, because a bare copy of the pack must still build:
//   - the plugin directory may not travel with the pack into a foreign checkout;
//   - the DSH-side packages may not exist on the machine running the gate.
// Either way a reader can tell "passed" from "could not run here".
const pluginRoot = join(repoRoot, 'plugins', 'dsh-delivery-assured')
const pluginTests = [
  { label: 'plugin smoke', file: join(pluginRoot, 'test', 'smoke.mjs'), requires: 'none' },
  // The bootstrap lifecycle is what makes a genuinely new project deliverable: an ordered,
  // scoped window instead of "no Contract, so the guard is off". Its regression values are
  // the ones a real greenfield session produced, so it runs without the host.
  { label: 'plugin bootstrap lifecycle', file: join(pluginRoot, 'test', 'bootstrap-lifecycle.test.mjs'), requires: 'none' },
  { label: 'plugin skill-registry contract', file: join(pluginRoot, 'test', 'skill-registry.test.mjs'), requires: 'dsh-packages' },
  // This is the only suite that can catch "the plugin no longer loads". The other two
  // use their own tool builder and shell double, so they once passed while the plugin
  // was in fact unloadable. It needs a real runtime — the desktop payload counts.
  { label: 'plugin runtime contract', file: join(pluginRoot, 'test', 'compatibility.test.mjs'), requires: 'dsh-runtime' },
  // v0.3 §4.3: the seven controls must be verified against the locked host before
  // "plugin-first" is believed. This suite reports which hold and which do not.
  { label: 'host trust boundary (§4.3)', file: join(pluginRoot, 'test', 'trust-boundary.test.mjs'), requires: 'dsh-runtime' },
  // A tool definition compiled by a foreign DSH line fails the model request with an
  // invalid function schema, so the runtime the plugin compiles against is a contract.
  { label: 'host helper resolution', file: join(pluginRoot, 'test', 'host-resolution.test.mjs'), requires: 'dsh-runtime' },
  { label: 'One-command install', file: join(repoRoot, 'tools', 'install-plugin.test.mjs'), requires: 'none' },
  { label: 'plugin automation interfaces', file: join(pluginRoot, 'test', 'automation.test.mjs'), requires: 'none' },
  // The parameter schemas DSH projects to the provider cannot be checked by a suite
  // that needs a hosting runtime, and this is the surface where an escape hatch from
  // the delivery verdict would appear: audit it as data, on every build.
  { label: 'Agent-facing tool surface', file: join(pluginRoot, 'test', 'agent-surface.test.mjs'), requires: 'none' },
  // Automatic completion is a delivery rule, so its regressions run in the build gate:
  // the finalizer, the platform release observations and the MVP receipt must all be
  // executed before a Candidate is ever called verified.
  { label: 'Automatic completion finalization', file: join(repoRoot, 'tools', 'auto-finalize.test.mjs'), requires: 'none' },
  { label: 'Release prerequisite observation', file: join(repoRoot, 'tools', 'release-observer.test.mjs'), requires: 'none' },
  { label: 'Owner-receipt finalization', file: join(repoRoot, 'tools', 'mvp-finalize.test.mjs'), requires: 'none' },
  // The workflows cannot run without a remote, so a wrong `node <path>` inside them
  // would otherwise stay invisible until the first push. This check runs here.
  { label: 'CI preflight', file: join(repoRoot, 'tools', 'ci-preflight.test.mjs'), requires: 'none' },
  { label: 'CI history gaps', file: join(repoRoot, 'tools', 'ci-history.test.mjs'), requires: 'none' },
  { label: 'CI counted-failure resolutions', file: join(repoRoot, 'tools', 'ci-resolution.test.mjs'), requires: 'none' },
  { label: 'CI reconciliation planner', file: join(repoRoot, 'tools', 'ci-reconcile.test.mjs'), requires: 'none' },
  { label: 'CI reconciliation wiring', file: join(repoRoot, 'tools', 'ci-reconcile-run.test.mjs'), requires: 'none' },
  { label: 'CI full control-state snapshot', file: join(repoRoot, 'tools', 'ci-state-snapshot.test.mjs'), requires: 'none' },
  { label: 'CI isolation request refusals', file: join(repoRoot, 'tools', 'ci-isolation.test.mjs'), requires: 'none' },
  { label: 'Deployment identity producer', file: join(repoRoot, 'tools', 'deploy-probe.test.mjs'), requires: 'none' },
  { label: 'Installed checklist paths', file: join(repoRoot, 'tools', 'checklist-path.test.mjs'), requires: 'none' },
  { label: 'CI bootstrap seed graph', file: join(repoRoot, 'tools', 'ci-bootstrap-seed.test.mjs'), requires: 'none' },
  // These two ran nowhere for a while: both are green, both stage cleanly (they read
  // only `ci/`, `project/`, `packages/`, `plugins/`, `tools/` and `.github/`, which
  // ci-stage copies), and both guard a rule nothing else asserts — the promotion
  // trust target and the staging/provenance wiring of the two workflows.
  { label: 'CI promotion trust target', file: join(repoRoot, 'tools', 'ci-trust.test.mjs'), requires: 'none' },
  { label: 'Trusted-CI staging and provenance', file: join(repoRoot, 'tools', 'trusted-ci.test.mjs'), requires: 'none' },
]
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const dshPackagesPresent = existsSync(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-skill'))
// The desktop keeps its packages inside `app.asar`, readable only through the
// Electron binary, so the installation itself is what makes the runtime reachable.
const desktopRuntimePresent = existsSync('D:/Program Files/DeepSeek Harness/DeepSeek Harness.exe')
const dshRuntimePresent = dshPackagesPresent || desktopRuntimePresent
/**
 * Report a suite that did NOT run. A plain note is invisible in a green CI run,
 * so under GitHub Actions every skip also becomes a `::warning` annotation on the
 * run summary: "CI green" must never read as "every gate ran".
 */
function noteSkipped(message) {
  notes.push(`suite skipped: ${message}`)
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::warning ::suite skipped (not run): ${message}\n`)
  }
}

const skippedSuites = []
if (!existsSync(pluginRoot)) {
  noteSkipped(`the dsh-delivery-assured plugin is not present at ${pluginRoot}; its suites were NOT RUN in this checkout`)
} else {
  for (const test of pluginTests) {
    if (!existsSync(test.file)) {
      failures.push(`${test.label}: test file is missing at ${test.file}`)
      continue
    }
    if (test.requires === 'dsh-packages' && !dshPackagesPresent) {
      noteSkipped(`${test.label} requires DSH packages and no packages exist under $DSH_HOME/profiles/node_modules`)
      skippedSuites.push(test.label)
      continue
    }
    if (test.requires === 'dsh-runtime' && !dshRuntimePresent) {
      noteSkipped(`${test.label} requires a real DSH runtime and none was found (no desktop installation and no $DSH_HOME palette of packages)`)
      skippedSuites.push(test.label)
      continue
    }
    const result = spawnSync(process.execPath, [test.file], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) {
      // Keep enough of the failure to diagnose it from the CI log: a 3-line tail once
      // hid the actual assertion and the run had to be reproduced locally.
      failures.push(`${test.label} failed: ${failureDetail(result)}`)
    }
  }
}

for (const file of ['evidence.test.mjs', 'verification.test.mjs', 'convergence.test.mjs', 'completion.test.mjs', 'durable-state.test.mjs', 'durable-transport.test.mjs', 'state-view.test.mjs', 'capture-run.test.mjs', 'host-verification.test.mjs',
  // The four invariants that keep a false-positive Delivered hard to produce: the
  // regression Spine can only grow, subprocess environments are constructed instead
  // of inherited, a backend that cannot observe a Required fact cannot deliver, and
  // the logic that decides Delivered is a finite frozen TCB.
  'spine-accumulation.test.mjs', 'env-construction.test.mjs', 'backend-capability.test.mjs', 'frozen-tcb.test.mjs']) {
  const result = spawnSync(process.execPath, [join(packRoot, 'tests', file)], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) failures.push(`${file} failed: ${failureDetail(result)}`)
}

// Loading a module is a stronger check than parsing it: it also catches a broken
// import specifier, which `--check` alone cannot see.
for (const [label, file] of [
  ['src/cli.mjs', join(root, 'src', 'cli.mjs')],
  ['src/commands/status.mjs', join(root, 'src', 'commands', 'status.mjs')],
  ['packages/delivery-assured/scripts/lib/index.mjs', join(packRoot, 'scripts', 'lib', 'index.mjs')],
  ['packages/delivery-assured/scripts/lib/model.mjs', join(packRoot, 'scripts', 'lib', 'model.mjs')],
  ['packages/delivery-assured/scripts/lib/coverage-core.mjs', join(packRoot, 'scripts', 'lib', 'coverage-core.mjs')],
]) {
  if (!existsSync(file)) {
    failures.push(`${label} is missing at ${file}`)
    continue
  }
  const target = pathToFileURL(file).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(target)})`], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').filter((l) => l.trim() !== '')
    failures.push(`${label} cannot be loaded: ${detail[0] || `exit ${result.status}`}`)
  }
}

const help = spawnSync(process.execPath, [join(root, 'src', 'cli.mjs'), '--help'], { cwd: root, encoding: 'utf8' })
if (help.status !== 0) failures.push(`src/cli.mjs --help exited ${help.status}`)
else if (!/Usage/i.test(help.stdout)) failures.push('src/cli.mjs --help printed no usage text')

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`BUILD FAIL ${failure}\n`)
  process.exit(1)
}
for (const note of notes) process.stdout.write(`note: ${note}\n`)
if (skippedSuites.length > 0) {
  process.stdout.write(`skipped suites (not run): ${skippedSuites.join(', ')}\n`)
}
process.stdout.write(`build ok: node ${process.versions.node}, no runtime dependencies, sources load\n`)
process.exit(0)
