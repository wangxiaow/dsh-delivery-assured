#!/usr/bin/env node
/**
 * The finite Frozen TCB: a Candidate may not modify the logic that decides whether
 * the Candidate is Delivered and then use it to prove itself.
 *
 * What this suite pins down:
 *
 *   - ordinary business-code changes are allowed;
 *   - a frozen acceptance standard that moved is refused (STANDARD_DRIFT), as before;
 *   - a changed verifier Trusted Computing Base is refused (TCB_DRIFT) *before* a
 *     single gate runs, and the Freeze record itself carries `tcb_version`,
 *     `tcb_files` and `tcb_digest`;
 *   - a Candidate that edits the TCB *and* rewrites the digest file to match still
 *     fails: when the TCB lives inside the candidate's repository the comparison is
 *     against Git blob ids at the frozen revision, so a JSON file cannot move the
 *     anchor;
 *   - re-freezing a changed TCB requires an explicit control-plane authorization,
 *     which the agent-facing surface never passes.
 *
 * There is no verifier-of-the-verifier here and no recursion: the TCB is a named file
 * set with one digest, checked exactly once per verification.
 *
 * Run: node packages/delivery-assured/tests/frozen-tcb.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { TCB_FILES, TCB_VERSION, currentTcbDigests, tcbChangeAuthorization, tcbDigest, tcbFiles, verifyTcb } from '../scripts/lib/tcb.mjs'
import {
  MANIFEST,
  cleanup,
  git,
  hostVerify,
  makeProject,
  run,
  verifyScript,
} from './helpers/host-project.mjs'

/** A throwaway Git repository shaped like the pack's own, holding a few TCB members. */
function makeTcbRepo() {
  const root = mkdtempSync(join(tmpdir(), 'da-tcb-'))
  const members = TCB_FILES.filter((path) => /(lib\/(evidence|completion)|plugins\/dsh-delivery-assured\/lib\/host)\.(mjs|js)$/.test(path))
  assert.ok(members.length >= 2, `the TCB must name the deciding modules, got: ${TCB_FILES.join(', ')}`)
  for (const path of members) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, `export const version = 1 // ${path}\n`, 'utf8')
  }
  writeFileSync(join(root, 'product.mjs'), 'export const product = 1\n', 'utf8')
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'fixture@example.com'])
  git(root, ['config', 'user.name', 'fixture'])
  git(root, ['config', 'core.autocrlf', 'false'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'frozen verifier TCB'])
  const revision = git(root, ['rev-parse', 'HEAD']).trim()
  const files = currentTcbDigests(root)
  return { root, members, revision, files, record: { tcb_version: TCB_VERSION, tcb_files: files, tcb_digest: tcbDigest(files), frozen_revision: revision } }
}

const edit = (root, path, text) => writeFileSync(join(root, path), text, 'utf8')

test('verifyTcb accepts the frozen TCB and anchors it to the frozen revision', () => {
  const repo = makeTcbRepo()
  try {
    const result = verifyTcb(repo.record, { root: repo.root, projectRoot: repo.root, frozenRevision: repo.revision })
    assert.equal(result.ok, true, JSON.stringify(result.problems))
    assert.equal(result.git_checked, true)
    assert.equal(result.external, false)
    assert.equal(result.current_digest, repo.record.tcb_digest)
    // Ordinary product code is not part of the TCB: changing it is not drift.
    edit(repo.root, 'product.mjs', 'export const product = 2\n')
    assert.equal(verifyTcb(repo.record, { root: repo.root, projectRoot: repo.root, frozenRevision: repo.revision }).ok, true)
  } finally {
    rmSync(repo.root, { recursive: true, force: true })
  }
})

test('a changed TCB member is TCB_DRIFT even before it is committed', () => {
  const repo = makeTcbRepo()
  try {
    edit(repo.root, repo.members[0], 'export const version = 2 // weakened\n')
    const result = verifyTcb(repo.record, { root: repo.root, projectRoot: repo.root, frozenRevision: repo.revision })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.code === 'TCB_DRIFT'), JSON.stringify(result.problems))
  } finally {
    rmSync(repo.root, { recursive: true, force: true })
  }
})

