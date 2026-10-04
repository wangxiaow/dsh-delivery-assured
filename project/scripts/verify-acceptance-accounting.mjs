#!/usr/bin/env node
/**
 * Gate 4 — Slice Acceptance accounting.
 *
 * A green harness run is not enough. This gate compares the executed set against
 * the frozen manifest, the accumulated Spine and the parent check, and refuses to
 * pass when a required case is missing, skipped, duplicated or replaced by the
 * wrong test set (v0.5 §5.4, appendix C).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAcceptance, loadSpine } from '../../packages/delivery-assured/scripts/lib/index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

const resultsPath = join(root, '.agent', 'evidence', 'acceptance-results.json')
if (!existsSync(resultsPath)) {
  process.stderr.write(`verify-acceptance-accounting: ${resultsPath} is missing; the harness did not run\n`)
  process.exit(1)
}
const report = JSON.parse(readFileSync(resultsPath, 'utf8'))
const cfg = { paths: { acceptanceManifest: 'tests/acceptance/spec/manifest.yaml', spineManifest: 'tests/spine/manifest.yaml' } }
const acceptance = loadAcceptance(root, cfg)
const spine = loadSpine(root, cfg)
const manifest = acceptance.manifest || {}

if (report.filter) {
  failures.push(`the harness ran with a filter (${JSON.stringify(report.filter)}); a filtered run cannot prove the full set`)
}
if (report.timed_out) failures.push('the harness reported a timeout; a partial run is not a pass')
if (Array.isArray(report.not_run) && report.not_run.length > 0) {
  failures.push(`declared cases were never executed: ${report.not_run.join(', ')}`)
}

const declared = new Set(report.declared || [])
const results = Array.isArray(report.results) ? report.results : []
const byId = new Map()
for (const entry of results) {
  if (byId.has(entry.case_id)) failures.push(`case ${entry.case_id} produced more than one result`)
  byId.set(entry.case_id, entry)
}

const requiredCases = process.env.DSH_REQUIRED_CASE_IDS
  ? JSON.parse(process.env.DSH_REQUIRED_CASE_IDS)
  : acceptance.cases.filter(c => c.required === true && c.method === 'automated').map(c => c.id)
if (!Array.isArray(requiredCases) || !requiredCases.length || new Set(requiredCases).size !== requiredCases.length) failures.push('Required case set is empty or duplicated')
if (process.env.DSH_VERIFICATION_RUN_TOKEN && report.run_token !== process.env.DSH_VERIFICATION_RUN_TOKEN) failures.push('results belong to another verification invocation')
for (const caseId of requiredCases) {
  if (!declared.has(caseId)) failures.push(`required case ${caseId} is not declared by any spec file`)
  const entry = byId.get(caseId)
  if (!entry) {
    failures.push(`required case ${caseId} produced no result: zero tests or a missing case is never a pass`)
    continue
  }
  if (entry.outcome === 'skipped' || entry.outcome === 'not_run') failures.push(`required case ${caseId} was ${entry.outcome}`)
  else if (entry.outcome !== 'passed') failures.push(`required case ${caseId} recorded ${entry.outcome}: ${entry.message || ''}`)
}

for (const caseId of spine.caseIds) {
  const entry = byId.get(caseId)
  if (!entry) failures.push(`spine case ${caseId} produced no result`)
  else if (entry.outcome !== 'passed') failures.push(`spine case ${caseId} recorded ${entry.outcome}`)
}

const known = new Set([...requiredCases, ...spine.caseIds])
for (const entry of results) {
  if (!known.has(entry.case_id)) {
    failures.push(`case ${entry.case_id} ran but is neither in the manifest nor in the spine`)
  }
}

// Every required case must carry the metadata the Contract expects.
for (const testCase of acceptance.cases) {
  if (testCase.required !== true) continue
  for (const field of ['obligation_ids', 'spec_ref', 'method']) {
    if (!testCase[field] || (Array.isArray(testCase[field]) && testCase[field].length === 0)) {
      failures.push(`required case ${testCase.id} is missing manifest field ${field}`)
    }
  }
}

if (manifest.protected_revision && /^</.test(String(manifest.protected_revision))) {
  notes.push('manifest.protected_revision is still a placeholder; only the standard-update job may freeze it')
}

for (const note of notes) process.stdout.write(`note: ${note}\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`ACCEPTANCE FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(
  `acceptance accounting ok: ${requiredCases.length} required case(s) executed and passed, ${spine.caseIds.length} spine case(s) passed\n`,
)
process.exit(0)
