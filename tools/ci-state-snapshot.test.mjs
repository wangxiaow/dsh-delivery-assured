import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertStateTree, assertStateSnapshot } from '../ci/tools/ci-state-snapshot.mjs'

const root = mkdtempSync(join(tmpdir(), 'ci-state-snapshot-offline-'))
const repo = join(root, 'repo'), project = join(root, 'restored')
mkdirSync(repo)
mkdirSync(project)
const initial = new Map([
  ['.agent/attempts.jsonl', Buffer.from('{"attempt":1}\n')],
  ['tests/spine/manifest.yaml', Buffer.from('cases: []\r\n')],
  ['ci/recording/receipts/1-1.json', Buffer.from('{"run_key":"1-1"}\n')],
  ['ci/recording/diagnostics/1-1.json', Buffer.from('{"diagnostic_only":true}\n')],
  ['ci/evidence/1-1.bin', Buffer.from([0, 255, 128, 13, 10])],
  ['ci/baseline/b0.json', Buffer.from('{"baseline_id":"fixture-b0"}\n')],
])
const git = (args, input) => {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', input, shell: false,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Offline fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Offline fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' },
  })
  if (result.error || result.status !== 0) throw new Error(`fixture Git failed: ${result.error?.message || result.stderr}`)
  return result.stdout.trim()
}
const put = (base, path, bytes) => {
  const parts = path.split('/')
  mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true })
  writeFileSync(join(base, ...parts), bytes)
}
// Every cleanup target is a fixed child of this fresh local temporary fixture.
const remove = path => {
  assert.ok(path === root || path.startsWith(root + (process.platform === 'win32' ? '\\' : '/')))
  rmSync(path, { recursive: true, force: true })
}
const snapshot = parent => git(['commit-tree', git(['write-tree']), ...(parent ? ['-p', parent] : [])], 'offline snapshot fixture\n')
let stateSha
const check = overrides => assertStateSnapshot({ repo, stateSha, project, ...overrides })
const reset = () => {
  remove(project)
  mkdirSync(project)
  for (const [path, bytes] of initial) put(project, path, bytes)
}

