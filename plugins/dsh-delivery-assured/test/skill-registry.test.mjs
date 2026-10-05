#!/usr/bin/env node
/**
 * Verify the plugin's runtime skill against the real DSH skill registry.
 *
 * The smoke test asserts the shape of the registered payload. This test closes the
 * remaining distance by driving the plugin's own `apply` and then reading the skill
 * back through DSH's real `SkillRegistry`: `get()` re-validates the definition, so a
 * missing or misnamed body field fails here rather than silently registering a skill
 * that loads nothing.
 *
 * `@deepseek-ai/cordis` and `@deepseek-ai/dsh-skill` are DSH-side packages, so this
 * test needs a profile's module resolution. Set `DSH_HOME` to a harness home whose
 * `profiles` directory holds those packages; the test also tries the ordinary module
 * search path. It fails loudly rather than skipping — a skipped check here would let
 * a broken skill ship.
 *
 * Run: node plugins/dsh-delivery-assured/test/skill-registry.test.mjs
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

/** Resolve a bare specifier from each candidate root until one works. */
async function importFromCandidates(specifier, roots) {
  const attempts = []
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    try {
      const require = createRequire(pathToFileURL(join(root, 'noop.cjs')).href)
      const resolved = require.resolve(specifier)
      return { module: await import(pathToFileURL(resolved).href), from: resolved }
    } catch (error) {
      attempts.push(`${root}: ${error.code || error.message}`)
    }
  }
  return { module: null, attempts }
}

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const candidateRoots = [
  join(dshHome, 'profiles', 'node_modules'),
  process.cwd(),
  pluginRoot,
]

const cordis = await importFromCandidates('@deepseek-ai/cordis', candidateRoots)
const skillPkg = await importFromCandidates('@deepseek-ai/dsh-skill', candidateRoots)

if (!cordis.module || !skillPkg.module) {
  process.stderr.write(
    'skill-registry.test: cannot resolve the DSH-side packages needed to verify the skill.\n' +
      `  @deepseek-ai/cordis     : ${cordis.module ? 'ok' : `unresolved (${cordis.attempts.join(' | ')})`}\n` +
      `  @deepseek-ai/dsh-skill  : ${skillPkg.module ? 'ok' : `unresolved (${skillPkg.attempts.join(' | ')})`}\n` +
      '  Set DSH_HOME to a harness home whose profiles directory holds the DSH packages.\n',
  )
  process.exit(2)
}
check('resolved the real Cordis Context', typeof cordis.module.Context === 'function', cordis.from)
check('resolved the real SkillRegistry', typeof skillPkg.module.SkillRegistry === 'function', skillPkg.from)

const entry = await import(new URL('../lib/index.js', import.meta.url).href)

// A real Cordis Context gives the registry the layer plumbing it needs.
const ctx = new cordis.module.Context()
const warnings = []
ctx.logger = {
  info: () => {},
  warn: (...args) => warnings.push(String(args[0])),
  error: (...args) => warnings.push(`error: ${String(args[0])}`),
  debug: () => {},
}

const registry = new skillPkg.module.SkillRegistry(ctx, {})

// Mount the plugin with a stub tools service so the test does not need a session.
const registeredTools = []
entry.apply(
  {
    tools: { register: (tool) => registeredTools.push(tool) },
    skills: registry,
    shell: { resolve: (r) => r, run: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) },
    effect: (fn) => fn(),
    logger: ctx.logger,
  },
  { packRoot: join(dirname(pluginRoot), 'packages', 'delivery-assured'), projectRoot: join(dirname(pluginRoot), 'project') },
)

const defineToolModule = await import(new URL('../lib/define-tool.js', import.meta.url).href)
const verdict = defineToolModule.defineToolVerdict
if (verdict === 'ok') {
  check('the plugin registered its six tools', registeredTools.length === 6, String(registeredTools.length))
} else {
  // This suite runs against whichever palette it can resolve, which may be a different
  // prerelease line; the contract then is to withhold every tool, loudly. Tool
  // behaviour under the real host is asserted by host-resolution.test.mjs.
  check('an off-line helper withholds every tool', registeredTools.length === 0, String(registeredTools.length))
  check('and says why', warnings.some((w) => /NOT registering tools/.test(w)), warnings.join(' | ').slice(0, 160))
}

const listed = await registry.list({})
const names = (Array.isArray(listed) ? listed : []).map((s) => s.name)
check('the registry lists the plugin skill', names.includes('delivery-assured'), names.join(', '))

const loaded = await registry.get('delivery-assured', {})
check('the registry loads the plugin skill', loaded !== undefined, 'get() returned undefined')
check('the loaded skill keeps the registered name', loaded?.name === 'delivery-assured', String(loaded?.name))
check('the loaded skill resolves through the runtime provider', loaded?.provider === 'runtime', String(loaded?.provider))
check(
  'the loaded skill carries a real body',
  typeof loaded?.content === 'string' && loaded.content.length > 500,
  `content length ${loaded?.content?.length ?? 'missing'}`,
)
check(
  'the body documents the authority boundary',
  /independent execution of the frozen Required acceptance/i.test(loaded?.content || '') &&
    /default backend is the DSH host/i.test(loaded?.content || '') &&
    /optional\s+high-assurance backend/i.test(loaded?.content || ''),
)
check(
  // The contract change to independent_auto removed the fixed human touchpoints; the
  // body must now carry the successor rule, not the retired one. Asserting the new
  // rule is the point: a body that silently kept the old gate would fail here.
  'the body documents the automatic-acceptance default',
  /`independent_auto`/.test(loaded?.content || '') &&
    /No owner comment, no hand-edited receipt/.test(loaded?.content || '') &&
    !/Unknowns Gate/.test(loaded?.content || ''),
)
check('the loaded skill keeps whenToUse', typeof loaded?.whenToUse === 'string' && loaded.whenToUse.length > 20)
check(
  'no registry warning was raised for the skill',
  !warnings.some((w) => !/NOT registering tools/.test(w)),
  warnings.join(' | ').slice(0, 200),
)

// Negative control: a definition without a body must be rejected by the same path,
// which proves the check above is actually exercised.
registry.register({ name: 'probe-no-body', description: 'no body', source: 'test' })
let rejected = false
try {
  await registry.get('probe-no-body', {})
} catch (error) {
  rejected = /content must be a string/.test(String(error?.message || ''))
}
check('the registry rejects a skill with no body', rejected)

if (failures.length > 0) {
  process.stderr.write(`skill-registry.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`skill-registry.test ok: ${passed} checks passed (registry from ${dirname(skillPkg.from)})\n`)
process.exit(0)
