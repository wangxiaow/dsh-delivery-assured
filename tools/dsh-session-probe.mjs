#!/usr/bin/env node
/**
 * Real DSH session probe for delivery-assured.
 *
 * This is the only check that exercises the product the way it is actually used: a real
 * headless DSH session, booted from an *independent* profile that mounts this plugin and
 * this skill, hosting the runtime the plugin declares as its peer. The model is asked to
 * call the delivery tools and to copy the supervision kernel's own lines back.
 *
 * It is deliberately an evidence producer, not a gate:
 *
 *   - it needs a model provider and network access, so it cannot run in the build gate;
 *   - everything it asserts is *also* computable without a model, and the expected values
 *     are computed here from the operation pack itself. The session must reproduce them.
 *     A model that invents numbers fails the probe; a session that cannot reach the
 *     authoritative state fails the probe.
 *
 * Usage:
 *   node tools/dsh-session-probe.mjs [--profile delivery-auto] [--project <dir>]
 *                                    [--phase authoritative|worktree] [--overlay]
 *                                    [--json] [--keep]
 *
 * `--phase worktree` boots a patched copy of the profile whose plugin config reads the
 * working tree instead of the durable ref, which is how the two answers are compared on
 * the same machine. `--overlay` restates the plugin config for the project given on the
 * command line (the profile pins its own project) without changing the state source.
 */

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packRoot = join(repoRoot, 'packages', 'delivery-assured')

const DEFAULTS = {
  profile: 'delivery-auto',
  project: join(repoRoot, 'project'),
  phase: 'authoritative',
}

function parse(argv) {
  const opts = { ...DEFAULTS, json: false, keep: false, overlay: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') opts.json = true
    else if (token === '--keep') opts.keep = true
    else if (token === '--overlay') opts.overlay = true
    else if (token === '--profile') opts.profile = argv[++index]
    else if (token === '--project') opts.project = argv[++index]
    else if (token === '--phase') opts.phase = argv[++index]
    else if (token === '-h' || token === '--help') { opts.help = true }
    else throw new Error(`unknown option ${token}`)
  }
  return opts
}

/**
 * The DSH runtime to host the session.
 *
 * The desktop payload is where the plugin's declared peer line lives
 * (`0.2.0-rc.2`), and Electron can read modules inside `app.asar` — a *plain* Node process
 * cannot, so the archive is checked as a file and the entry path inside it is not probed.
 * The override exists so this probe can be pointed at a different installation without
 * editing it.
 */
function resolveRuntime() {
  const override =
    process.env.DSH_PROBE_EXE && process.env.DSH_PROBE_BIN
      ? { exe: process.env.DSH_PROBE_EXE, bin: process.env.DSH_PROBE_BIN, probe: 'override' }
      : null
  const candidates = [override, {
    exe: 'D:/Program Files/DeepSeek Harness/DeepSeek Harness.exe',
    asar: 'D:/Program Files/DeepSeek Harness/resources/app.asar',
    bin: 'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    probe: 'desktop payload',
  }].filter(Boolean)
  for (const candidate of candidates) {
    if (!existsSync(candidate.exe)) continue
    if (candidate.probe === 'override' || existsSync(candidate.asar)) return candidate
  }
  return null
}

/** Run one command and return everything, without ever throwing on a non-zero exit. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options })
  return {
    status: result.status,
    error: result.error ? String(result.error.message) : null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  }
}

function parseJsonFromText(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/** The facts the pack itself reports for this project: the session must agree with these. */
function expectedFacts(project) {
  const result = run(process.execPath, [
    join(packRoot, 'scripts', 'resume.mjs'),
    '--project', project,
    '--durable-state',
    '--state-transport', 'auto',
    '--json',
  ], { cwd: repoRoot })
  const parsed = parseJsonFromText(result.stdout)
  if (!parsed) return { ok: false, reason: `resume produced no report: ${result.stderr.slice(0, 300)}` }
  return {
    ok: true,
    exit_code: result.status,
    transport: parsed.durable_state?.transport ?? null,
    state_sha: parsed.durable_state?.sha ?? null,
    state_available: parsed.durable_state?.available === true,
    authority: parsed.state_authority ?? null,
    baseline_id: parsed.local_baseline?.baseline_id ?? null,
    baseline_revision: parsed.local_baseline?.code_revision ?? null,
    attempts: parsed.budget?.total ?? null,
    attempt_limit: parsed.budget?.limits?.total_attempt_limit ?? null,
    replans: parsed.budget?.replans ?? null,
    replan_limit: parsed.budget?.limits?.replan_limit ?? null,
    verified: Array.isArray(parsed.owed?.verified) ? parsed.owed.verified.length : null,
  }
}

