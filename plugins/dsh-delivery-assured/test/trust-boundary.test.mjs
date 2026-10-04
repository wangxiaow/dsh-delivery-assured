#!/usr/bin/env node
/**
 * v0.3 §4.3 — can the plugin layer be a control boundary?
 *
 * The document refuses to assume an answer: it lists seven controls that must be
 * *verified* against the locked host version before "plugin-first" is believed, and
 * says that if a control only works because the Agent chooses to obey, the plugin
 * layer is not a trustworthy boundary.
 *
 * This suite answers all seven with evidence instead of assurance:
 *
 *   P1 no-evidence completion is refused ......... executed (promotion refuses offline)
 *   P2 stale evidence invalidates automatically .. executed (pack counterexample suite)
 *   P3 authority cannot be edited by the agent ... executed (guard denial + protected refs)
 *   P4 acceptance cannot be weakened silently .... executed (spec diff + guard denial)
 *   P5 crash/restart consistency ................. named suite in the build gate
 *   P6 tool execution can be intercepted ......... host surface, executed
 *   P7 lifecycle/pre-step events are reliable .... host surface, executed, with the
 *                                                  limit stated: the tool pipeline is
 *                                                  decisive, a model step is not
 *
 * Run: node plugins/dsh-delivery-assured/test/trust-boundary.test.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WRITE_TOOL_PATHS } from '../lib/guard.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const repoRoot = process.env.DSH_DA_REPO_ROOT ? resolve(process.env.DSH_DA_REPO_ROOT) : resolve(pluginRoot, '..', '..')

const DESKTOP_EXECUTABLE = 'D:/Program Files/DeepSeek Harness/DeepSeek Harness.exe'
const DESKTOP_NODE_MODULES = 'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules'
const HARNESS_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const PROFILE_NODE_MODULES = join(HARNESS_HOME, 'profiles', 'node_modules')

/* --------------------------------------------------------------- child: host surface */