test('a Candidate cannot legalize a changed TCB by rewriting the digest file, as long as the frozen revision stands', () => {
  const repo = makeTcbRepo()
  try {
    edit(repo.root, repo.members[0], 'export const version = 2 // weakened\n')
    // The naive forgery: update the recorded manifest and its digest so the freeze
    // record is self-consistent with the modified verifier.
    const forgedFiles = currentTcbDigests(repo.root)
    const forged = { ...repo.record, tcb_files: forgedFiles, tcb_digest: tcbDigest(forgedFiles) }
    const result = verifyTcb(forged, { root: repo.root, projectRoot: repo.root, frozenRevision: repo.revision })
    assert.equal(result.ok, false, 'a self-consistent rewritten digest must not make the verifier frozen')
    assert.ok(result.problems.some((problem) => problem.code === 'TCB_DRIFT'), JSON.stringify(result.problems))
    assert.ok(result.problems.some((problem) => /frozen revision/.test(problem.message)), JSON.stringify(result.problems))
  } finally {
    rmSync(repo.root, { recursive: true, force: true })
  }
})

/**
 * DOCUMENTED RESIDUAL, pinned so nobody mistakes it for protection.
 *
 * The Git anchor compares against `frozen_revision`, and `frozen_revision` lives in the
 * same freeze record a Candidate can write. A Candidate that edits a TCB member, commits
 * it, and then rewrites `tcb_files`/`tcb_digest`/`frozen_revision` together produces a
 * self-consistent record that a purely local reader cannot distinguish from a legitimate
 * freeze. This test asserts that limitation **on purpose**; the real anchor is external
 * (the trusted-CI backend stages `packages/` and `plugins/` from canonical, and the
 * protected refs forbid rewriting history). See docs/TCB.md "已知残余".
 */
test('DOCUMENTED RESIDUAL: a record that also rewrites frozen_revision is not distinguishable locally', () => {
  const repo = makeTcbRepo()
  try {
    edit(repo.root, repo.members[0], 'export const version = 2 // weakened\n')
    git(repo.root, ['add', '-A'])
    git(repo.root, ['commit', '-qm', 'candidate: weaken the verifier and commit it'])
    const head = git(repo.root, ['rev-parse', 'HEAD']).trim()
    const files = currentTcbDigests(repo.root)
    const forged = { tcb_version: TCB_VERSION, tcb_files: files, tcb_digest: tcbDigest(files), frozen_revision: head }
    const result = verifyTcb(forged, { root: repo.root, projectRoot: repo.root, frozenRevision: head })
    assert.equal(result.ok, true, `this is the documented residual, not a protection: ${JSON.stringify(result.problems)}`)
    assert.equal(result.git_checked, true)
  } finally {
    rmSync(repo.root, { recursive: true, force: true })
  }
})

test('a removed or newly added TCB member is drift, and a version change is drift', () => {
  const repo = makeTcbRepo()
  try {
    rmSync(join(repo.root, repo.members[0]), { force: true })
    const removed = verifyTcb(repo.record, { root: repo.root, projectRoot: repo.root, frozenRevision: repo.revision })
    assert.ok(removed.problems.some((problem) => problem.code === 'TCB_DRIFT'))

    const fresh = makeTcbRepo()
    try {
      // A file that TCB_FILES names but the frozen manifest did not record.
      const extra = TCB_FILES.find((path) => !fresh.members.includes(path))
      const absolute = join(fresh.root, extra)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, 'export const added = 1\n', 'utf8')
      const joined = verifyTcb(fresh.record, { root: fresh.root, projectRoot: fresh.root, frozenRevision: fresh.revision })
      assert.ok(joined.problems.some((problem) => problem.code === 'TCB_DRIFT' && /joined the verifier/.test(problem.message)), JSON.stringify(joined.problems))
    } finally {
      rmSync(fresh.root, { recursive: true, force: true })
    }

    const version = verifyTcb({ ...repo.record, tcb_version: TCB_VERSION + 1 }, { root: repo.root, current: repo.record.tcb_files })
    assert.ok(version.problems.some((problem) => problem.code === 'TCB_VERSION_MISMATCH'))
  } finally {
    rmSync(repo.root, { recursive: true, force: true })
  }
})

test('a freeze record with no TCB manifest, or one whose digest contradicts its own files, is refused', () => {
  const repo = makeTcbRepo()
  try {
    const missing = verifyTcb({ ...repo.record, tcb_files: undefined, tcb_digest: undefined }, { root: repo.root, current: repo.files })
    assert.equal(missing.ok, false)
    assert.equal(missing.problems[0].code, 'TCB_NOT_RECORDED')

    const tampered = verifyTcb({ ...repo.record, tcb_digest: 'f'.repeat(64) }, { root: repo.root, current: repo.files })
    assert.ok(tampered.problems.some((problem) => problem.code === 'TCB_RECORD_TAMPERED'), JSON.stringify(tampered.problems))
  } finally {
    rmSync(repo.root, { recursive: true, force: true })
  }
})

