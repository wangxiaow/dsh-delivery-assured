#!/usr/bin/env node
/**
 * Read-only durable-state overlay: scope enforcement, fail-closed behaviour, and a real
 * Git rehearsal.
 *
 * The point of the module is that a session can read the Baseline, Evidence, attempt
 * ledger and accumulated Spine the platform holds without CI staging them into the
 * project. Two properties matter enough to pin: an unreadable state is reported rather
 * than treated as "nothing owed", and nothing outside the state scopes is ever read or
 * written.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_SCOPES, completeFromFallback, fetchDurableState, inStateScope } from '../scripts/lib/durable-state.mjs'

const run = (cwd, args, options = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...options }).trim()

function write(root, relative, content) {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/** A working repository with a real `origin`, because the state is read off a remote ref. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'durable-state-'))
  const root = join(base, 'repo')
  const bare = join(base, 'origin.git')
  mkdirSync(root)
  mkdirSync(bare)
  run(bare, ['init', '--quiet', '--bare'])
  run(root, ['init', '--quiet', '-b', 'main'])
  run(root, ['config', 'user.name', 'Fixture'])
  run(root, ['config', 'user.email', 'fixture@example.invalid'])
  run(root, ['remote', 'add', 'origin', bare])
  return { base, root, bare }
}

function commitAll(root, message) {
  run(root, ['add', '-A'])
  run(root, ['commit', '--quiet', '--allow-empty', '-m', message])
}

function publish(root, ref) {
  run(root, ['push', '--quiet', '--force', 'origin', `HEAD:${ref}`])
}

/**
 * Build the state ref the way the recorder does: an index with no parent tree, holding
 * only the state paths. Branching off `main` would drag candidate material into the state
 * tree, which is exactly what the scope check exists to catch.
 */
function publishStateRef(root, base, files, message) {
  const index = join(base, `state-index-${String(Math.random()).slice(2)}`)
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'State',
    GIT_AUTHOR_EMAIL: 'state@example.invalid',
    GIT_COMMITTER_NAME: 'State',
    GIT_COMMITTER_EMAIL: 'state@example.invalid',
  }
  const plumbing = (args, input) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, input }).trim()
  plumbing(['read-tree', '--empty'])
  for (const [path, content] of Object.entries(files)) {
    const blob = plumbing(['hash-object', '-w', '--stdin'], content)
    plumbing(['update-index', '--add', '--cacheinfo', '100644', blob, path])
  }
  const commit = plumbing(['commit-tree', plumbing(['write-tree']), '-m', message])
  run(root, ['update-ref', 'refs/heads/delivery-state/main', commit])
  run(root, ['push', '--quiet', '--force', 'origin', 'refs/heads/delivery-state/main:refs/heads/delivery-state/main'])
  rmSync(index, { force: true })
  return commit
}

test('scopes are exact: state files and the three state trees, nothing else', () => {
  for (const allowed of [
    '.agent/attempts.jsonl',
    '.agent/reviews.yaml',
    '.agent/STANDARD_CHANGES.yaml',
    'ci/mvp-ready.json',
    'tests/spine/manifest.yaml',
    'ci/evidence/a.json',
    'ci/baseline/BL-000.json',
    'ci/recording/receipts/1-1.json',
    'ci/evidence', // the tree root itself is a state scope, as in ci-state-snapshot
  ]) assert.equal(inStateScope(allowed), true, allowed)

  for (const refused of [
    '.agent/CONTRACT.yaml', // the Contract is candidate material, not state
    'ci/verifier.yaml',
    'src/cli.mjs',
    '../ci/evidence/a.json',
    'ci/evidence/../../secrets',
    '/ci/evidence/a.json',
    'ci\\evidence\\a.json',
    'ci/evidence/C:evil',
    'ci/baseline/con.json',
    'ci/evidence/',
    '',
    null,
    'ci/recordingx/a.json',
  ]) assert.equal(inStateScope(refused), false, JSON.stringify(refused))

  assert.ok(STATE_SCOPES.includes('ci/evidence'))
})