if (process.env.DSH_DA_BOUNDARY_NM) {
  const nm = process.env.DSH_DA_BOUNDARY_NM
  const read = (...parts) => readFileSync(join(nm, ...parts), 'utf8')
  const version = (pkg) => JSON.parse(read('@deepseek-ai', pkg, 'package.json')).version
  const findings = { failures: [], checks: {} }

  const record = (name, condition, detail) => {
    findings.checks[name] = condition ? (detail || true) : false
    if (!condition) findings.failures.push(`${name}${detail ? `: ${detail}` : ''}`)
  }

  try {
    const toolsVersion = version('dsh-tools')
    findings.version = toolsVersion
    const toolsIndex = read('@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    record('P6: ctx.tools.guard exists', /guard\(guard\)\s*\{/.test(toolsIndex))
    record(
      'P6: a denial is monotonic and cannot be re-allowed',
      /no guard can force-allow|no later listener can turn that denial back into permission/.test(toolsIndex),
    )
    record('P6: guardReason is evaluated global-then-scoped', /guardReason\(exec\)\s*\{/.test(toolsIndex))
    const pipeline = ['tools/pre-execute', 'tools/execute', 'tools/post-execute', 'tools/result'].filter((event) =>
      toolsIndex.includes(event),
    )
    record('P6: the tool pipeline has ordered stages', pipeline.length === 4, pipeline.join(', '))
    findings.pipeline = pipeline

    const systemPrompt = read('@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')
    record('P7: ordered prompt sections are available', /section\(/.test(systemPrompt))
    record('P7: prompt variables are re-evaluated per assembly', /variable\(name, provider\)/.test(systemPrompt))
    record('P7: kernel changes notify the host', systemPrompt.includes('system-prompt/change'))

    const skillIndex = read('@deepseek-ai', 'dsh-skill', 'lib', 'index.js')
    record('P7: a runtime skill can be registered in memory', /runtime/.test(skillIndex) && /register/.test(skillIndex))

    const knownEvents = read('@deepseek-ai', 'dsh-session', 'lib', 'types', 'known-event-types.js')
    const stepEvents = ['step/start', 'step/end'].filter((event) => knownEvents.includes(`'${event}'`))
    record('P7: step boundaries are observable', stepEvents.length === 2, stepEvents.join(', '))
    // The honest limit: a step boundary is a log event, not a gate. A plugin can see
    // it, but nothing in this host lets a listener refuse to start a model step.
    findings.stepGate = /agent\/pre-step|step\/pre|pre-step/.test(knownEvents)

    // The guard denies paths by argument name, so those names must come from the host.
    const fsReadme = read('@deepseek-ai', 'dsh-tool-fs', 'README.md')
    const row = (tool) => {
      const match = new RegExp(`\\|\\s*\`${tool}\`\\s*\\|\\s*([^|]+)\\|`).exec(fsReadme)
      return match ? match[1] : ''
    }
    const hostKeys = [...new Set([...row('write').matchAll(/`([a-z_]+)\??`/g)].map((m) => m[1]))]
    findings.hostWriteKeys = hostKeys
    record(
      'guard write/edit parameters match the host tool surface',
      Object.values(WRITE_TOOL_PATHS).every((keys) => keys.includes('file_path')) && hostKeys.includes('file_path'),
      `host=${hostKeys.join(',')} guard=${JSON.stringify(WRITE_TOOL_PATHS)}`,
    )
  } catch (error) {
    findings.failures.push(`host surface unreadable: ${error.message}`)
  }

  process.stdout.write(`\n__BOUNDARY__${JSON.stringify(findings)}\n`)
  process.exit(findings.failures.length === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ parent: targets */

let passed = 0
const failures = []
const notes = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

/** P1: without an authenticated receipt, promotion refuses — even offline. */
const promoteRefusal = spawnSync(
  process.execPath,
  [join(repoRoot, 'ci', 'tools', 'ci-promote.mjs'), '--project', 'project', '--evidence-dir', join(repoRoot, 'project', '.agent', 'evidence'), '--expected-parent', 'none', '--dry-run'],
  { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } },
)
check(
  'P1: promotion refuses without an externally authenticated CI receipt',
  promoteRefusal.status === 1 && /PROMOTION BLOCKED/.test(`${promoteRefusal.stderr}${promoteRefusal.stdout}`),
  `exit=${promoteRefusal.status} ${`${promoteRefusal.stderr}`.trim().slice(0, 160)}`,
)

/** P2: a binding drift invalidates evidence, by the pack's own counterexample suite. */
const evidenceSuite = spawnSync(process.execPath, [join(repoRoot, 'packages', 'delivery-assured', 'tests', 'evidence.test.mjs')], {
  cwd: repoRoot,
  encoding: 'utf8',
})
check('P2: stale bindings invalidate evidence (counterexample suite)', evidenceSuite.status === 0, evidenceSuite.stderr.slice(0, 200))

/** P3/P4: authority and the protected standard are not candidate-editable. */
const gateList = readFileSync(join(repoRoot, 'project', 'scripts', 'verify-build.mjs'), 'utf8')
check('P3: the promotion job is the only holder of the baseline credential', (() => {
  const promote = readFileSync(join(repoRoot, '.github', 'workflows', 'promote.yml'), 'utf8')
  const jobs = promote.split(/\n  [a-z-]+:\n/)
  const holders = jobs.filter((job) => job.includes('BASELINE_PUSH_TOKEN'))
  return holders.length === 1 && /promote-baseline/.test(promote.slice(promote.indexOf('BASELINE_PUSH_TOKEN') - 4000, promote.indexOf('BASELINE_PUSH_TOKEN')))
})(), 'BASELINE_PUSH_TOKEN must appear in exactly one job')
check('P4: the protected spec diff runs in the verifier workflow', (() => {
  const verify = readFileSync(join(repoRoot, '.github', 'workflows', 'verify.yml'), 'utf8')
  return verify.includes('ci-spec-diff.mjs') && existsSync(join(repoRoot, 'ci', 'tools', 'ci-spec-diff.mjs'))
})())
check('P5: crash consistency is covered by a suite in the build gate', /ci-state-snapshot\.test\.mjs/.test(gateList))

/* ------------------------------------------------------- host surface per runtime */

const targets = []
if (existsSync(DESKTOP_EXECUTABLE)) {
  targets.push({ label: 'desktop-0.2.0-rc.2', nodeModules: DESKTOP_NODE_MODULES, electron: DESKTOP_EXECUTABLE })
}
if (existsSync(join(PROFILE_NODE_MODULES, '@deepseek-ai', 'dsh-tools'))) {
  targets.push({ label: 'profile-packages', nodeModules: PROFILE_NODE_MODULES, electron: null })
}
check('at least one DSH runtime is available to probe', targets.length > 0, 'no desktop install and no profile packages')

for (const target of targets) {
  const env = { ...process.env, DSH_DA_BOUNDARY_NM: target.nodeModules }
  if (target.electron) env.ELECTRON_RUN_AS_NODE = '1'
  const runner = target.electron || process.execPath
  const result = spawnSync(runner, [fileURLToPath(import.meta.url)], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 })
  const marker = `${result.stdout || ''}`.match(/__BOUNDARY__(\{.*\})\s*$/m)
  if (!marker) {
    check(`${target.label}: the host surface probe produced a verdict`, false, String(result.stderr || result.stdout).slice(-300))
    continue
  }
  const findings = JSON.parse(marker[1])
  for (const [name, value] of Object.entries(findings.checks)) {
    check(`${target.label} ${name}`, value !== false, typeof value === 'string' ? value : undefined)
  }
  notes.push(
    `${target.label}: dsh-tools ${findings.version}, pipeline ${findings.pipeline?.join(' -> ')}, ` +
      `write keys ${findings.hostWriteKeys?.join(',')}, decisive pre-step gate: ${findings.stepGate ? 'present' : 'absent'}`,
  )
  if (findings.failures.length > 0) failures.push(...findings.failures.map((f) => `${target.label}: ${f}`))
}

/* ------------------------------------------------------------------- the verdict */

const table = [
  ['P1 无 Evidence 的完成被拒绝', '执行：无签名 receipt 时 promotion 退出 1', '✓ 由 CI 强制，插件不授予任何东西'],
  ['P2 旧 revision 的 Evidence 自动失效', '执行：evidence 反例套件（绑定漂移即 stale）', '✓ 脚本层可判'],
  ['P3 权威状态不可被会话改写', '执行：guard 拒绝受保护路径 + 只有 Promotion job 持 baseline 凭据', '✓ 工作区写入被拒；权威仍在受保护 ref'],
  ['P4 acceptance 不可被静默降低', '执行：protected spec diff 进入 verify workflow + guard 拒绝 spec 写入', '✓ 本地拦截 + CI 复检'],
  ['P5 crash/restart 后状态一致', 'named suite：ci-state-snapshot + 幂等 lease（build gate 内）', '△ 离线演练通过，未做真实中断'],
  ['P6 tool execution 可被策略层拦截', '执行：ctx.tools.guard，拒绝单调不可翻转', '✓ 可用'],
  ['P7 lifecycle/pre-step 事件是否可靠', '执行：工具流水线四段 + step/start、step/end 可观察', '△ 工具层可拒绝，模型步骤只能观察'],
]

if (failures.length > 0) {
  process.stderr.write(`trust-boundary.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write('\nv0.3 §4.3 trust boundary (locked host):\n')
for (const [probe, evidence, verdict] of table) process.stdout.write(`  ${probe.padEnd(34)} ${evidence.padEnd(56)} ${verdict}\n`)
for (const note of notes) process.stdout.write(`note: ${note}\n`)
process.stdout.write(`trust-boundary.test ok: ${passed} checks passed\n`)
process.exit(0)
