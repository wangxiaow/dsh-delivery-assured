#!/usr/bin/env node
/**
 * Smoke test for dsh-delivery-assured.
 *
 * It drives the plugin the way a session would, against a throwaway copy of the
 * real project, without mounting DSH. That keeps the test honest: it proves the
 * bridge resolves paths, runs the real scripts, and reports a real exit code.
 *
 * Run: node plugins/dsh-delivery-assured/test/smoke.mjs
 */

import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
// A copied package cannot derive the repository from its own location, so the parent
// run passes it explicitly. This is also how a profile install points the plugin at
// a pack and a project that live outside the installed package.
const repoRoot = process.env.DSH_DA_REPO_ROOT
  ? resolve(process.env.DSH_DA_REPO_ROOT)
  : resolve(pluginRoot, '..', '..')

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

// ---------------------------------------------------------------- module load
const entry = await import(new URL('../lib/index.js', import.meta.url).href)
check('entry exports apply', typeof entry.apply === 'function')
check('entry exports inject', Array.isArray(entry.inject))
check('entry declares the plugin name', entry.name === 'delivery-assured')
check('entry default export carries apply', typeof entry.default?.apply === 'function')

const bridge = await import(new URL('../lib/bridge.js', import.meta.url).href)

// ------------------------------------------------------------- path resolution
const packRoot = bridge.resolvePackRoot({ packRoot: join(repoRoot, 'packages', 'delivery-assured') })
check('resolves the operation pack', packRoot !== null, String(packRoot))
check('pack contains the five scripts', packRoot
  ? ['check-gaps.mjs', 'coverage.mjs', 'verify.mjs', 'resume.mjs', 'attempts.mjs'].every((s) => existsSync(join(packRoot, 'scripts', s)))
  : false)

const projectRoot = resolve(repoRoot, 'project')
if (process.env.DSH_DA_DEBUG === '1') {
  process.stdout.write(
    `debug: cwd=${process.cwd()} pluginRoot=${pluginRoot} repoRoot=${repoRoot} projectRoot=${projectRoot}\n` +
      `debug: env DSH_DELIVERY_PROJECT=${JSON.stringify(process.env.DSH_DELIVERY_PROJECT)} DSH_DELIVERY_PACK=${JSON.stringify(process.env.DSH_DELIVERY_PACK)} child=${process.env.DSH_DA_SMOKE_CHILD}\n`,
  )
}
const project = bridge.resolveProjectRoot({ projectRoot }, repoRoot)
check('resolves the delivery project', project.root === projectRoot, project.root)
check('project is reported as configured', project.source === 'configured', project.source)
check('the configured project really carries a Contract', existsSync(join(projectRoot, '.agent', 'CONTRACT.yaml')))

const node = bridge.resolveNodeBin({})
check('resolves a Node executable', node !== null && existsSync(node.bin), node ? node.bin : 'none')

// An explicit plugin config must win over the environment, so a parent process
// cannot leak its own project into this plugin instance.
const config = { packRoot, projectRoot, nodeBin: node?.bin }
const isolated = bridge.buildContext({ ...config, projectRoot }, repoRoot)
check('an explicit config resolves the same project', isolated.project.root === projectRoot, isolated.project.root)

// -------------------------------------------------- context and a real script run
const context = bridge.buildContext(config, repoRoot)
check('context has no problems', context.problems.length === 0, context.problems.join('; '))
if (process.env.DSH_DA_DEBUG === '1') {
  process.stdout.write(`debug: context.project=${JSON.stringify(context.project)}\n`)
  process.stdout.write(`debug: context.packRoot=${context.packRoot}\n`)
  process.stdout.write(`debug: context.node=${JSON.stringify(context.node)}\n`)
}

