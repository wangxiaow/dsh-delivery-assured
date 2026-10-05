#!/usr/bin/env node
/**
 * Real-runtime probe: the registered tools, invoked through the runtime that hosts them.
 *
 * `host-resolution.test.mjs` spawns this file with the desktop payload's own Electron
 * runtime (`ELECTRON_RUN_AS_NODE=1`), so `lib/define-tool.js` resolves the *host's*
 * `defineTool` and every definition below is compiled and registered by that runtime. The
 * probe then calls the registered executors — the same objects a model tool call would
 * reach — and prints one JSON observation.
 *
 * What is real here: the runtime process, the host helper, the tool registration, the
 * plugin's argument construction and dispatch path, and the correlation logic.
 * What is a stand-in, and named as such: `gh` (a local executable which records the argv it
 * was handed and answers `run list` from a scenario file) and the session shell seam (a
 * PowerShell-backed implementation of `resolve/execute/result`, as in the smoke suite).
 * No network call and no CI run is made; nothing is promoted.
 *
 * Env: DSH_DA_REPO_ROOT points at the repository that holds `packages/` and `project/`.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const repoRoot = process.env.DSH_DA_REPO_ROOT ? resolve(process.env.DSH_DA_REPO_ROOT) : resolve(pluginRoot, '..', '..')
const packRoot = resolve(repoRoot, 'packages', 'delivery-assured')
const projectRoot = resolve(repoRoot, 'project')

const entry = await import(new URL('../lib/index.js', import.meta.url).href)
const defineToolModule = await import(new URL('../lib/define-tool.js', import.meta.url).href)

/** The shell seam of the 0.2.x host: resolve(request) -> execute(spec) -> result(). */
function makeShell() {
  const commands = []
  return {
    commands,
    resolve(request) {
      commands.push(request.command)
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
}

/** Register one plugin instance and return its tools plus the shell it ran on. */
function mount(config) {
  const shell = makeShell()
  const registered = []
  const guards = []
  const errors = []
  entry.apply(
    {
      tools: { register: (tool) => registered.push(tool), guard: (check) => guards.push(check) },
      shell,
      skills: { register: () => {} },
      effect: () => () => {},
      get: () => undefined,
      logger: { info: () => {}, warn: () => {}, error: (message) => errors.push(String(message)) },
    },
    config,
  )
  return { shell, tools: registered, guards, errors }
}

/* ------------------------------------------------- the gh stand-in and its scenario */

const stubDir = mkdtempSync(join(tmpdir(), 'da-runtime-gh-'))
const scenarioPath = join(stubDir, 'scenario.json')
const listCountPath = join(stubDir, 'list-count')
const callsPath = join(stubDir, 'calls.log')
writeFileSync(join(stubDir, 'gh-stub.mjs'), `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
appendFileSync(join(here, 'calls.log'), JSON.stringify(args) + '\\n')
const scenario = JSON.parse(readFileSync(join(here, 'scenario.json'), 'utf8'))
if (args[0] === 'run' && args[1] === 'list') {
  const counter = join(here, 'list-count')
  const seen = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(seen + 1))
  process.stdout.write(JSON.stringify(seen === 0 ? scenario.before : scenario.after))
  process.exit(0)
}
if (scenario.dispatch_exit && scenario.dispatch_exit !== 0) {
  process.stderr.write(scenario.dispatch_error || 'refused')
  process.exit(scenario.dispatch_exit)
}
process.exit(0)
`, 'utf8')
writeFileSync(join(stubDir, 'gh.cmd'), '@echo off\r\nnode "%~dp0gh-stub.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n', 'utf8')
process.env.DSH_DELIVERY_GH = join(stubDir, 'gh.cmd')

function runScenario({ before, after, dispatchExit = 0, dispatchError = '' }) {
  writeFileSync(scenarioPath, JSON.stringify({ before, after, dispatch_exit: dispatchExit, dispatch_error: dispatchError }), 'utf8')
  rmSync(listCountPath, { force: true })
  return { reset: () => rmSync(callsPath, { force: true }) }
}

function recordedCalls() {
  if (!existsSync(callsPath)) return []
  return readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const workflowRunCalls = () => recordedCalls().filter((args) => args[0] === 'workflow' && args[1] === 'run').map((args) => args.slice(2))
const run = (id, extra = {}) => ({ databaseId: id, url: `https://example/run/${id}`, status: 'queued', conclusion: null, headSha: 'c'.repeat(40), headBranch: 'main', event: 'workflow_dispatch', createdAt: '2026-01-01T00:00:05Z', workflowName: 'x', ...extra })

const result = {
  source: defineToolModule.defineToolSource,
  version: defineToolModule.defineToolVersion,
  verdict: defineToolModule.defineToolVerdict,
  desktopHost: defineToolModule.isDesktopHost(),
}

/* ---------------------------------------------------------- 1. the iteration entry */

const iterationRoot = mkdtempSync(join(tmpdir(), 'da-runtime-iteration-'))
try {
  cpSync(projectRoot, iterationRoot, { recursive: true })
  rmSync(join(iterationRoot, '.agent', 'ITERATIONS.jsonl'), { force: true })
  // The working-tree source keeps this section offline: `close` recomputes the delivery
  // verdict through the operation pack, and a durable-ref read here would need the network.
  const instance = mount({ packRoot, projectRoot: iterationRoot, nodeBin: process.execPath, stateSource: 'worktree' })
  const tool = instance.tools.find((t) => t.name === 'delivery_iteration')
  result.iteration = {
    registered: Boolean(tool),
    first: tool ? await tool.execute({ action: 'open', requirement: '第一条需求：只读状态工具' }) : null,
  }
  if (tool) {
    // A session may not declare its own completion: closing an undelivered project must be
    // refused, and must write nothing.
    result.iteration.closed = await tool.execute({ action: 'close' })
    result.iteration.closedJournal = existsSync(join(iterationRoot, '.agent', 'ITERATIONS.jsonl'))
      ? readFileSync(join(iterationRoot, '.agent', 'ITERATIONS.jsonl'), 'utf8')
      : ''
    result.iteration.second = await tool.execute({ action: 'open', requirement: '第二轮：加入导出' })
    result.iteration.withoutRequirement = await tool.execute({ action: 'open' })
    result.iteration.journal = readFileSync(join(iterationRoot, '.agent', 'ITERATIONS.jsonl'), 'utf8')
  }
} finally {
  rmSync(iterationRoot, { recursive: true, force: true })
}

/* ------------------------------------------------------------- 2. the CI dispatch entry */

const ci = mount({ packRoot, projectRoot, nodeBin: process.execPath })
const ciTool = ci.tools.find((t) => t.name === 'delivery_ci')
result.ci = { registered: Boolean(ciTool) }

if (ciTool) {
  // A tool call arrives as a lossless JSON object — the host refuses `undefined` outright
  // (`invalid arguments: "arguments" must be a lossless JSON object`), so an action's
  // fields that were not supplied are simply absent from `args`. The plugin must therefore
  // never forward `args.<field>` for a field it did not receive.
  const call = (workflow, extra) => ({ action: 'request', workflow, repository: 'owner/repo', ...extra })

  // verify: only this action's declared inputs may reach the platform.
  runScenario({ before: [], after: [run(4242)] }).reset()
  result.ci.verify = await ciTool.execute(call('verify', {
    candidate: 'a'.repeat(40), parent_baseline: 'BL-003', slice: 'S2', hypothesis: 'the policy change closes the flow',
  }))
  result.ci.verifyDispatch = workflowRunCalls()[0] || null

  // promote: the verify fields are absent and must not be forwarded as `undefined`.
  runScenario({ before: [], after: [run(4343)] }).reset()
  result.ci.promote = await ciTool.execute(call('promote', {
    mode: 'promote-baseline', expected_parent: 'BL-003', verify_run_id: '4242', verify_run_attempt: '1',
  }))
  result.ci.promoteDispatch = workflowRunCalls()[0] || null

  // two new runs: nothing proves which belongs to this request, so report the failure
  // instead of naming the newest run.
  runScenario({ before: [], after: [run(4444), run(4343)] }).reset()
  result.ci.ambiguous = await ciTool.execute(call('verify', {
    candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x',
  }))

  // a refused dispatch is reported as refused, and never correlated.
  runScenario({ before: [], after: [run(4545)], dispatchExit: 1, dispatchError: 'HTTP 403: Resource not accessible' }).reset()
  result.ci.refused = await ciTool.execute(call('verify', {
    candidate: 'b'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x',
  }))

  // the two recovery entries ride the promote workflow with their own inputs only.
  runScenario({ before: [], after: [run(4646)] }).reset()
  result.ci.recordAttempt = await ciTool.execute(call('record-attempt', { verify_run_id: '4242', verify_run_attempt: '2' }))
  result.ci.recordAttemptDispatch = workflowRunCalls()[0] || null
  runScenario({ before: [], after: [run(4747)] }).reset()
  result.ci.resolveDiagnostic = await ciTool.execute(call('resolve-diagnostic', {
    verify_run_id: '4242', verify_run_attempt: '1', expected_state_sha: 'e'.repeat(40), resolution_owner: 'owner-actor',
    resolution_confirmation: 'owner-reviewed retention of diagnostic 4242-1',
  }))
  result.ci.resolveDiagnosticDispatch = workflowRunCalls()[0] || null
  result.ci.shellCommands = ci.shell.commands.length
}

rmSync(stubDir, { recursive: true, force: true })

/* ------------------------------------------- 3. the new-project bootstrap entry */

// The regression this section pins: a greenfield session used to be told there was no
// deliverable project at all, and every tool refused until a Contract appeared — so the
// requirement was recorded last (32 minutes in) instead of first. Here the same executors
// are called on an empty project, through the real host, and must answer with the
// lifecycle and the next concrete step.
const bootstrapRoot = mkdtempSync(join(tmpdir(), 'da-runtime-bootstrap-'))
try {
  const instance = mount({ packRoot, projectRoot: bootstrapRoot, nodeBin: process.execPath })
  const byName = (name) => instance.tools.find((tool) => tool.name === name)
  const guard = instance.guards[0]
  const writeTo = (relative) => ({ name: 'write', arguments: { file_path: join(bootstrapRoot, relative), content: 'x' } })

  result.bootstrap = {
    registered: instance.tools.length,
    toolNames: instance.tools.map((tool) => tool.name),
    journalBefore: existsSync(join(bootstrapRoot, '.agent', 'ITERATIONS.jsonl')),
    // Order is enforced, not merely documented: the first artifact is writable, the next
    // ones are refused *and* the refusal names them.
    firstArtifactAllowed: guard ? guard(writeTo(join('.agent', 'project.yaml'))) === undefined : null,
    laterArtifactDenied: guard ? typeof guard(writeTo(join('ci', 'verifier.yaml'))) === 'string' : null,
    denialNamesNextStep: guard ? String(guard(writeTo(join('ci', 'verifier.yaml'))) || '') : '',
    evidenceDenied: guard ? typeof guard(writeTo(join('.agent', 'evidence', 'e.json'))) === 'string' : null,
  }

  const resumeTool = byName('delivery_resume')
  result.bootstrap.resume = resumeTool ? await resumeTool.execute({}) : null
  const verifyTool = byName('delivery_verify_local')
  result.bootstrap.verifyLocal = verifyTool ? await verifyTool.execute({}) : null
  const gapsTool = byName('delivery_gaps')
  result.bootstrap.gaps = gapsTool ? await gapsTool.execute({ phase: 'contract' }) : null

  const iterationTool = byName('delivery_iteration')
  result.bootstrap.iteration = iterationTool ? await iterationTool.execute({ action: 'open', requirement: '第一条需求：Todo HTTP API' }) : null
  result.bootstrap.journal = existsSync(join(bootstrapRoot, '.agent', 'ITERATIONS.jsonl'))
    ? readFileSync(join(bootstrapRoot, '.agent', 'ITERATIONS.jsonl'), 'utf8')
    : ''
  // The lifecycle must follow the project between calls in one session: creating the first
  // artifact moves the summary to the next step without a restart.
  writeFileSync(join(bootstrapRoot, '.agent', 'project.yaml'), 'project:\n  id: probe\n', 'utf8')
  result.bootstrap.afterMetadata = resumeTool ? await resumeTool.execute({}) : null
  result.bootstrap.shellCommands = instance.shell.commands.length
} finally {
  rmSync(bootstrapRoot, { recursive: true, force: true })
}

process.stdout.write(JSON.stringify(result))
