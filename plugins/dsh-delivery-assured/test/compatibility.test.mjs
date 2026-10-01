#!/usr/bin/env node
/**
 * Contract test driven by an installed DSH runtime.
 *
 * The other suites here run on a bare Node install, which is why they once passed
 * while the plugin was unloadable: they used a hand-written tool builder and a
 * hand-written shell double, so neither DSH's schema projection nor its shell seam
 * was ever exercised.
 *
 * This suite pins a runtime explicitly and then checks three contracts against it:
 *
 *   1. `evaluatePluginCompatibility` accepts this plugin's manifest;
 *   2. the real `defineTool` projects every tool's parameter spec and asserts its
 *      output schema — the same call `tools.register()` makes;
 *   3. one tool runs to completion through the 0.2.x shell seam
 *      (`resolve -> execute -> result`) and returns a read-only report.
 *
 * Runtimes are found, not guessed. The desktop ships its packages inside `app.asar`,
 * which only Electron's patched filesystem can read, so that runtime is exercised by
 * re-running this file through the DeepSeek Harness binary with
 * `ELECTRON_RUN_AS_NODE=1`. Each target is pinned through
 * `DSH_DELIVERY_DSH_TOOLS_DIR`, and the plugin is copied to a scratch directory so
 * nothing can resolve through an ambient module path instead.
 *
 * Run: node plugins/dsh-delivery-assured/test/compatibility.test.mjs
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const repoRoot = resolve(pluginRoot, '..', '..')

const DESKTOP_EXECUTABLE = 'D:/Program Files/DeepSeek Harness/DeepSeek Harness.exe'
const DESKTOP_NODE_MODULES = 'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules'
const HARNESS_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')

/** Runtimes to verify against, in the order they are reported. */
function targets() {
  const found = []
  if (existsSync(DESKTOP_EXECUTABLE)) {
    found.push({ label: 'desktop', nodeModules: DESKTOP_NODE_MODULES, electron: DESKTOP_EXECUTABLE })
  }
  const profileNodeModules = join(HARNESS_HOME, 'profiles', 'node_modules')
  if (existsSync(join(profileNodeModules, '@deepseek-ai', 'dsh-tools'))) {
    found.push({ label: 'profile-node_modules', nodeModules: profileNodeModules, electron: null })
  }
  return found
}

/* ---------------------------------------------------------------- child mode */

/**
 * Child mode runs one target in-process and prints one JSON verdict line. The parent
 * spawns it for each target so a failure in one runtime reports its own detail.
 */
if (process.env.DSH_DA_TARGET_LABEL) {
  const verdict = await runTarget({
    label: process.env.DSH_DA_TARGET_LABEL,
    nodeModules: process.env.DSH_DA_TARGET_NODE_MODULES,
    electron: null,
  })
  process.stdout.write(`\n__VERDICT__${JSON.stringify(verdict)}\n`)
  process.exit(verdict.failures.length === 0 ? 0 : 1)
}

/* --------------------------------------------------------------- parent mode */

const found = targets()
if (found.length === 0) {
  process.stderr.write(
    'compatibility.test: no DSH runtime found. Looked in:\n' +
      `  ${DESKTOP_NODE_MODULES}\n  ${join(HARNESS_HOME, 'profiles', 'node_modules')}\n`,
  )
  process.exit(2)
}

let passed = 0
const failures = []