// A shell double that runs the command for real through PowerShell, so the test
// exercises the same quoting the session would. It follows the 0.2.x seam:
// resolve(request) -> execute(spec) -> handle.result().
let lastCommand = null
const shellStub = {
  resolve(request) {
    lastCommand = request.command
    return { ...request, resolved: true }
  },
  async execute(spec) {
    let outcome
    try {
      const stdout = process.platform === 'win32'
        ? execFileSync('powershell.exe', ['-NoProfile', '-Command', spec.command], { encoding: 'utf8', cwd: spec.workdir, env: { ...process.env, ...(spec.env || {}) }, maxBuffer: 32 * 1024 * 1024 })
        : execFileSync('sh', ['-c', spec.command], { encoding: 'utf8', cwd: spec.workdir, env: { ...process.env, ...(spec.env || {}) }, maxBuffer: 32 * 1024 * 1024 })
      outcome = { exitCode: 0, timedOut: false, stdout: { text: stdout }, stderr: { text: '' } }
    } catch (error) {
      outcome = {
        exitCode: typeof error.status === 'number' ? error.status : 1,
        timedOut: false,
        stdout: { text: String(error.stdout || '') },
        stderr: { text: String(error.stderr || error.message || '') },
      }
    }
    return { ...outcome, result: async () => outcome }
  },
}

const resume = await bridge.runScript(context, shellStub, 'resume.mjs', [])
check('resume runs and prints the resolved command', lastCommand !== null && lastCommand.includes('resume.mjs'))
check('resume prints parseable JSON', resume.json !== null, resume.json_error || resume.stderr.slice(0, 200))
check('resume reports a local diagnostic', resume.json?.project !== undefined, JSON.stringify(resume.json)?.slice(0, 200))
check('resume names the project it inspected', resume.json?.project === resolve(projectRoot), String(resume.json?.project))

const gaps = await bridge.runScript(context, shellStub, 'check-gaps.mjs', ['--phase', 'contract'])
check('check-gaps prints parseable JSON', gaps.json !== null, gaps.json_error || gaps.stderr.slice(0, 200))
check('check-gaps reports the contract phase', gaps.json?.phase === 'contract', String(gaps.json?.phase))
check('check-gaps reads a real Contract', (gaps.json?.counts?.obligations ?? 0) > 0, JSON.stringify(gaps.json?.counts))

// -------------------------------------------------------------- tool registration
// Whether tools may be registered at all is a safety decision, not a detail: a
// definition the host cannot project kills the session at the next model request.
// This suite therefore asserts both branches of that decision instead of assuming it.
const defineToolModule = await import(new URL('../lib/define-tool.js', import.meta.url).href)
const verdict = defineToolModule.defineToolVerdict
const loggedErrors = []
const registered = []
const ctx = {
  tools: { register: (tool) => registered.push(tool) },
  shell: shellStub,
  skills: { register: (skill) => registered.push({ __skill: skill }) },
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {}, error: (message) => loggedErrors.push(String(message)) },
}
entry.apply(ctx, config)

const tools = registered.filter((r) => !r.__skill)
const skills = registered.filter((r) => r.__skill)
const toolNames = tools.map((t) => t.name)
check('the helper verdict is one of the two documented outcomes', ['ok', 'refuse'].includes(verdict), `${verdict} (${defineToolModule.defineToolSource})`)
if (verdict === 'ok') {
  check(
    'registers exactly the five read-only tools',
    toolNames.length === 5 && ['delivery_gaps', 'delivery_coverage', 'delivery_resume', 'delivery_attempts', 'delivery_verify_local'].every((n) => toolNames.includes(n)),
    toolNames.join(', '),
  )
} else {
  check('a refused helper registers no tools at all', toolNames.length === 0, toolNames.join(', '))
  check('and the refusal is explained', loggedErrors.some((m) => /NOT registering tools/.test(m)), loggedErrors.join(' | ').slice(0, 200))
}
check('registers the runtime skill', skills.length === 1 && skills[0].__skill.name === 'delivery-assured', JSON.stringify(skills.map((s) => s.__skill?.name)))
check(
  'the runtime skill carries a loadable body',
  typeof skills[0]?.__skill?.content === 'string' && skills[0].__skill.content.length > 500,
  `content length ${skills[0]?.__skill?.content?.length ?? 'missing'}`,
)
check(
  'the runtime skill body documents the authority boundary',
  /Only the trusted CI verification job produces/i.test(skills[0]?.__skill?.content || ''),
)
check('the skill name is kebab-case, as the registry requires', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(skills[0]?.__skill?.name || ''))
check(
  'registers no tool that could write authority',
  !toolNames.some((n) => /promote|write|record|approve|advance|evidence_write/i.test(n)),
  toolNames.join(', '),
)