test('an unreadable state ref is reported, never degraded to an empty ledger', () => {
  const { base, root } = fixture()
  try {
    write(root, 'project/.agent/attempts.jsonl', '')
    commitAll(root, 'project')

    const missing = fetchDurableState({ repoRoot: join(root, 'project') })
    assert.equal(missing.available, false)
    assert.match(missing.reason, /not readable on origin/)
    assert.equal(missing.sha, null)
    assert.equal(missing.root, null)
    missing.dispose()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the overlay reads only in-scope state out of a real branch, and writes nothing', () => {
  const { base, root } = fixture()
  try {
    write(root, 'project/.agent/CONTRACT.yaml', 'version: 4\n')
    write(root, 'project/.agent/attempts.jsonl', '')
    write(root, 'project/.agent/STANDARD_CHANGES.yaml', 'changes: []\n')
    write(root, 'project/src/cli.mjs', '// candidate material\n')
    commitAll(root, 'candidate')
    publish(root, 'refs/heads/main')

    // A state tree that carries something it must not.
    publishStateRef(root, base, {
      'project/.agent/attempts.jsonl': '{"attempt_id":"ci:verify:1-1"}\n',
      'project/src/cli.mjs': '// state must not be allowed to carry source\n',
    }, 'out of scope')
    const refused = fetchDurableState({ repoRoot: join(root, 'project') })
    assert.equal(refused.available, false)
    assert.match(refused.reason, /outside the durable-state scopes/)
    refused.dispose()

    // The real shape: only state scopes.
    const sha = publishStateRef(root, base, {
      'project/.agent/attempts.jsonl': '{"attempt_id":"ci:verify:1-1"}\n',
      'project/ci/baseline/BL-000.json': '{"baseline_id":"BL-000"}\n',
      'project/tests/spine/manifest.yaml': 'case_ids: ["A-ONE"]\n',
    }, 'state')

    const before = readFileSync(join(root, 'project', '.agent', 'attempts.jsonl'), 'utf8')
    const overlay = fetchDurableState({ repoRoot: join(root, 'project') })
    assert.equal(overlay.available, true, overlay.reason)
    assert.equal(overlay.sha, sha)
    assert.deepEqual(overlay.scopes, ['.agent/attempts.jsonl', 'ci/baseline/BL-000.json', 'tests/spine/manifest.yaml'].sort())
    assert.match(readFileSync(join(overlay.root, '.agent', 'attempts.jsonl'), 'utf8'), /ci:verify:1-1/)
    assert.match(readFileSync(join(overlay.root, 'ci', 'baseline', 'BL-000.json'), 'utf8'), /BL-000/)
    assert.match(readFileSync(join(overlay.root, 'tests', 'spine', 'manifest.yaml'), 'utf8'), /A-ONE/)
    assert.equal(existsSync(join(overlay.root, 'src')), false, 'the overlay must not carry candidate material')

    // The state branch wins where it carries a scope; the candidate's own copy fills the
    // rest, exactly like CI extracting the archive over a staged tree.
    const filled = fetchDurableState({ repoRoot: join(root, 'project'), fallbackRoot: join(root, 'project') })
    assert.equal(filled.available, true, filled.reason)
    assert.match(readFileSync(join(filled.root, '.agent', 'attempts.jsonl'), 'utf8'), /ci:verify:1-1/, 'state wins')
    assert.match(readFileSync(join(filled.root, '.agent', 'STANDARD_CHANGES.yaml'), 'utf8'), /changes/, 'fill comes from the fallback')
    assert.equal(existsSync(join(filled.root, '.agent', 'CONTRACT.yaml')), false, 'the Contract is never taken from the state overlay')
    assert.equal(existsSync(join(filled.root, 'src')), false, 'candidate source is never pulled in')

    const holderRoot = overlay.root
    overlay.dispose()
    filled.dispose()
    assert.equal(existsSync(holderRoot), false, 'dispose removes the private directory')
    assert.equal(readFileSync(join(root, 'project', '.agent', 'attempts.jsonl'), 'utf8'), before, 'the project is untouched')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a scope the state branch does not carry falls back to the candidate, as CI does', () => {
  const root = mkdtempSync(join(tmpdir(), 'durable-fallback-'))
  try {
    write(root, '.agent/attempts.jsonl', '{"attempt_id":"local"}\n')
    write(root, '.agent/STANDARD_CHANGES.yaml', 'changes: []\n')
    write(root, 'tests/spine/manifest.yaml', 'case_ids: ["A-LOCAL"]\n')
    write(root, 'src/cli.mjs', '// candidate material\n')

    const holder = mkdtempSync(join(tmpdir(), 'durable-holder-'))
    // The state branch supplied only the ledger.
    write(holder, '.agent/attempts.jsonl', '{"attempt_id":"state"}\n')
    const copied = completeFromFallback(holder, root)
    assert.deepEqual(copied.sort(), ['.agent/STANDARD_CHANGES.yaml', 'tests/spine/manifest.yaml'].sort())
    assert.match(readFileSync(join(holder, '.agent', 'attempts.jsonl'), 'utf8'), /"state"/, 'state wins where it exists')
    assert.equal(existsSync(join(holder, 'src')), false, 'candidate source is never pulled into an overlay')
    rmSync(holder, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
