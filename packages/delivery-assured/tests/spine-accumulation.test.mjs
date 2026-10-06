#!/usr/bin/env node
/**
 * Regression Spine accumulation: `new_spine = old_spine ∪ newly_verified_cases`.
 *
 * The invariant this suite protects is the one a normal Agent-facing interface must
 * not be able to switch off:
 *
 *   a PASS on this candidate
 *   → every case it really verified belongs in the accumulated Spine
 *   → the next round has to re-verify all of them
 *
 * The escape hatch this suite exists to keep deleted is `--no-spine-accumulate`,
 * which used to be exposed as a `delivery_verify_independent` parameter. It is gone
 * from the tool surface, gone from the CLI option table, and rejected as an unknown
 * option — and a PASS that failed to leave the Spine grown is a verifier error, not
 * a warning.
 *
 * Run: node packages/delivery-assured/tests/spine-accumulation.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { accumulateSpine, porcelainPaths } from '../scripts/verify.mjs'
import {
  DRIVER,
  SLICE,
  cleanup,
  git,
  hostVerify,
  makeProject,
  manifestWith,
  packRoot,
  readSpine,
} from './helpers/host-project.mjs'

const verifySource = readFileSync(join(packRoot, 'scripts', 'verify.mjs'), 'utf8')

/** A Slice that claims only the first case, so the second can only come from the Spine. */
const SLICE_FIRST_ONLY = SLICE.replace(
  'obligations: [J-HELLO, J-HELLO.GREETED, C-ENTRY, BR-NO-LEAK]',
  'obligations: [J-HELLO, J-HELLO.GREETED, C-ENTRY]',
).replace('acceptance: [A-HELLO-001, A-HELLO-002]', 'acceptance: [A-HELLO-001]')

test('no Agent-facing or CLI switch can turn Spine accumulation off', () => {
  // The verifier's own option table must not have a Spine switch. A regex over the
  // whole option spec is stronger than naming one flag: any later spelling matches.
  const optionNames = [...verifySource.matchAll(/^\s{4}'?([a-z-]+)'?:\s*'boolean',/gm)].map((match) => match[1])
  assert.ok(optionNames.length > 0, 'the verifier option table was not found')
  assert.deepEqual(
    optionNames.filter((name) => /spine/i.test(name)),
    [],
    `no verifier option may address Spine accumulation, found: ${optionNames.join(', ')}`,
  )
  assert.ok(!/no-spine-accumulate/.test(verifySource), 'the verifier must not mention the removed flag at all')

  const { root } = makeProject()
  try {
    // Rejected as an unknown option (exit 2), before anything runs.
    const refused = hostVerify(root, ['--no-spine-accumulate'])
    assert.equal(refused.status, 2, refused.stdout + refused.stderr)
    assert.match(refused.stderr, /unknown option --no-spine-accumulate/)
    // Nothing was written: a refused invocation is not an attempt.
    assert.equal(readSpine(root).length, 0)
  } finally {
    cleanup(root)
  }
})

test('a PASS grows the Spine with exactly the cases it verified', () => {
  const { root } = makeProject()
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.spine_accretion.after, ['A-HELLO-001', 'A-HELLO-002'])
    assert.deepEqual(report.spine_accretion.added, ['A-HELLO-001', 'A-HELLO-002'])
    assert.deepEqual(readSpine(root), ['A-HELLO-001', 'A-HELLO-002'])
    // The record itself binds the pre-growth Spine, so the record that caused the
    // growth is not judged stale by its own effect.
    const evidence = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    assert.deepEqual(evidence.execution.spine.before, [])
    assert.deepEqual(evidence.execution.spine.after, ['A-HELLO-001', 'A-HELLO-002'])
    assert.deepEqual(evidence.spine_case_ids, [])
  } finally {
    cleanup(root)
  }
})