for (const target of found) {
  process.stdout.write(`\n=== target: ${target.label} (${target.nodeModules}) ===\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-da-contract-'))
  try {
    // Copy the plugin out of the repository so no resolution can walk up into the
    // repo's own node_modules and pick a different DSH line.
    cpSync(pluginRoot, join(scratch, 'dsh-delivery-assured'), { recursive: true })

    const env = {
      ...process.env,
      DSH_DA_TARGET_LABEL: target.label,
      DSH_DA_TARGET_NODE_MODULES: target.nodeModules,
      DSH_DA_PLUGIN_ROOT: join(scratch, 'dsh-delivery-assured'),
      DSH_DA_REPO_ROOT: repoRoot,
      DSH_DELIVERY_DSH_TOOLS_DIR: join(target.nodeModules, '@deepseek-ai', 'dsh-tools'),
      // The harness home must not leak a second runtime into the child.
      DSH_HOME: '',
      DSH_PROFILE_DIR: '',
      DSH_DELIVERY_PACK: join(repoRoot, 'packages', 'delivery-assured'),
      DSH_DELIVERY_PROJECT: join(repoRoot, 'project'),
    }
    if (target.electron) {
      env.ELECTRON_RUN_AS_NODE = '1'
    }

    const runner = target.electron || process.execPath
    const args = target.electron ? [join(scratch, 'dsh-delivery-assured', 'test', 'compatibility.test.mjs')] : [fileURLToPath(import.meta.url)]

    let stdout = ''
    let status = 0
    try {
      stdout = execFileSync(runner, args, {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (error) {
      stdout = String(error.stdout || '')
      process.stderr.write(String(error.stderr || ''))
      status = typeof error.status === 'number' ? error.status : 1
    }
    process.stdout.write(stdout.split('\n__VERDICT__')[0])

    const marker = stdout.match(/__VERDICT__(\{.*\})\s*$/m)
    if (marker === null) {
      failures.push(`${target.label}: the target run produced no verdict (exit ${status})`)
      continue
    }
    const verdict = JSON.parse(marker[1])
    passed += verdict.passed
    for (const failure of verdict.failures) failures.push(`${target.label}: ${failure}`)
    for (const note of verdict.notes) process.stdout.write(`note: ${target.label}: ${note}\n`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  process.stderr.write(`\ncompatibility.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`\ncompatibility.test ok: ${passed} checks passed across ${found.length} runtime(s)\n`)
process.exit(0)

/* -------------------------------------------------------------- target runner */

async function runTarget({ label, nodeModules }) {
  const scratch = process.env.DSH_DA_PLUGIN_ROOT
  const passedChecks = []
  const targetFailures = []
  const notes = []
  const check = (name, condition, detail) => {
    if (condition) passedChecks.push(name)
    else targetFailures.push(`${name}${detail ? `: ${detail}` : ''}`)
  }

  const plugin = scratch
    ? pathToFileURL(join(scratch, 'lib', 'index.js')).href
    : new URL('../lib/index.js', import.meta.url).href
  const defineToolModule = scratch
    ? await import(pathToFileURL(join(scratch, 'lib', 'define-tool.js')).href)
    : await import(new URL('../lib/define-tool.js', import.meta.url).href)

  // The runtime this target stands for, read straight off disk.
  const expectedManifest = JSON.parse(readFileSync(join(nodeModules, '@deepseek-ai', 'dsh-tools', 'package.json'), 'utf8'))
  const expectedVersion = expectedManifest.version
  process.stdout.write(`expected @deepseek-ai/dsh-tools: ${expectedVersion}\n`)
  process.stdout.write(`resolved defineTool:              ${defineToolModule.defineToolSource}\n`)

  check(
    'the plugin loaded the runtime defineTool rather than the pass-through',
    defineToolModule.defineToolIsPassThrough === false,
    `source: ${defineToolModule.defineToolSource}`,
  )
  check(
    'the loaded defineTool is the version this target provides',
    defineToolModule.defineToolVersion === expectedVersion,
    `loaded ${defineToolModule.defineToolVersion}, target provides ${expectedVersion}`,
  )

  const entry = await import(plugin)
  const manifest = JSON.parse(readFileSync(join(process.env.DSH_DA_PLUGIN_ROOT, 'package.json'), 'utf8'))

  // ---- 1. DSH's own compatibility verdict (needs the boot package, when present) ---
  const appBootPath = join(nodeModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  if (existsSync(appBootPath)) {
    try {
      const boot = await import(pathToFileURL(appBootPath).href)
      if (typeof boot.evaluatePluginCompatibility === 'function') {
        const verdict = boot.evaluatePluginCompatibility(manifest, {}, expectedVersion)
        check(
          'DSH accepts this plugin manifest',
          verdict === undefined,
          verdict === undefined ? '' : `incompatible peers ${JSON.stringify(verdict.peers)} on dsh ${verdict.runtimeVersion}`,
        )
      } else {
        notes.push('dsh-app-boot does not export evaluatePluginCompatibility; peer range asserted literally')
      }
    } catch (error) {
      notes.push(`dsh-app-boot not importable (${String(error.message).split('\n')[0]}); peer range asserted literally`)
    }
  } else {
    notes.push('dsh-app-boot is not installed beside this runtime; peer range asserted literally')
  }

  check(
    'the peer range names the runtime line this plugin was built against',
    /^\^0\.2\./.test(String(manifest.peerDependencies?.['@deepseek-ai/dsh-tools'] ?? '')),
    JSON.stringify(manifest.peerDependencies),
  )

  // ---- 2. real defineTool projects every tool -------------------------------------
  const registered = []
  entry.apply(
    {
      tools: { register: (definition) => registered.push(definition) },
      skills: { register: () => {} },
      shell: {
        resolve: (r) => r,
        execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '{}' }, stderr: { text: '' } }) }),
      },
      get: () => undefined,
      logger: { info: () => {}, warn: () => {} },
    },
    { packRoot: process.env.DSH_DELIVERY_PACK, projectRoot: process.env.DSH_DELIVERY_PROJECT },
  )

  check('five tools registered', registered.length === 5, `registered ${registered.length}`)
  const expectedNames = ['delivery_gaps', 'delivery_coverage', 'delivery_resume', 'delivery_attempts', 'delivery_verify_local']
  const names = registered.map((t) => t.name)
  check('tool names are stable', expectedNames.every((n) => names.includes(n)), names.join(', '))

  for (const tool of registered) {
    check(`${tool.name} declares an object-rooted parameter schema`, tool.parameters?.type === 'object' && typeof tool.parameters.properties === 'object', JSON.stringify(tool.parameters)?.slice(0, 200))
    check(`${tool.name} declares a substantial description`, typeof tool.description === 'string' && tool.description.length > 40)
    check(`${tool.name} declares an output schema and renderer`, Boolean(tool.output?.schema) && typeof tool.output?.render === 'function')
    check(`${tool.name} exposes an executable`, typeof tool.execute === 'function')
  }

  // ---- 3. real shell seam, one tool end to end ------------------------------------
  const specs = []
  const sandboxPolicyCalls = []
  const execTools = []
  entry.apply(
    {
      tools: { register: (definition) => execTools.push(definition) },
      skills: { register: () => {} },
      shell: {
        resolve(request) {
          specs.push(request)
          return { timeoutMs: 300000, ...request }
        },
        async execute(spec) {
          let outcome
          try {
            const stdout =
              process.platform === 'win32'
                ? execFileSync('powershell.exe', ['-NoProfile', '-Command', spec.command], {
                    encoding: 'utf8',
                    cwd: spec.workdir,
                    env: { ...process.env, ...(spec.env || {}) },
                    maxBuffer: 64 * 1024 * 1024,
                  })
                : execFileSync('sh', ['-c', spec.command], {
                    encoding: 'utf8',
                    cwd: spec.workdir,
                    env: { ...process.env, ...(spec.env || {}) },
                    maxBuffer: 64 * 1024 * 1024,
                  })
            outcome = { exitCode: 0, stdout: { text: stdout }, stderr: { text: '' }, timedOut: false }
          } catch (error) {
            outcome = {
              exitCode: typeof error.status === 'number' ? error.status : 1,
              stdout: { text: String(error.stdout || '') },
              stderr: { text: String(error.stderr || error.message || '') },
              timedOut: false,
            }
          }
          return { ...outcome, result: async () => outcome }
        },
      },
      get: (name) =>
        name === 'sandboxPolicy'
          ? {
              resolve(request = {}) {
                sandboxPolicyCalls.push(request)
                return { mode: 'danger-full-access', workspaceRoot: process.env.DSH_DA_REPO_ROOT }
              },
            }
          : undefined,
      logger: { info: () => {}, warn: () => {} },
    },
    { packRoot: process.env.DSH_DELIVERY_PACK, projectRoot: process.env.DSH_DELIVERY_PROJECT },
  )

  const resumeTool = execTools.find((t) => t.name === 'delivery_resume')
  check('delivery_resume is registered for execution', Boolean(resumeTool))
  if (resumeTool) {
    let answer = null
    let execError = null
    try {
      answer = await resumeTool.execute({}, { signal: undefined, agent: undefined })
    } catch (error) {
      execError = error
    }
    check('delivery_resume runs through the shell seam', execError === null, String(execError?.message))
    check('the shell received a request naming the script', specs.length > 0 && String(specs[0].command).includes('resume.mjs'), JSON.stringify(specs[0])?.slice(0, 240))
    check('delivery_resume returns a report rather than throwing', answer?.ok !== false, JSON.stringify(answer)?.slice(0, 240))
    check('the report is labelled a local diagnostic', answer?.authority === 'local_diagnostic', String(answer?.authority))
    check('the report inspects the configured project', typeof answer?.project === 'string' && answer.project.endsWith('project'), String(answer?.project))
    check('the resolved sandbox policy reaches the shell request', specs.length > 0 && specs[0].sandboxPolicy?.mode === 'danger-full-access', JSON.stringify(specs[0]?.sandboxPolicy))
    check('the sandbox policy was resolved once for this call', sandboxPolicyCalls.length === 1, `resolved ${sandboxPolicyCalls.length} times`)
  }

  return { label, passed: passedChecks.length, failures: targetFailures, notes }
}
