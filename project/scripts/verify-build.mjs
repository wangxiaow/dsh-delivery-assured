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
  failures.push(`yaml.test.mjs failed: ${(yamlTests.stderr || yamlTests.stdout || '').trim().split('\n').slice(-3).join(' / ')}`)
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
  { label: 'plugin skill-registry contract', file: join(pluginRoot, 'test', 'skill-registry.test.mjs'), requires: 'dsh-packages' },
  // This is the only suite that can catch "the plugin no longer loads". The other two
  // use their own tool builder and shell double, so they once passed while the plugin
  // was in fact unloadable. It needs a real runtime — the desktop payload counts.
  { label: 'plugin runtime contract', file: join(pluginRoot, 'test', 'compatibility.test.mjs'), requires: 'dsh-runtime' },
  // The workflows cannot run without a remote, so a wrong `node <path>` inside them
  // would otherwise stay invisible until the first push. This check runs here.
  { label: 'CI preflight', file: join(repoRoot, 'tools', 'ci-preflight.test.mjs'), requires: 'none' },
]
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const dshPackagesPresent = existsSync(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-skill'))
// The desktop keeps its packages inside `app.asar`, readable only through the
// Electron binary, so the installation itself is what makes the runtime reachable.
const desktopRuntimePresent = existsSync('D:/Program Files/DeepSeek Harness/DeepSeek Harness.exe')
const dshRuntimePresent = dshPackagesPresent || desktopRuntimePresent
if (!existsSync(pluginRoot)) {
  notes.push(
    `the dsh-delivery-assured plugin is not present at ${pluginRoot}; its suites were NOT RUN in this checkout`,
  )
} else {
  for (const test of pluginTests) {
    if (!existsSync(test.file)) {
      failures.push(`${test.label}: test file is missing at ${test.file}`)
      continue
    }
    if (test.requires === 'dsh-packages' && !dshPackagesPresent) {
      notes.push(`${test.label} was NOT RUN: no DSH packages under $DSH_HOME/profiles/node_modules`)
      continue
    }
    if (test.requires === 'dsh-runtime' && !dshRuntimePresent) {
      notes.push(
        `${test.label} was NOT RUN: no DSH runtime found (no desktop installation and no $DSH_HOME palette of packages)`,
      )
      continue
    }
    const result = spawnSync(process.execPath, [test.file], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) {
      failures.push(`${test.label} failed: ${(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' / ')}`)
    }
  }
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
process.stdout.write(`build ok: node ${process.versions.node}, no runtime dependencies, sources load\n`)
process.exit(0)
