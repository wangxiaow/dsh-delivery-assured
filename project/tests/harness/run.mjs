#!/usr/bin/env node
/**
 * Acceptance harness.
 *
 * It loads the frozen spec files from `tests/acceptance/spec/`, runs each
 * declared case against the real system through the semantic driver, and writes
 * `results.json` for `scripts/verify.mjs` to validate.
 *
 * Accounting rules that keep a green run honest (v0.5 §5.4):
 *   - every `required` case is executed, in the manifest, and known to the harness
 *   - a case whose body returns `{ ok: false }` or throws records `failed`/`errored`
 *   - `--case` filtering is recorded in the report so `verify` can reject a
 *     filtered run as proof of the full set
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as driver from '../acceptance/driver/index.mjs'
import { readYaml, sha256 } from '../../../packages/delivery-assured/scripts/lib/common.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const specDir = join(here, '..', 'acceptance', 'spec')
const manifest = readYaml(join(specDir, 'manifest.yaml'))
const machineCases = (manifest.cases || []).filter(c => c.required === true && c.method === 'automated')
const CASE_FILES = [...new Set(machineCases.map(c => {
  const prefix = 'tests/acceptance/spec/'
  if (!c.spec_ref?.startsWith(prefix) || c.spec_ref.includes('..')) throw new Error(`invalid protected spec_ref ${c.spec_ref}`)
  return c.spec_ref.slice(prefix.length)
}))]

function parse(argv) {
  const opts = { out: join(here, '..', '..', '.agent', 'evidence', 'acceptance-results.json'), caseIds: [], quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--out') opts.out = argv[++i]
    else if (token === '--case') opts.caseIds.push(argv[++i])
    else if (token === '--quiet') opts.quiet = true
    else if (token === '--help') opts.help = true
    else throw new Error(`unknown harness option ${token}`)
  }
  return opts
}

async function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('run acceptance specs: node tests/harness/run.mjs [--out <file>] [--case <id>]...\n')
    return 0
  }

  const declared = []
  for (const file of CASE_FILES) {
    const module = await import(pathToFileURL(join(specDir, file)).href)
    if (typeof module.declareCases !== 'function') {
      throw new Error(`spec file ${file} does not export declareCases()`)
    }
    const cases = module.declareCases({ driver })
    for (const testCase of cases) declared.push({ file, ...testCase })
  }

  const allIds = declared.map(c => c.id)
  if (!allIds.length || new Set(allIds).size !== allIds.length || machineCases.some(c => !allIds.includes(c.id))) throw new Error('Required cases missing or duplicated in protected specs')
  const expectedIds = process.env.DSH_REQUIRED_CASE_IDS ? JSON.parse(process.env.DSH_REQUIRED_CASE_IDS) : machineCases.map(c => c.id)
  if (!Array.isArray(expectedIds) || !expectedIds.length || new Set(expectedIds).size !== expectedIds.length || expectedIds.some(id => !machineCases.some(c => c.id === id))) throw new Error('invalid frozen Required set')
  const selectedIds = opts.caseIds.length > 0 ? opts.caseIds : expectedIds
  if (selectedIds.some(id => !allIds.includes(id))) throw new Error('unknown selected case id')
  const selected = declared.filter(c => selectedIds.includes(c.id))
  const results = []
  for (const testCase of selected) {
    const started = Date.now()
    let outcome = 'passed'
    let message = ''
    try {
      const observation = await testCase.run({ driver })
      if (observation?.ok !== true) {
        outcome = 'failed'
        message = Array.isArray(observation?.failures) ? observation.failures.join('; ') : 'case returned no explicit successful observation'
      }
    } catch (error) {
      outcome = 'errored'
      message = String(error?.stack || error?.message || error)
    }
    const duration = Date.now() - started
    results.push({ case_id: testCase.id, outcome, duration_ms: duration, message })
    if (!opts.quiet) {
      const label = outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : 'ERROR'
      process.stdout.write(`${label} ${testCase.id} (${duration}ms)${message ? `\n     ${message}` : ''}\n`)
    }
  }

  const missing = expectedIds.filter(id => !results.some(r => r.case_id === id))
  const report = {
    run_token: process.env.DSH_VERIFICATION_RUN_TOKEN || null,
    candidate_revision: process.env.DSH_CANDIDATE || null,
    required_case_ids: expectedIds,
    case_set_digest: sha256(JSON.stringify([...expectedIds].sort())),
    spec_revision: manifest.revision,
    harness: 'tests/harness/run.mjs',
    spec_dir: 'tests/acceptance/spec',
    started_at: new Date().toISOString(),
    filter: opts.caseIds.length > 0 ? { case_ids: opts.caseIds } : null,
    timed_out: false,
    declared: declared.map((c) => c.id),
    not_run: missing,
    passed: results.filter((r) => r.outcome === 'passed').length,
    failed: results.filter((r) => r.outcome === 'failed' || r.outcome === 'errored').length,
    results,
  }
  mkdirSync(dirname(opts.out), { recursive: true })
  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (!opts.quiet) {
    process.stdout.write(
      `\n${report.passed} passed, ${report.failed} failed, ${missing.length} not run -> ${opts.out}\n`,
    )
  }
  return report.failed > 0 || missing.length > 0 ? 1 : 0
}

process.exitCode = await main()