test('a case the previous round accumulated still has to run, even when the Slice no longer names it', () => {
  // This is what "PASS → the case stays required" means in practice: the second case
  // is nobody's Slice acceptance any more, and it still has to execute and pass.
  const { root } = makeProject({ slice: SLICE_FIRST_ONLY, spine: 'revision: 1\ncase_ids: ["A-HELLO-002"]\n' })
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.cases.required, 2, `the Spine case must be in the required set: ${JSON.stringify(report.cases)}`)
    assert.equal(report.cases.executed, 2, JSON.stringify(report.cases))
    assert.deepEqual(readSpine(root), ['A-HELLO-001', 'A-HELLO-002'])
  } finally {
    cleanup(root)
  }
})

test('a verification failure does not grow the Spine', () => {
  const { root, write } = makeProject()
  try {
    write('tests/acceptance/driver/index.mjs', DRIVER.replace("return { ok: false, message: 'request rejected' }", "throw new Error('driver broke')"))
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'candidate: break the driver'])
    const result = hostVerify(root)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.spine_accretion, null, 'a failing run must not report an accretion')
    assert.deepEqual(readSpine(root), [], 'a FAIL must leave the accumulated Spine exactly as it was')
  } finally {
    cleanup(root)
  }
})

test('accumulateSpine is monotonic: a lost case blocks instead of shrinking the Spine', () => {
  const { root } = makeProject()
  try {
    const context = { root, cfg: { paths: { spineManifest: 'tests/spine/manifest.yaml' } }, runId: 'unit', spineBefore: ['A-HELLO-001', 'A-HELLO-002'] }
    const result = accumulateSpine(context, { caseAccounting: { results: [{ case_id: 'A-HELLO-001', outcome: 'passed' }] } })
    assert.equal(result.ok, false)
    assert.match(result.problem, /A-HELLO-002.*did not pass/)
  } finally {
    cleanup(root)
  }
})

test('a Spine that did not actually grow is a verifier error, not a warning', () => {
  const { root, write } = makeProject()
  try {
    // The context claims a case was already accumulated, but the file on disk is empty.
    // No write happens (the union adds nothing), so only the post-condition can catch
    // that the PASS would otherwise be reported without its coverage being retained.
    write('tests/spine/manifest.yaml', 'revision: 1\ncase_ids: []\n')
    const context = { root, cfg: { paths: { spineManifest: 'tests/spine/manifest.yaml' } }, runId: 'unit', spineBefore: ['A-HELLO-001'] }
    const result = accumulateSpine(context, { caseAccounting: { results: [{ case_id: 'A-HELLO-001', outcome: 'passed' }] } })
    assert.equal(result.ok, false)
    assert.match(result.problem, /does not hold the verified case/)

    // A Spine path that cannot be written is refused rather than silently skipped.
    rmSync(join(root, 'tests', 'spine', 'manifest.yaml'), { force: true })
    mkdirSync(join(root, 'tests', 'spine', 'manifest.yaml'), { recursive: true })
    const blocked = accumulateSpine(
      { root, cfg: { paths: { spineManifest: 'tests/spine/manifest.yaml' } }, runId: 'unit', spineBefore: [] },
      { caseAccounting: { results: [{ case_id: 'A-HELLO-001', outcome: 'passed' }] } },
    )
    assert.equal(blocked.ok, false)
    assert.match(blocked.problem, /could not be written/)
  } finally {
    cleanup(root)
  }
})

test('the manifest helper and the porcelain reader agree with what the suite writes', () => {
  // Guards the fixture itself: a silent mismatch here would make the assertions above
  // pass against a manifest that declares something else.
  const manifest = manifestWith([
    { id: 'A-HELLO-001', obligation_ids: ['J-HELLO'], outcome_ids: ['J-HELLO.GREETED'], spec_ref: 'tests/acceptance/spec/A-HELLO-001.mjs' },
  ])
  assert.match(manifest, /- id: A-HELLO-001/)
  assert.match(manifest, /spec_ref: tests\/acceptance\/spec\/A-HELLO-001\.mjs/)
  assert.deepEqual(porcelainPaths(' M tests/spine/manifest.yaml\n'), ['tests/spine/manifest.yaml'])
})