test('a TCB outside the candidate repository is reported as external rather than as proof', () => {
  const repo = makeTcbRepo()
  const other = mkdtempSync(join(tmpdir(), 'da-other-'))
  try {
    git(other, ['init', '-q'])
    git(other, ['config', 'user.email', 'fixture@example.com'])
    git(other, ['config', 'user.name', 'fixture'])
    git(other, ['config', 'core.autocrlf', 'false'])
    writeFileSync(join(other, 'x.mjs'), 'export const x = 1\n', 'utf8')
    git(other, ['add', '-A'])
    git(other, ['commit', '-qm', 'other'])
    const result = verifyTcb(repo.record, { root: repo.root, projectRoot: other, frozenRevision: git(other, ['rev-parse', 'HEAD']).trim() })
    assert.equal(result.git_checked, false)
    assert.equal(result.external, true)
    // The recorded digest is still compared, so an out-of-band pack upgrade is caught.
    edit(repo.root, repo.members[0], 'export const version = 9\n')
    assert.equal(verifyTcb(repo.record, { root: repo.root, projectRoot: other, frozenRevision: null }).ok, false)
  } finally {
    rmSync(repo.root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('re-recording a changed TCB needs an explicit control-plane authorization', () => {
  const next = { tcb_digest: 'a'.repeat(64) }
  assert.equal(tcbChangeAuthorization(null, next).ok, true)
  assert.equal(tcbChangeAuthorization({ tcb_digest: null }, next).ok, true, 'a legacy record is a schema upgrade')
  assert.equal(tcbChangeAuthorization({ tcb_digest: 'a'.repeat(64) }, next).ok, true, 'an unchanged TCB is fine')
  const refused = tcbChangeAuthorization({ tcb_digest: 'b'.repeat(64) }, next)
  assert.equal(refused.ok, false)
  assert.match(refused.problem, /^TCB_CHANGE_REQUIRES_CONTROL_PLANE/)
  assert.equal(tcbChangeAuthorization({ tcb_digest: 'b'.repeat(64) }, next, { allowTcbChange: true }).ok, true)
})

/* ----------------------------------------------------------------- integration */

test('a frozen standard anchors the verifier TCB and reports it in the record', () => {
  const { root } = makeProject()
  try {
    const freeze = JSON.parse(readFileSync(join(root, '.agent', 'standards', 'FREEZE.json'), 'utf8'))
    assert.equal(freeze.tcb_version, TCB_VERSION)
    assert.equal(freeze.tcb_digest, tcbDigest(freeze.tcb_files))
    assert.deepEqual(Object.keys(freeze.tcb_files).sort(), tcbFiles().sort())
    assert.equal(freeze.previous_tcb_digest, null)

    const result = hostVerify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.tcb.version, TCB_VERSION)
    assert.equal(report.tcb.digest, freeze.tcb_digest)
    const evidence = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    assert.equal(evidence.standards.tcb_digest, freeze.tcb_digest)
    assert.equal(evidence.standards.tcb_git_checked, false, 'the pack is outside this fixture repository')

    // Ordinary business code changes are still allowed.
    writeFileSync(join(root, 'src', 'app.mjs'), 'export const app = 2\n', 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'candidate: change product code only'])
    const again = hostVerify(root)
    assert.equal(again.status, 0, again.stderr || again.stdout)
  } finally {
    cleanup(root)
  }
})

test('a moved frozen acceptance standard is still STANDARD_DRIFT, and a rewritten TCB digest does not help', () => {
  const { root, write } = makeProject()
  try {
    // 1. The frozen acceptance standard moved.
    write('tests/acceptance/spec/manifest.yaml', MANIFEST.replace(/  - id: A-HELLO-002\n(?:    .*\n)+/, ''))
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'candidate: drop a required case'])
    const drifted = hostVerify(root)
    assert.equal(drifted.status, 1, drifted.stdout + drifted.stderr)
    assert.match(drifted.stderr, /STANDARD_DRIFT/)
  } finally {
    cleanup(root)
  }

  const second = makeProject()
  try {
    // 2. The freeze record is rewritten so it no longer describes the TCB that is
    //    actually running. A Candidate can edit this file; the check still refuses.
    const freezePath = join(second.root, '.agent', 'standards', 'FREEZE.json')
    const freeze = JSON.parse(readFileSync(freezePath, 'utf8'))
    const forged = { ...freeze, tcb_files: { ...freeze.tcb_files }, tcb_digest: 'f'.repeat(64) }
    writeFileSync(freezePath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8')
    const tampered = hostVerify(second.root)
    assert.equal(tampered.status, 1, tampered.stdout + tampered.stderr)
    assert.match(tampered.stderr, /TCB_RECORD_TAMPERED|TCB_DRIFT/)
    assert.equal(readFileSync(join(second.root, 'tests', 'spine', 'manifest.yaml'), 'utf8').includes('A-HELLO'), false, 'nothing was recorded for a drifted verifier')

    // 3. A record made self-consistent with a *different* TCB is still drift: the
    //    recorded digests do not describe the verifier that is running.
    const consistent = { ...freeze, tcb_files: Object.fromEntries(Object.keys(freeze.tcb_files).map((path) => [path, 'a'.repeat(64)])) }
    consistent.tcb_digest = tcbDigest(consistent.tcb_files)
    writeFileSync(freezePath, `${JSON.stringify(consistent, null, 2)}\n`, 'utf8')
    const drifted = hostVerify(second.root)
    assert.equal(drifted.status, 1, drifted.stdout + drifted.stderr)
    assert.match(drifted.stderr, /TCB_DRIFT/)

    // 4. Removing the anchoring fields is refused rather than treated as "no TCB".
    writeFileSync(freezePath, `${JSON.stringify({ ...freeze, tcb_files: undefined, tcb_digest: undefined, tcb_version: undefined }, null, 2)}\n`, 'utf8')
    const unanchored = hostVerify(second.root)
    assert.equal(unanchored.status, 1, unanchored.stdout + unanchored.stderr)
    assert.match(unanchored.stderr, /TCB_NOT_RECORDED/)
  } finally {
    cleanup(second.root)
  }
})

test('re-freezing the standard is still possible while the verifier TCB is unchanged', () => {
  const { root } = makeProject()
  try {
    const frozen = run([verifyScript, '--project', root, '--freeze-standard', '--allow-standard-change', '--standard-change-reason', 'fixture: legitimate standard change', '--json'], root)
    assert.equal(frozen.status, 0, frozen.stderr || frozen.stdout)
    const record = JSON.parse(readFileSync(join(root, '.agent', 'standards', 'FREEZE.json'), 'utf8'))
    assert.equal(record.previous_tcb_digest, tcbDigest(record.tcb_files))
    assert.equal(record.history.length, 1)
    assert.equal(record.history[0].from_tcb_digest, record.tcb_digest)
    assert.equal(record.history[0].to_tcb_digest, record.tcb_digest)
    // The control-plane flag is not on the agent-facing surface, but it exists for the
    // documented maintenance flow.
    assert.equal(run([verifyScript, '--project', root, '--freeze-standard', '--allow-standard-change', '--allow-tcb-change', '--json'], root).status, 0)
  } finally {
    cleanup(root)
  }
})

test('the verifier refuses an unknown option rather than accepting an undeclared one', () => {
  // A guard on the control-plane boundary itself: the only way to authorize a TCB
  // change is the explicit flag above, and the CLI rejects everything else.
  const { root } = makeProject()
  try {
    const refused = run([verifyScript, '--project', root, '--freeze-standard', '--freeze-tcb', '--json'], root)
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /unknown option --freeze-tcb/)
  } finally {
    cleanup(root)
  }
})