// Every tool schema must be well formed, because a bad schema fails at call time —
// and the provider receives `tool.parameters` verbatim.
for (const tool of tools) {
  check(`tool ${tool.name} has a description`, typeof tool.description === 'string' && tool.description.length > 40)
  check(`tool ${tool.name} has an executor`, typeof tool.execute === 'function')
  check(`tool ${tool.name} declares output`, Boolean(tool.output))
  check(`tool ${tool.name} is provider-safe`, defineToolModule.schemaIsProviderSafe(tool), JSON.stringify(tool.parameters).slice(0, 120))
  check(
    `tool ${tool.name} states the authority boundary`,
    /read-only|diagnostic/i.test(tool.description) && /CI/i.test(tool.description),
  )
}

// A tool must not run when the pack or project cannot be resolved. This needs a
// registered tool, so it is only meaningful where the host helper was accepted; the
// same behaviour is asserted under the desktop host in host-resolution.test.mjs.
if (tools.length === 0) {
  process.stdout.write(
    `note: the host helper is not usable in this process (${defineToolModule.defineToolSource}), so tool behaviour is asserted by host-resolution.test.mjs instead\n`,
  )
} else {
  const brokenRegistered = []
  entry.apply(
    { tools: { register: (t) => brokenRegistered.push(t) }, shell: shellStub, effect: () => () => {}, logger: {} },
    { packRoot: join(tmpdir(), 'does-not-exist'), projectRoot: join(tmpdir(), 'does-not-exist'), nodeBin: node?.bin },
  )
  const gapsTool = brokenRegistered.find((t) => t.name === 'delivery_gaps')
  const brokenAnswer = gapsTool ? await gapsTool.execute({ phase: 'contract' }) : null
  check('a broken configuration produces a diagnostic instead of throwing', brokenAnswer?.ok === false, JSON.stringify(brokenAnswer)?.slice(0, 200))
  check('the diagnostic explains what to configure', Array.isArray(brokenAnswer?.problems) && brokenAnswer.problems.length > 0)
}

// The exact condition that once killed a live DSH session: no resolvable host helper,
// so the pass-through would have handed the provider an uncompiled parameter spec.
// Nothing may be registered in that condition, in any environment.
const poisonProbe = `
const registered = []
const errors = []
const ctx = { tools: { register: (t) => registered.push(t.name) }, skills: { register: () => {} }, effect: () => () => {}, logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(String(m)) } }
const entry = await import(${JSON.stringify(new URL('../lib/index.js', import.meta.url).href)})
entry.apply(ctx, { packRoot: ${JSON.stringify(packRoot)}, projectRoot: ${JSON.stringify(projectRoot)} })
const dt = await import(${JSON.stringify(new URL('../lib/define-tool.js', import.meta.url).href)})
process.stdout.write(JSON.stringify({ verdict: dt.defineToolVerdict, source: dt.defineToolSource, tools: registered, errors: errors.length }))
`
const emptyHome = mkdtempSync(join(tmpdir(), 'da-empty-home-'))
try {
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', poisonProbe], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: emptyHome, DSH_PROFILE_DIR: '', DSH_DELIVERY_DSH_TOOLS_DIR: '' },
  })
  const result = JSON.parse(child)
  check('an unresolvable host helper yields the refuse verdict', result.verdict === 'refuse', JSON.stringify(result).slice(0, 200))
  check('and no tool is registered in that condition', Array.isArray(result.tools) && result.tools.length === 0, JSON.stringify(result.tools))
  check('and the refusal is logged', result.errors > 0, String(result.errors))
} catch (error) {
  check('the poisoning-condition probe ran', false, String(error.message).slice(0, 200))
} finally {
  rmSync(emptyHome, { recursive: true, force: true })
}

// ------------------------------------- steering: protected paths + global kernel
const guardCalls = []
const promptVars = new Map()
const promptSections = []
const steeringCtx = {
  tools: { register: () => {}, guard: (g) => guardCalls.push(g) },
  shell: shellStub,
  skills: { register: () => {} },
  systemPrompt: {
    variable: (n, p) => { promptVars.set(n, p); return () => {} },
    section: (s) => { promptSections.push(s); return () => {} },
  },
  get: () => undefined,
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {} },
}
entry.apply(steeringCtx, config)

