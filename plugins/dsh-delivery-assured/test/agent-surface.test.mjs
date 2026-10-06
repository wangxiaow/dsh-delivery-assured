#!/usr/bin/env node
/**
 * The agent-facing tool surface, audited as data.
 *
 * `tool-surface.js` holds every parameter schema DSH projects to the model provider,
 * and `host.js` registers those exact objects. That makes "which switches a session
 * can reach" a fact this suite can assert without a hosting runtime — which is why
 * `no-spine-accumulate` had to be deleted rather than hidden behind a default.
 *
 * The invariant: a parameter that can weaken the verdict a Candidate is judged by
 * (the Required set, the regression Spine, evidence validity, backend authority, the
 * Delivered predicate, the frozen TCB) does not belong on this surface.
 *
 * Run: node plugins/dsh-delivery-assured/test/agent-surface.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENT_TOOL_NAMES, TOOL_PARAMETERS, forbiddenParameters } from '../lib/tool-surface.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const pluginLib = join(here, '..', 'lib')

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

check('every registered tool has a parameter schema', AGENT_TOOL_NAMES.length === 8, AGENT_TOOL_NAMES.join(', '))
for (const name of AGENT_TOOL_NAMES) {
  const parameters = TOOL_PARAMETERS[name]
  check(`${name} declares an object-rooted schema`, parameters && typeof parameters === 'object' && !Array.isArray(parameters))
}

// 1. The audit itself is not vacuous: it finds a planted escape hatch.
const planted = forbiddenParameters({ delivery_verify_independent: { 'no-spine-accumulate': { type: 'boolean' } } })
check('the audit finds a planted spine switch', planted.length === 1 && planted[0].parameter === 'no-spine-accumulate', JSON.stringify(planted))
const plantedTcb = forbiddenParameters({ delivery_verify_independent: { tcb_digest: { type: 'string' } } })
check('the audit finds a planted TCB switch', plantedTcb.length === 1 && plantedTcb[0].parameter === 'tcb_digest', JSON.stringify(plantedTcb))

// 2. No real parameter reaches any of those switches.
check('no agent-facing parameter addresses the verdict', forbiddenParameters().length === 0, JSON.stringify(forbiddenParameters()))

// 3. The completion entry point declares exactly the inputs a Candidate may hold.
const expectedVerifyParameters = ['allow_standard_change', 'freeze_standard', 'hypothesis', 'parent_baseline', 'slice', 'standard_change_reason']
check(
  'delivery_verify_independent declares no more than its audited inputs',
  JSON.stringify(Object.keys(TOOL_PARAMETERS.delivery_verify_independent).sort()) === JSON.stringify(expectedVerifyParameters),
  Object.keys(TOOL_PARAMETERS.delivery_verify_independent).join(', '),
)

// 4. The launcher forwards no argument that could suppress Spine accumulation, and
//    the verifier's own CLI has no such option (asserted again in the pack suite).
const hostSource = readFileSync(join(pluginLib, 'host.js'), 'utf8')
check('the launcher never passes a spine-suppressing flag', !/--no-spine/i.test(hostSource))
check('the launcher does not reference the removed parameter', !/no-spine-accumulate/.test(hostSource))
check('the launcher builds its parameter schemas from the audited surface', /TOOL_PARAMETERS/.test(hostSource))

const verifySource = readFileSync(join(repoRoot, 'packages', 'delivery-assured', 'scripts', 'verify.mjs'), 'utf8')
check('the verifier CLI has no spine switch', !/no-spine-accumulate/.test(verifySource))

// 5. The default completion path must not expose a way to authorise a TCB change:
//    that belongs to the control-plane maintenance flow (docs/TCB.md).
check('no agent-facing parameter authorises a TCB change', !/allow[_-]tcb[_-]change/i.test(JSON.stringify(TOOL_PARAMETERS)))

if (failures.length > 0) {
  process.stderr.write(`agent-surface.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`agent-surface.test ok: ${passed} checks passed\n`)