test('the TCB set is finite, named, and contains no environment or test file', () => {
  assert.ok(TCB_FILES.length > 0 && TCB_FILES.length <= 26, `the TCB must stay small: ${TCB_FILES.length} entries`)
  for (const path of TCB_FILES) {
    assert.match(path, /^(packages|plugins)\//, `${path} must belong to the shipped pack`)
    assert.ok(!/test|spec|\.test\./.test(path), `${path} must not be a test file`)
  }
  // Every module that decides a verdict, or the facts a verdict is computed from, must
  // be a member — a deciding module left out is a hole the digest cannot see.
  for (const required of [
    'scripts/verify.mjs',
    'scripts/resume.mjs',
    'lib/yaml.mjs',
    'lib/evidence.mjs',
    'lib/model.mjs',
    'lib/selection.mjs',
    'lib/completion.mjs',
    'lib/capability.mjs',
    'lib/convergence.mjs',
    'lib/mvp.mjs',
    'lib/standard-freeze.mjs',
    'lib/verification.mjs',
    'lib/state-view.mjs',
    'lib/tcb.mjs',
    'lib/host.js',
    'lib/tool-surface.js',
  ]) {
    assert.ok(
      TCB_FILES.some((path) => path.endsWith(required)),
      `${required} decides a verdict (or the facts it is computed from) and must be in the TCB`,
    )
  }
})