check('registers exactly one protected-path guard', guardCalls.length === 1, `guards=${guardCalls.length}`)
const guard = guardCalls[0]
const denyReason = (exec) => guard(exec)
check(
  'denies writing the Contract',
  typeof denyReason({ name: 'write', arguments: { file_path: join(projectRoot, '.agent', 'CONTRACT.yaml'), content: 'x' } }) === 'string',
)
check(
  'denies editing the protected acceptance spec',
  typeof denyReason({ name: 'edit', arguments: { file_path: join(projectRoot, 'tests', 'acceptance', 'spec', 'cli.spec.mjs') } }) === 'string',
)
check(
  'denies rewriting the verifier configuration',
  typeof denyReason({ name: 'write', arguments: { file_path: join(projectRoot, 'ci', 'verifier.yaml') } }) === 'string',
)
check(
  'denies rewriting the operation pack the verifier runs',
  typeof denyReason({ name: 'write', arguments: { file_path: join(repoRoot, 'packages', 'delivery-assured', 'scripts', 'coverage.mjs') } }) === 'string',
)
// The pack's own repository is the one case where that layer must be switchable:
// otherwise improving the pack would be refused as a Candidate edit.
const selfHosting = []
entry.apply(
  { tools: { register: () => {}, guard: (g) => selfHosting.push(g) }, shell: shellStub, effect: () => () => {}, get: () => undefined, logger: {} },
  { ...config, protectRepoMaterial: false },
)
check(
  'a self-hosting project can switch off the repository-material layer',
  selfHosting.length === 1 &&
    selfHosting[0]({ name: 'write', arguments: { file_path: join(repoRoot, 'packages', 'delivery-assured', 'scripts', 'coverage.mjs') } }) === undefined &&
    typeof selfHosting[0]({ name: 'write', arguments: { file_path: join(projectRoot, '.agent', 'CONTRACT.yaml') } }) === 'string',
  `guards=${selfHosting.length}`,
)
check(
  'denies a shell command that moves an authority ref',
  typeof denyReason({ name: 'pwsh', arguments: { command: 'git push origin HEAD:refs/heads/baseline/main' } }) === 'string',
)
check(
  'denies a write whose target cannot be resolved (fail closed)',
  typeof denyReason({ name: 'write', arguments: { content: 'x' } }) === 'string',
)
check(
  'allows the Candidate driver surface',
  denyReason({ name: 'write', arguments: { file_path: join(projectRoot, 'tests', 'acceptance', 'driver', 'index.mjs'), content: 'x' } }) === undefined,
)
check(
  'never blocks read-only tools',
  denyReason({ name: 'read', arguments: { file_path: join(projectRoot, '.agent', 'CONTRACT.yaml') } }) === undefined,
)
check(
  'allows an ordinary diagnostic command',
  denyReason({ name: 'pwsh', arguments: { command: 'node packages/delivery-assured/scripts/coverage.mjs --view mvp' } }) === undefined,
)

check('publishes the delivery kernel variable', promptVars.has('delivery_kernel'), [...promptVars.keys()].join(', '))
check(
  'publishes the kernel as a prompt section that references the variable',
  promptSections.some((s) => s.name === 'delivery-assured:kernel' && String(s.text).includes('{{delivery_kernel}}')),
  JSON.stringify(promptSections.map((s) => s.name)),
)

const kernelModule = await import(new URL('../lib/kernel.js', import.meta.url).href)
const kernel = kernelModule.createKernel({ resolveContext: (cwd) => bridge.buildContext(config, cwd) })
await kernel.refresh(shellStub, projectRoot)
const kernelText = kernel.text()
check('the kernel names the project it inspected', kernelText.includes(resolve(projectRoot)), kernelText.slice(0, 160))
check('the kernel states the trust boundary', /不是完成凭证/.test(kernelText) && /受保护标准/.test(kernelText))
check('the kernel reports what is still owed and the budget', /还欠:/.test(kernelText) && /预算:/.test(kernelText))
check('the kernel names the protected paths a session must not write', /CONTRACT\.yaml/.test(kernelText) && /acceptance\/spec/.test(kernelText))
const fixtureKernel = kernelModule.renderKernel({
  project: 'P:/demo',
  candidate: 'a'.repeat(40),
  dirty: [1, 2],
  current_slice: 'S1',
  local_baseline: { baseline_id: 'BL-000' },
  evidence: { total: 2, issuer_match: 1, independently_attested: 0 },
  owed: { pending_implementation: ['X'] },
  budget: { counted: 1, limits: { total_attempt_limit: 8, replan_limit: 2 }, history_known: true, critical_open: ['R'] },
  blockers: ['b1'],
  next_actions: ['do next'],
})
check(
  'a fixture renders deterministically, including uncertainty about origin',
  fixtureKernel.includes('BL-000') && fixtureKernel.includes('do next') && fixtureKernel.includes('+2 未提交') && fixtureKernel.includes('无法确认来源'),
  fixtureKernel.slice(0, 200),
)
check('an unresolvable project says so instead of inventing a summary', /未找到可检查的交付项目/.test(kernelModule.renderKernel({})))

