#!/usr/bin/env node
/**
 * Gate 5 — Regression Spine.
 *
 * Every case id accumulated in the parent Baseline's Spine must run again on this
 * candidate and pass. Two rules keep this honest:
 *   - the Spine may only grow: dropping an id needs the owner's confirmation
 *   - the Spine references the existing specs directly, so no assertions are copied
 *
 * The parent Spine is read from `DSH_PARENT_SPINE` (a file path produced by the
 * verification job from the parent Baseline). Without it this gate still verifies
 * the local Spine and says so.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAcceptance, loadSpine } from '../../packages/delivery-assured/scripts/lib/index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []
const cfg = { paths: { acceptanceManifest: 'tests/acceptance/spec/manifest.yaml', spineManifest: 'tests/spine/manifest.yaml' } }
const acceptance = loadAcceptance(root, cfg)
const spine = loadSpine(root, cfg)

// 1. Every spine id must still exist as a real case in the frozen manifest.
for (const caseId of spine.caseIds) {
  if (!acceptance.cases.some((c) => c.id === caseId)) {
    failures.push(`spine case ${caseId} no longer exists in the acceptance manifest (removing a verified case needs owner confirmation)`)
  }
}

// 2. The parent Baseline's Spine must be preserved, never shrunk.
const parentSpinePath = process.env.DSH_PARENT_SPINE
let parentSpine = []
if (parentSpinePath) {
  if (!existsSync(parentSpinePath)) {
    failures.push(`DSH_PARENT_SPINE points at ${parentSpinePath} which does not exist`)
  } else {
    const doc = JSON.parse(readFileSync(parentSpinePath, 'utf8'))
    parentSpine = Array.isArray(doc) ? doc : doc.case_ids || []
  }
} else {
  notes.push('DSH_PARENT_SPINE was not provided: the parent Baseline Spine could not be compared (local diagnostic)')
}
const current = new Set(spine.caseIds)
for (const caseId of parentSpine) {
  if (!current.has(caseId)) {
    failures.push(`parent spine case ${caseId} disappeared from the current spine; verified capability cannot be dropped silently`)
  }
}

// 3. The executed set must contain every spine case and all of them must pass.
const resultsPath = join(root, '.agent', 'evidence', 'acceptance-results.json')
if (spine.caseIds.length > 0) {
  if (!existsSync(resultsPath)) {
    failures.push('the acceptance result file is missing, so no spine case can be shown to pass')
  } else {
    const report = JSON.parse(readFileSync(resultsPath, 'utf8'))
    const byId = new Map((report.results || []).map((r) => [r.case_id, r]))
    for (const caseId of new Set([...spine.caseIds, ...parentSpine])) {
      const entry = byId.get(caseId)
      if (!entry) failures.push(`spine case ${caseId} was not executed in this run`)
      else if (entry.outcome !== 'passed') failures.push(`spine case ${caseId} recorded ${entry.outcome}`)
    }
  }
} else {
  notes.push('the accumulated spine is empty: this is the first verification pass, so the full required set stands in for it')
}

for (const note of notes) process.stdout.write(`note: ${note}\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`SPINE FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`regression spine ok: ${spine.caseIds.length} accumulated case(s) verified, parent spine preserved\n`)
process.exit(0)