try {
  git(['init', '--quiet'])
  git(['config', 'core.autocrlf', 'false'])
  for (const [path, bytes] of initial) put(join(repo, 'project'), path, bytes)
  put(join(repo, 'project'), 'source.txt', Buffer.from('not control state\n'))
  put(join(repo, 'project'), '.agent/CONTRACT.yaml', Buffer.from('not control state\n'))
  git(['add', '--', 'project'])
  stateSha = snapshot()
  assert.throws(() => assertStateTree({ repo, stateSha }), /outside durable scopes/)
  git(['update-index', '--force-remove', '--', 'project/source.txt', 'project/.agent/CONTRACT.yaml'])
  const cleanState = snapshot(stateSha)
  assert.equal(assertStateTree({ repo, stateSha: cleanState }).file_count, 6)
  const treeCli = spawnSync(process.execPath, [join(import.meta.dirname, '../ci/tools/ci-state-snapshot.mjs'), '--check-tree', cleanState, '--repo', repo], { encoding: 'utf8' })
  assert.equal(treeCli.status, 0, treeCli.stderr)
  reset()
  const result = check()
  assert.deepEqual(result, { diagnostic_only: true, state_sha: stateSha, state_project: 'project', file_count: 6 })
  assert.ok(Object.isFrozen(result))
  assert.equal(result instanceof Promise, false)
  put(project, 'source.txt', Buffer.from('different Candidate source\n'))
  put(project, '.agent/CONTRACT.yaml', Buffer.from('different Contract\n'))
  assert.deepEqual(check(), result)

  // A state-only successor adds a receipt and diagnostic without ledger changes.
  put(join(repo, 'project'), 'ci/recording/receipts/2-1.json', Buffer.from('{"run_key":"2-1"}\n'))
  put(join(repo, 'project'), 'ci/recording/diagnostics/2-1.json', Buffer.from('{"diagnostic_only":true}\n'))
  git(['add', '--', 'project/ci/recording'])
  const successor = snapshot(stateSha)
  assert.equal(git(['show', `${successor}:project/.agent/attempts.jsonl`]), git(['show', `${stateSha}:project/.agent/attempts.jsonl`]))
  assert.throws(() => check({ stateSha: successor }), /missing:.*diagnostics\/2-1.json.*receipts\/2-1.json/)
  put(project, 'ci/recording/diagnostics/2-1.json', Buffer.from('{"diagnostic_only":true}\n'))
  assert.throws(() => check({ stateSha: successor }), /missing: ci\/recording\/receipts\/2-1.json/)
  remove(join(project, 'ci/recording/diagnostics/2-1.json'))
  put(project, 'ci/recording/receipts/2-1.json', Buffer.from('{"run_key":"2-1"}\n'))
  assert.throws(() => check({ stateSha: successor }), /missing: ci\/recording\/diagnostics\/2-1.json/)
  put(project, 'ci/recording/diagnostics/2-1.json', Buffer.from('{"diagnostic_only":true}\n'))
  assert.equal(check({ stateSha: successor }).file_count, 8)
  // Baseline-only state changes must not disappear behind identical budget history.
  put(join(repo, 'project'), 'ci/baseline/b1.json', Buffer.from('{"baseline_id":"fixture-b1"}\n'))
  git(['add', '--', 'project/ci/baseline'])
  const baselineSuccessor = snapshot(successor)
  assert.equal(git(['show', `${baselineSuccessor}:project/.agent/attempts.jsonl`]), git(['show', `${stateSha}:project/.agent/attempts.jsonl`]))
  assert.throws(() => check({ stateSha: baselineSuccessor }), /missing: ci\/baseline\/b1.json/)
  put(project, 'ci/baseline/b1.json', Buffer.from('{"baseline_id":"fixture-b1"}\n'))
  assert.equal(check({ stateSha: baselineSuccessor }).file_count, 9)
  reset()

  for (const path of ['.agent/reviews.yaml', '.agent/STANDARD_CHANGES.yaml', 'ci/mvp-ready.json', 'ci/recording/mvp-finalizations/forged.json', 'ci/recording/resolutions/forged.json', 'ci/recording/receipts/extra.json', 'ci/recording/diagnostics/extra.json', 'ci/evidence/extra.json', 'ci/baseline/forged.json']) {
    put(project, path, Buffer.from('{}\n'))
    assert.throws(() => check(), /extra:/)
    reset()
  }
  for (const path of initial.keys()) {
    put(project, path, Buffer.concat([initial.get(path), Buffer.from([0])]))
    assert.throws(() => check(), /bytes mismatch/)
    reset()
    remove(join(project, ...path.split('/')))
    assert.throws(() => check(), /missing:/)
    reset()
  }
  const ledger = readFileSync(join(project, '.agent/attempts.jsonl'))
  remove(join(project, 'ci/recording/diagnostics/1-1.json'))
  assert.deepEqual(readFileSync(join(project, '.agent/attempts.jsonl')), ledger)
  assert.throws(() => check(), /missing: ci\/recording\/diagnostics\/1-1.json/)
  reset()

  remove(join(project, 'ci/recording'))
  symlinkSync(join(repo, 'project/ci/recording'), join(project, 'ci/recording'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => check(), /symlink/)
  reset()
  const alias = join(root, 'alias')
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => check({ project: alias }), /nonregular/)
  assert.throws(() => check({ project: join(alias, 'ci') }), /nonregular/)
  remove(alias)
  remove(join(project, '.agent/attempts.jsonl'))
  mkdirSync(join(project, '.agent/attempts.jsonl'))
  assert.throws(() => check(), /unsupported/)
  reset()

  for (const stateSha of ['main', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(40) + '\n', '--help', 'a'.repeat(40) + ':project', '0'.repeat(40)]) assert.throws(() => check({ stateSha }))
  for (const stateProject of ['', '../project', '/project', 'project/../other', 'project\\..\\other', 'C:/project', 'project\n', 'project.', 'project//sub', 'project:other']) assert.throws(() => check({ stateProject }), /unsafe/)
  assert.throws(() => check({ stateRoot: '../outside' }), /unsupported/)
  for (const invalidProject of ['', 'relative', join(root, 'missing'), project + '\0']) assert.throws(() => check({ project: invalidProject }))
  const blob = git(['hash-object', '-w', '--stdin'], 'target\n')
  assert.throws(() => check({ stateSha: blob }), /must identify a commit/)
  git(['update-index', '--add', '--cacheinfo', `120000,${blob},project/ci/recording/symlink`])
  assert.throws(() => check({ stateSha: snapshot(successor) }), /nonregular Git state entry/)
  git(['update-index', '--force-remove', '--', 'project/ci/recording/symlink'])
  git(['update-index', '--add', '--cacheinfo', `160000,${stateSha},project/ci/evidence/submodule`])
  assert.throws(() => check({ stateSha: snapshot(successor) }), /nonregular Git state entry/)
  git(['update-index', '--force-remove', '--', 'project/ci/evidence/submodule', 'project/ci/evidence/1-1.bin'])
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},project/ci/evidence`])
  assert.throws(() => check({ stateSha: snapshot(successor) }), /invalid Git state layout/)
  git(['update-index', '--force-remove', '--', 'project/ci/evidence', 'project/.agent/attempts.jsonl', 'project/.agent/CONTRACT.yaml'])
  git(['update-index', '--add', '--cacheinfo', `120000,${blob},project/.agent`])
  assert.throws(() => check({ stateSha: snapshot(successor) }), /nonregular Git state entry/)
  console.log('ci-state-snapshot: exact scoped control-state binding and negative controls passed (local diagnostic only)')
} finally {
  remove(root)
}