// ------------------------------------------------- invocation through the package
// Run the suite once more from a copied package directory, to prove the plugin
// travels intact. The environment guard stops that run from recursing further.
// The pack lives in the source repository, so it is passed explicitly 鈥?that is
// exactly how a profile install points at a pack that is not inside the plugin.
if (process.env.DSH_DA_SMOKE_CHILD === '1') {
  check('child run reached the end of the suite', true)
} else {
  const packageRoot = mkdtempSync(join(tmpdir(), 'dsh-da-pkg-'))
  try {
    cpSync(pluginRoot, packageRoot, { recursive: true })
    const invoked = execFileSync(process.execPath, [join(packageRoot, 'test', 'smoke.mjs')], {
      encoding: 'utf8',
      timeout: 300000,
      cwd: repoRoot,
      env: {
        ...process.env,
        DSH_DA_SMOKE_CHILD: '1',
        DSH_DA_REPO_ROOT: repoRoot,
        DSH_DA_DEBUG: process.env.DSH_DA_DEBUG || '',
        DSH_DELIVERY_PACK: join(repoRoot, 'packages', 'delivery-assured'),
        DSH_DELIVERY_PROJECT: projectRoot,
      },
    })
    check('the plugin runs from a copied package directory', /smoke ok/.test(invoked), invoked.slice(-200))
  } catch (error) {
    check(
      'the plugin runs from a copied package directory',
      false,
      String(error.stdout || error.stderr || error.message).slice(-300),
    )
  } finally {
    rmSync(packageRoot, { recursive: true, force: true })
  }

  // Without a resolvable pack the plugin must say so, not throw at import time.
  const orphanRoot = mkdtempSync(join(tmpdir(), 'dsh-da-orphan-'))
  try {
    cpSync(pluginRoot, orphanRoot, { recursive: true })
    const orphan = await import(new URL(`file://${join(orphanRoot, 'lib', 'index.js').replace(/\\/g, '/')}`).href)
    const orphanTools = []
    const orphanErrors = []
    orphan.apply(
      {
        tools: { register: (t) => orphanTools.push(t) },
        shell: shellStub,
        effect: () => () => {},
        logger: { error: (m) => orphanErrors.push(String(m)) },
      },
      { packRoot: join(orphanRoot, 'nope'), projectRoot: join(orphanRoot, 'nope') },
    )
    const orphanResume = orphanTools.find((t) => t.name === 'delivery_resume')
    if (orphanResume) {
      const answer = await orphanResume.execute({})
      check('an unresolvable pack is reported as a diagnostic', answer?.ok === false, JSON.stringify(answer)?.slice(0, 200))
      check(
        'the diagnostic names the pack as the missing piece',
        (answer?.problems || []).some((p) => /operation pack/i.test(p)),
        JSON.stringify(answer?.problems),
      )
    } else {
      // The helper was not the host's own, so no tool exists to ask; withholding
      // everything is the contract, and the reason must still be visible.
      check('an unusable helper withholds every tool instead of throwing at import', orphanTools.length === 0)
      check('and says why it withheld them', orphanErrors.some((m) => /NOT registering tools/.test(m)), orphanErrors.join(' | ').slice(0, 200))
    }
  } catch (error) {
    check('an unresolvable pack is reported as a diagnostic', false, String(error.message).slice(0, 200))
  } finally {
    rmSync(orphanRoot, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------- reporting
if (failures.length > 0) {
  process.stderr.write(`smoke: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`smoke ok: ${passed} checks passed\n`)
process.exit(0)

