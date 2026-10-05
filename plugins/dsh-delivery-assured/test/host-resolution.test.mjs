#!/usr/bin/env node
/**
 * The plugin must compile its tool definitions with the runtime that hosts it.
 *
 * A definition compiled by a different DSH line is not a cosmetic mismatch: the host
 * forwards it to the model provider, which rejects the function schema and fails the
 * session with `Invalid schema for function ... got 'type: null'`. That happened once
 * because resolution walked `$DSH_HOME/profiles/node_modules` — the CLI/web palette —
 * while the desktop app was hosting the plugin from inside `app.asar`.
 *
 * This suite pins both situations and the policy between them.
 *
 * Run: node plugins/dsh-delivery-assured/test/host-resolution.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolRegistrationVerdict, peerLineMatches } from '../lib/define-tool.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const repoRoot = resolve(pluginRoot, '..', '..')
const DESKTOP_EXECUTABLE = 'D:/Program Files/DeepSeek Harness/DeepSeek Harness.exe'
const HARNESS_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')

let checks = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}

// ---------------------------------------------------------------- the policy table
check(toolRegistrationVerdict({ passThrough: false, hostLocal: true, desktopHost: true }) === 'ok', 'host-local helper registers')
check(toolRegistrationVerdict({ passThrough: false, hostLocal: false, desktopHost: true }) === 'refuse', 'a foreign helper must not register inside the desktop app')
check(toolRegistrationVerdict({ passThrough: false, hostLocal: false, desktopHost: false }) === 'ok', 'a CLI profile may use its own palette')
check(toolRegistrationVerdict({ passThrough: false, hostLocal: false, desktopHost: true, explicit: true }) === 'ok', 'an explicit pin overrides the policy')
// The pass-through is the case that once killed a live session: it returns the
// author-facing spec, which the host forwards to the provider verbatim.
check(toolRegistrationVerdict({ passThrough: true, hostLocal: false, desktopHost: true }) === 'refuse', 'a pass-through must never register')
check(toolRegistrationVerdict({ passThrough: true, hostLocal: true, desktopHost: false }) === 'refuse', 'a pass-through is refused everywhere, not only in the app')
// A different prerelease line is an unverified contract even when it resolves locally.
check(toolRegistrationVerdict({ passThrough: false, hostLocal: true, desktopHost: false, peerOk: false }) === 'refuse', 'a mismatched peer line must not register')
check(toolRegistrationVerdict({ passThrough: false, hostLocal: true, desktopHost: false, peerOk: true }) === 'ok', 'the declared peer line registers')
check(peerLineMatches('0.2.0-rc.2') === true && peerLineMatches('0.1.5-rc.3') === false, 'prerelease lines do not satisfy each other')

// ------------------------------------------------------------------- the real thing
const probe = `
import { readFileSync, existsSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineToolSource, defineToolSourceKind, defineToolVersion, defineToolIsHostLocal, defineToolVerdict, isDesktopHost } from ${JSON.stringify(new URL('../lib/define-tool.js', import.meta.url).href)}
let hostVersion = null
if (process.resourcesPath) {
  const manifest = join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  if (existsSync(manifest)) hostVersion = JSON.parse(readFileSync(manifest, 'utf8')).version
}
// The provider receives exactly \`tool.parameters\` (dsh-llm-deepseek: input_schema: tool.parameters),
// so this is the schema the model request would carry. A wrong-line helper once produced
// a definition whose root type was null and every request failed.
const registered = []
const ctx = {
  tools: { register: (tool) => registered.push(tool), guard: () => {} },
  skills: { register: () => {} },
  systemPrompt: { variable: () => {}, section: () => {} },
  get: () => undefined,
  effect: () => () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}
const { apply } = await import(${JSON.stringify(new URL('../lib/index.js', import.meta.url).href)})
apply(ctx, { packRoot: ${JSON.stringify(resolve(pluginRoot, '..', '..', 'packages', 'delivery-assured'))}, projectRoot: ${JSON.stringify(resolve(pluginRoot, '..', '..', 'project'))} })
const shapes = registered.map((tool) => ({
  name: tool.name,
  rootType: tool.parameters?.type ?? null,
  nullTypes: (JSON.stringify(tool.parameters).match(/"type":null/g) || []).length,
  propertyCount: Object.keys(tool.parameters?.properties || {}).length,
}))
// Tool behaviour under a helper the host accepts: the plugin copy has no sibling pack,
// so a broken configuration must come back as a diagnostic rather than an exception.
const scratch = mkdtempSync(join(tmpdir(), 'da-host-child-'))
cpSync(${JSON.stringify(pluginRoot)}, join(scratch, 'plugin'), { recursive: true })
const copied = await import(pathToFileURL(join(scratch, 'plugin', 'lib', 'index.js')).href)
const broken = []
copied.apply({ ...ctx, tools: { register: (tool) => broken.push(tool), guard: () => {} } }, { packRoot: '/nope', projectRoot: '/nope' })
const resumeTool = broken.find((tool) => tool.name === 'delivery_resume')
const brokenAnswer = resumeTool ? await resumeTool.execute({}) : null
rmSync(scratch, { recursive: true, force: true })
process.stdout.write(JSON.stringify({ source: defineToolSource, kind: defineToolSourceKind, version: defineToolVersion, hostLocal: defineToolIsHostLocal, verdict: defineToolVerdict, desktopHost: isDesktopHost(), hostVersion, shapes, brokenDiagnostic: brokenAnswer ? brokenAnswer.ok === false && (brokenAnswer.problems || []).some((p) => /operation pack/i.test(p)) : null }))
`

const runChild = (runner, env) =>
  spawnSync(runner, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 })

if (existsSync(DESKTOP_EXECUTABLE)) {
  // The desktop app hosts the plugin from its own payload, while $DSH_HOME still holds
  // the CLI/web palette. Resolution must prefer the app.
  const desktop = runChild(DESKTOP_EXECUTABLE, {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: HARNESS_HOME,
    DSH_PROFILE_DIR: '',
    DSH_DELIVERY_DSH_TOOLS_DIR: '',
  })
  check(desktop.status === 0, `desktop probe failed: ${desktop.stderr?.slice(0, 300)}`)
  const desktopResult = JSON.parse(desktop.stdout)
  check(desktopResult.desktopHost === true, 'the desktop process is recognised as the desktop host')
  check(desktopResult.kind === 'host-local', `the helper comes from the hosting app, got ${desktopResult.kind} (${desktopResult.source})`)
  check(/app\.asar/.test(desktopResult.source), `the resolved helper lives in the app payload: ${desktopResult.source}`)
  check(desktopResult.verdict === 'ok', `the desktop verdict must be ok, got ${desktopResult.verdict}`)

  const appManifest = join(dirname(DESKTOP_EXECUTABLE), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json')
  check(typeof desktopResult.hostVersion === 'string' && desktopResult.hostVersion.length > 0, 'the child could read the host manifest through the app payload')
  check(desktopResult.version === desktopResult.hostVersion, `the helper version matches the host (${desktopResult.hostVersion} vs ${desktopResult.version})`)
  void appManifest

  // The schema that would go to the provider: an object root, no null types.
  check(Array.isArray(desktopResult.shapes) && desktopResult.shapes.length === 8, `eight tool schemas are registered, got ${desktopResult.shapes?.length}`)
  for (const shape of desktopResult.shapes || []) {
    check(shape.rootType === 'object', `${shape.name}: the parameter schema is object-rooted (got ${shape.rootType})`)
    check(shape.nullTypes === 0, `${shape.name}: no null-typed node in the parameter schema`)
  }
  check(desktopResult.brokenDiagnostic === true, 'an unresolvable pack is reported as a diagnostic under the real host')

  // ---------------------------------------------------------------- registered tools, called
  // Schema compatibility is not behaviour: the tools above must also *run* through this
  // runtime with the arguments a model call supplies, and the CI dispatch must build each
  // action's own inputs. `runtime-entry.probe.mjs` is spawned by this same desktop runtime
  // and calls the registered executors; its `gh` is a local recording stand-in, so no run
  // is created and nothing is promoted.
  const runtimeProbe = spawnSync(DESKTOP_EXECUTABLE, [join(pluginRoot, 'test', 'runtime-entry.probe.mjs')], {
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 300000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: HARNESS_HOME,
      DSH_PROFILE_DIR: '',
      DSH_DELIVERY_DSH_TOOLS_DIR: '',
      DSH_DA_REPO_ROOT: repoRoot,
    },
  })
  check(runtimeProbe.status === 0, `the runtime-entry probe failed: ${String(runtimeProbe.stderr || '').slice(0, 400)}`)
  const runtime = JSON.parse(runtimeProbe.stdout || '{}')
  check(runtime.verdict === 'ok' && runtime.desktopHost === true, `the runtime-entry probe must run on the real host, got ${runtime.verdict}`)
  check(runtime.source === desktopResult.source, 'both probes compile with the same host helper')

  // Opening an iteration needs no predecessor, and the second round continues the closed one.
  check(runtime.iteration?.registered === true, 'delivery_iteration is registered under the real host')
  check(runtime.iteration?.first?.ok === true && runtime.iteration.first.iteration?.id === 'IT-001', `the first requirement did not open IT-001: ${JSON.stringify(runtime.iteration?.first)?.slice(0, 240)}`)
  check(
    runtime.iteration?.closed?.ok === false && runtime.iteration.closed.refused === true && runtime.iteration.closed.delivered === false,
    `closing an undelivered project must be refused, got ${JSON.stringify(runtime.iteration?.closed)?.slice(0, 300)}`,
  )
  check(
    !/IT-001[^\n]*closed/.test(runtime.iteration?.closedJournal || '') && !/"kind":"closed"/.test(runtime.iteration?.closedJournal || ''),
    'a refused close must write nothing into the journal',
  )
  check(runtime.iteration?.second?.ok === true && runtime.iteration.second.iteration?.id === 'IT-002', `the delivered round did not open IT-002: ${JSON.stringify(runtime.iteration?.second)?.slice(0, 240)}`)
  check(runtime.iteration?.second?.iteration?.iteration_of === 'IT-001', 'the next round names the round it continues')
  check(runtime.iteration?.withoutRequirement?.ok === false, 'opening without a requirement is refused')
  check(/IT-001/.test(runtime.iteration?.journal || '') && /IT-002/.test(runtime.iteration?.journal || ''), 'both rounds are in the append-only journal')

  // The CI entry: each action carries only its declared inputs, and a dispatch is reported
  // only when exactly one new run can be attributed to it.
  check(runtime.ci?.registered === true, 'delivery_ci is registered under the real host')
  const verify = runtime.ci?.verify
  check(verify?.status === 'requested' && verify?.ok === true, `the verify request was not attributed: ${JSON.stringify(verify)?.slice(0, 300)}`)
  check(String(verify?.run_id) === '4242', `the verify request named run ${verify?.run_id}`)
  check((verify?.correlation?.eligible_run_ids || []).join(',') === '4242', `the correlation named ${JSON.stringify(verify?.correlation)}`)
  check(verify?.frozen_candidate === 'a'.repeat(40), 'the request reports the frozen candidate it asked to verify')
  const verifyDispatch = runtime.ci?.verifyDispatch || []
  check(verifyDispatch.includes('candidate_ref=' + 'a'.repeat(40)), `the verify dispatch argv: ${JSON.stringify(verifyDispatch)}`)
  check(!verifyDispatch.some((arg) => arg.startsWith('mode=')), 'the verify dispatch carries no promote-only field')
  check(!verifyDispatch.some((arg) => arg.startsWith('expected_parent=')), 'the verify dispatch carries no expected_parent')
  check(!verifyDispatch.some((arg) => /undefined/.test(arg)), 'no undefined value reaches the platform')

  const promote = runtime.ci?.promote
  check(promote?.status === 'requested' && String(promote?.run_id) === '4343', `the promote request was not attributed: ${JSON.stringify(promote)?.slice(0, 300)}`)
  const promoteDispatch = runtime.ci?.promoteDispatch || []
  check(promoteDispatch.includes('mode=promote-baseline') && promoteDispatch.includes('expected_parent=BL-003'), `the promote dispatch argv: ${JSON.stringify(promoteDispatch)}`)
  check(promoteDispatch.includes('verify_run_id=4242'), 'the promote dispatch consumes the exact completed run')
  check(!promoteDispatch.some((arg) => arg.startsWith('candidate_ref=')), 'the promote dispatch carries no verify-only field')

  const ambiguous = runtime.ci?.ambiguous
  check(ambiguous?.ok === false && ambiguous?.status === 'ambiguous', `two new runs must fail explicitly: ${JSON.stringify(ambiguous)?.slice(0, 300)}`)
  check(ambiguous?.run_id === undefined, 'an ambiguous dispatch names no run')
  check(Array.isArray(ambiguous?.problems) && ambiguous.problems.length > 0, 'an ambiguous dispatch reports a problem')

  check(runtime.ci?.refused?.status === 'refused' && runtime.ci.refused.ok === false, `a refused dispatch stays refused: ${JSON.stringify(runtime.ci?.refused)?.slice(0, 240)}`)
  check((runtime.ci?.recordAttemptDispatch || []).includes('mode=record-attempt'), `record-attempt argv: ${JSON.stringify(runtime.ci?.recordAttemptDispatch)}`)
  check((runtime.ci?.resolveDiagnosticDispatch || []).includes('mode=resolve-diagnostic'), `resolve-diagnostic argv: ${JSON.stringify(runtime.ci?.resolveDiagnosticDispatch)}`)

  // ---------------------------------------------- the new-project bootstrap entry, called
  // A greenfield project must be answered with its lifecycle and the first action, and the
  // ordered window must be enforced *before* any Contract exists — not by the accident of
  // a missing Contract switching protection off.
  const bootstrapRun = runtime.bootstrap || {}
  check(bootstrapRun.registered === 8, `all eight tools mount on a new project, got ${bootstrapRun.registered}`)
  check(
    Array.isArray(bootstrapRun.toolNames) && bootstrapRun.toolNames.includes('delivery_verify_independent'),
    `the host-executed verifier is registered on a new project: ${JSON.stringify(bootstrapRun.toolNames)}`,
  )
  check(bootstrapRun.journalBefore === false, 'a new project has no iteration journal yet')
  check(bootstrapRun.firstArtifactAllowed === true, 'the first bootstrap artifact is writable')
  check(bootstrapRun.laterArtifactDenied === true, 'a later bootstrap artifact is refused')
  check(/bootstrap 1\/5/.test(bootstrapRun.denialNamesNextStep) && /\.agent\/project\.yaml/.test(bootstrapRun.denialNamesNextStep), `the refusal names the next step: ${String(bootstrapRun.denialNamesNextStep).slice(0, 200)}`)
  check(bootstrapRun.evidenceDenied === true, 'Evidence stays refused while the bootstrap window is open')

  check(bootstrapRun.resume?.ok === true && bootstrapRun.resume?.phase === 'bootstrap', `delivery_resume must answer with the lifecycle: ${JSON.stringify(bootstrapRun.resume)?.slice(0, 240)}`)
  check(bootstrapRun.resume?.bootstrap?.step === 'project_metadata', `the first step is the metadata: ${JSON.stringify(bootstrapRun.resume?.bootstrap?.step)}`)
  check(
    /delivery_iteration action=open/.test(String(bootstrapRun.resume?.next_actions?.[0] || '')),
    `the first next action records the requirement: ${JSON.stringify(bootstrapRun.resume?.next_actions)}`,
  )
  check(bootstrapRun.verifyLocal?.phase === 'bootstrap', `delivery_verify_local must explain the missing verifier: ${JSON.stringify(bootstrapRun.verifyLocal)?.slice(0, 200)}`)
  check(bootstrapRun.gaps?.phase === 'bootstrap', 'delivery_gaps must not report an unwritten Contract as a gap')
  check(bootstrapRun.shellCommands === 0, `no operation-pack script runs before a Contract exists, got ${bootstrapRun.shellCommands}`)

  check(bootstrapRun.iteration?.ok === true && bootstrapRun.iteration?.iteration?.id === 'IT-001', `the requirement is recorded first: ${JSON.stringify(bootstrapRun.iteration)?.slice(0, 240)}`)
  check(bootstrapRun.iteration?.iteration?.requirement === '第一条需求：Todo HTTP API', 'the requirement is journalled verbatim')
  check(bootstrapRun.iteration?.next_actions?.some((action) => /\.agent\/project\.yaml/.test(action)), 'recording the requirement names the artifact to create next')
  check(/IT-001/.test(bootstrapRun.journal || ''), 'IT-001 is in the append-only journal')
  check(
    bootstrapRun.afterMetadata?.bootstrap?.step === 'verifier_environment',
    `the summary follows the project within one session, got ${JSON.stringify(bootstrapRun.afterMetadata?.bootstrap?.step)}`,
  )
} else {
  process.stdout.write('note: no desktop installation found; the desktop-host case was not executed\n')
}

// A bare Node run reaches the CLI/web palette, which is a different prerelease line
// from the one this plugin declares. The plugin must then withhold its tools rather
// than register definitions that line compiled — the exact failure mode that killed a
// live session — and it must say so instead of failing silently.
const plain = runChild(process.execPath, { DSH_HOME: HARNESS_HOME, DSH_DELIVERY_DSH_TOOLS_DIR: '', DSH_PROFILE_DIR: '' })
check(plain.status === 0, `plain probe failed: ${plain.stderr?.slice(0, 300)}`)
const plainResult = JSON.parse(plain.stdout)
check(plainResult.desktopHost === false, 'a bare Node run is not the desktop host')
check(['profile', 'none'].includes(plainResult.kind), `plain node resolves from the palette or not at all, got ${plainResult.kind}`)
check(plainResult.verdict === 'refuse', `an off-line helper must refuse, got ${plainResult.verdict} (${plainResult.source})`)
check((plainResult.shapes || []).length === 0, 'and no tool schema is registered in that condition')

console.log(`host-resolution.test ok: ${checks} checks passed`)