const TASK = (project) => `You are verifying a read-only delivery tool inside this session. Do exactly this, in order, before answering:

1. Call the tool \`delivery_resume\` with no arguments. It returns a JSON report as text.
2. Call the tool \`delivery_iteration\` with action "status".
3. Read your own system prompt. It contains a delivery-assured supervision summary with a line starting with \`权威状态:\`, a line starting with \`可信起点:\` and a line starting with \`预算:\`. Copy those lines verbatim.

The delivery project is: ${project}

Then answer with ONE JSON object and nothing else — no prose, no explanation, no code fence:

{
  "tools_visible": ["every tool name you can see that starts with delivery_"],
  "resume": {
    "exit_code": <the delivery_resume result's exit_code>,
    "state_available": <durable_state.available>,
    "transport": "<durable_state.transport>",
    "state_sha": "<durable_state.sha>",
    "baseline_id": "<local_baseline.baseline_id>",
    "attempts": <budget.total>,
    "attempt_limit": <budget.limits.total_attempt_limit>,
    "replans": <budget.replans>,
    "replan_limit": <budget.limits.replan_limit>,
    "state_authority": "<state_authority>",
    "verified": <the number of entries in owed.verified>
  },
  "iteration_status": {
    "state_sha": "<durable_state.sha>",
    "transport": "<durable_state.transport>",
    "baseline_id": "<baseline.baseline_id>",
    "attempts": <budget.counted>,
    "replans": <budget.replans>
  },
  "kernel": {
    "authority_line": "<the 权威状态: line, verbatim>",
    "baseline_line": "<the 可信起点: line, verbatim>",
    "budget_line": "<the 预算: line, verbatim>"
  }
}`

function bootSession({ runtime, profile, patch, project, task, workspace }) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-session-probe-'))
  const outPath = join(scratch, 'stdout.txt')
  const errPath = join(scratch, 'stderr.txt')
  const args = [runtime.bin, '--profile', profile]
  if (patch) args.push('--patch', patch)
  args.push('--json', task)
  mkdirSync(join(scratch, 'ws'), { recursive: true })
  const fdOut = openSync(outPath, 'w')
  const fdErr = openSync(errPath, 'w')
  let result
  try {
    result = spawnSync(runtime.exe, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DELIVERY_PACK: packRoot, DSH_DELIVERY_PROJECT: project },
      cwd: workspace || join(scratch, 'ws'),
      stdio: ['ignore', fdOut, fdErr],
      timeout: 900000,
    })
  } finally {
    closeSync(fdOut)
    closeSync(fdErr)
  }
  const stdout = readFileSync(outPath, 'utf8')
  const stderr = readFileSync(errPath, 'utf8')
  const events = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      events.push({ type: 'unparsed', text: line })
    }
  }
  const final = events.filter((event) => event.type === 'final').map((event) => String(event.text || '')).join('\n')
  const text = events.filter((event) => event.type === 'text').map((event) => String(event.text || '')).join('\n')
  return {
    scratch,
    exit: result.status,
    error: result.error ? String(result.error.message) : null,
    events,
    answer: final || text,
    stderr,
  }
}

/* ------------------------------------------------------------------------- phases */

const describe = (value) => (value === null || value === undefined ? '(null)' : String(value))
let checks = 0
let failures = 0
function check(condition, message) {
  checks += 1
  if (!condition) {
    failures += 1
    process.stdout.write(`FAIL ${message}\n`)
  }
}

function compare(label, session, expected) {
  check(session.state_sha === expected.state_sha, `${label}: authoritative state revision ${describe(session.state_sha)} != ${describe(expected.state_sha)}`)
  check(session.baseline_id === expected.baseline_id, `${label}: baseline ${describe(session.baseline_id)} != ${describe(expected.baseline_id)}`)
  check(Number(session.attempts) === Number(expected.attempts), `${label}: attempts ${describe(session.attempts)} != ${describe(expected.attempts)}`)
  check(Number(session.replans) === Number(expected.replans), `${label}: replans ${describe(session.replans)} != ${describe(expected.replans)}`)
  check(session.transport === expected.transport, `${label}: transport ${describe(session.transport)} != ${describe(expected.transport)}`)
  // The count of machine-verified outcomes is the strongest single check: it is only
  // non-zero when the state read bound the checkout to the Baseline's own revision.
  if (session.verified !== undefined) {
    check(Number(session.verified) === Number(expected.verified), `${label}: verified ${describe(session.verified)} != ${describe(expected.verified)}`)
  }
}
function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('node tools/dsh-session-probe.mjs [--profile delivery-auto] [--project <dir>] [--phase authoritative|worktree] [--json]\n')
    return 0
  }
  if (!['authoritative', 'worktree'].includes(opts.phase)) throw new Error(`unknown phase ${opts.phase}`)
  const runtime = resolveRuntime()
  if (!runtime) {
    process.stdout.write('SKIP dsh-session-probe: no DSH runtime was found (set DSH_PROBE_EXE and DSH_PROBE_BIN)\n')
    return 0
  }

  const expected = expectedFacts(opts.project)
  if (!expected.ok) {
    process.stdout.write(`FAIL the operation pack could not produce the expected facts: ${expected.reason}\n`)
    return 1
  }

  const patch = opts.phase === 'worktree' || opts.overlay ? join(tmpdir(), `dsh-probe-${process.pid}.yml`) : null
  if (patch) {
    writeFileSync(
      patch,
      [
        '- id: delivery-assured',
        '  name: "dsh-delivery-assured"',
        '  config:',
        `    packRoot: ${packRoot.replace(/\\/g, '/')}`,
        `    projectRoot: ${opts.project.replace(/\\/g, '/')}`,
        '    protectRepoMaterial: false',
        ...(opts.phase === 'worktree' ? ['    stateSource: worktree'] : []),
        '',
      ].join('\n'),
      'utf8',
    )
  }

  process.stdout.write(`expected: baseline ${expected.baseline_id} @ ${String(expected.baseline_revision).slice(0, 12)}, ` +
    `state ${String(expected.state_sha).slice(0, 12)} via ${expected.transport}, budget ${expected.attempts}/${expected.attempt_limit} + ${expected.replans}/${expected.replan_limit} replan\n`)

  let session
  try {
    session = bootSession({ runtime, profile: opts.profile, patch, project: opts.project, task: TASK(opts.project) })
  } finally {
    if (patch) rmSync(patch, { force: true })
  }

  const answer = parseJsonFromText(session.answer)
  const wantWorktree = opts.phase === 'worktree'

  check(session.exit === 0, `the session exited ${session.exit} (${describe(session.error)})`)
  check(answer !== null, `the session did not answer with a JSON object: ${session.answer.slice(-400)}`)

  if (answer) {
    const tools = Array.isArray(answer.tools_visible) ? answer.tools_visible.map(String) : []
    for (const name of ['delivery_resume', 'delivery_attempts', 'delivery_coverage', 'delivery_gaps', 'delivery_iteration', 'delivery_verify_local', 'delivery_ci']) {
      check(tools.includes(name), `delivery_* tool ${name} is not visible in the session (saw: ${tools.join(', ') || 'none'})`)
    }

    const resume = answer.resume || {}
    const iteration = answer.iteration_status || {}
    const kernel = answer.kernel || {}

    if (wantWorktree) {
      // The worktree source is a deliberate choice: it must say so instead of presenting
      // the working tree as the platform's state.
      check(resume.transport === null || resume.transport === undefined, `the worktree phase read a remote channel: ${describe(resume.transport)}`)
      check(resume.state_sha === null || resume.state_sha === undefined || resume.state_sha === '', `the worktree phase reported a state revision: ${describe(resume.state_sha)}`)
      check(resume.state_available === false || resume.state_available === 'false', `the worktree phase claims the ref was read: ${describe(resume.state_available)}`)
      check(Number(resume.attempts) !== Number(expected.attempts), `the worktree phase reported the authoritative budget ${describe(resume.attempts)}; it cannot`)
      check(typeof kernel.authority_line === 'string' && /未读取|失败|降级/.test(kernel.authority_line), `the kernel did not say the ref was not read: ${describe(kernel.authority_line)}`)
      compare('iteration_status', iteration, resume)
    } else {
      check(resume.exit_code === 0 || resume.exit_code === 1, `delivery_resume returned a tool failure: exit ${describe(resume.exit_code)}`)
      check(resume.state_available === true || resume.state_available === 'true', `the authoritative state was not read: ${describe(resume.state_available)}`)
      check(resume.state_authority === 'durable-ref', `the state authority is ${describe(resume.state_authority)}, not durable-ref`)
      compare('resume', resume, expected)
      compare('iteration_status', iteration, expected)
      check(/^权威状态:/.test(String(kernel.authority_line || '')), `the kernel authority line is missing: ${describe(kernel.authority_line)}`)
      check(String(kernel.authority_line).includes(String(expected.state_sha).slice(0, 12)), `the kernel names a different state revision: ${describe(kernel.authority_line)}`)
      check(String(kernel.authority_line).includes(`via ${expected.transport}`), `the kernel names a different channel: ${describe(kernel.authority_line)}`)
      check(String(kernel.baseline_line).includes(String(expected.baseline_id)), `the kernel names a different baseline: ${describe(kernel.baseline_line)}`)
      check(
        new RegExp(`attempts ${expected.attempts}/${expected.attempt_limit}`).test(String(kernel.budget_line)) &&
          new RegExp(`replans ${expected.replans}/${expected.replan_limit}`).test(String(kernel.budget_line)),
        `the kernel reports a different budget: ${describe(kernel.budget_line)}`,
      )
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ phase: opts.phase, expected, session_exit: session.exit, answer, failures, checks }, null, 2)}\n`)
  } else {
    process.stdout.write(`session exit ${session.exit}; answer:\n${session.answer.trim().slice(-1500)}\n`)
  }
  if (opts.keep) process.stdout.write(`session scratch kept at ${session.scratch}\n`)
  else rmSync(session.scratch, { recursive: true, force: true })
  process.stdout.write(`dsh-session-probe (${opts.phase}): ${checks - failures}/${checks} checks passed\n`)
  return failures > 0 ? 1 : 0
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`dsh-session-probe: ${error?.stack || error}\n`)
  process.exitCode = 2
}
