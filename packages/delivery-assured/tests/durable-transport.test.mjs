#!/usr/bin/env node
/**
 * The authoritative-state transport: how the platform's history is fetched, and what
 * happens when it cannot be fetched.
 *
 * Two things are being pinned here, and both are failures the previous round produced in
 * a real session:
 *
 *   1. the *channel*. `git` cannot spawn its helpers in a confined session shell, so the
 *      state is read over the GitHub API through `gh`. The GitHub client is faked here
 *      (no network), but the code under test is the real one: scope refusal, byte-length
 *      binding, the GraphQL batch with its per-object fallback, and the reported reason
 *      when a channel is not attempted.
 *   2. the *answer*. When the durable ref and the working tree disagree — which is the
 *      normal case, since Baseline metadata, the recording tree and the Spine only exist
 *      on the ref — the authoritative read wins, and a read that needed worktree facts is
 *      reported as degraded rather than presented as a recovery result.
 *
 * Exit codes: 0 all checks passed, 1 check failed, 2 input/tool error.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { STATE_TRANSPORT, fetchDurableState, readRemoteRef, resolveStateRepo } from '../scripts/lib/durable-state.mjs'
import { parseGitHubRemote, whichCommand } from '../scripts/lib/gh-api.mjs'
import { STATE_AUTHORITY, STATE_SOURCE, openStateView, stateAuthority } from '../scripts/lib/state-view.mjs'
import { findGitDir, localRevision, remoteUrl } from '../scripts/lib/worktree-git.mjs'

const run = (cwd, args, options = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...options }).trim()

function write(root, relative, content) {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

const SHA = (char) => char.repeat(40)

/* --------------------------------------------------------------- the fake channel */

/**
 * A GitHub API stand-in backed by an in-memory tree.
 *
 * It answers the three endpoints the transport uses and records how many requests each
 * channel served, so a check can assert that the batch was used and that a blob the batch
 * cannot return falls through to the exact-bytes endpoint.
 */
function fakeGitHub({ refSha = SHA('a'), tree = [], blobs = {}, refError = null, truncated = false, batchTextNull = [], batchOid = {} } = {}) {
  const served = { rest: 0, graphql: 0, raw: 0 }
  return {
    served,
    api(endpoint) {
      served.rest += 1
      if (/\/git\/ref\//.test(endpoint)) {
        if (refError) return { ok: false, reason: refError }
        return { ok: true, value: { object: { sha: refSha } } }
      }
      if (/\/git\/trees\//.test(endpoint)) return { ok: true, value: { truncated, tree } }
      return { ok: false, reason: `${endpoint}: unexpected endpoint` }
    },
    graphql(query) {
      served.graphql += 1
      const repository = {}
      const pattern = /b(\d+): object\(expression: "([^"]+)"\)/g
      for (const match of String(query).matchAll(pattern)) {
        const [, alias, expression] = match
        const path = expression.slice(expression.indexOf(':') + 1)
        const relative = path.replace(/^project\//, '')
        const entry = tree.find((item) => item.path === path)
        if (!entry) continue
        const oid = batchOid[relative] || entry.sha
        repository[`b${alias}`] = batchTextNull.includes(relative)
          ? { oid, byteSize: entry.size ?? null, isBinary: false, text: null }
          : { oid, byteSize: entry.size ?? null, isBinary: false, text: blobs[relative] ?? '' }
      }
      return { ok: true, value: { repository } }
    },
    apiRaw(endpoint) {
      served.raw += 1
      const sha = endpoint.split('/').pop()
      const entry = tree.find((item) => item.sha === sha)
      if (!entry) return { ok: false, reason: `${endpoint}: no such blob` }
      const relative = entry.path.replace(/^project\//, '')
      return { ok: true, text: blobs[relative] ?? '' }
    },
  }
}

function entryFor(relative, content, sha = SHA('b')) {
  return { path: `project/${relative}`, type: 'blob', sha, size: Buffer.byteLength(content, 'utf8') }
}

/* -------------------------------------------------------------------- URL parsing */

test('a GitHub remote URL is read in the shapes a checkout actually uses', () => {
  for (const [url, full] of [
    ['https://github.com/wangxiaow/dsh-delivery-assured.git', 'wangxiaow/dsh-delivery-assured'],
    ['https://github.com/wangxiaow/dsh-delivery-assured', 'wangxiaow/dsh-delivery-assured'],
    ['https://token@github.com/wangxiaow/dsh-delivery-assured.git', 'wangxiaow/dsh-delivery-assured'],
    ['git@github.com:wangxiaow/dsh-delivery-assured.git', 'wangxiaow/dsh-delivery-assured'],
    ['ssh://git@github.com/wangxiaow/dsh-delivery-assured.git', 'wangxiaow/dsh-delivery-assured'],
    ['git+https://github.com/wangxiaow/dsh-delivery-assured.git', 'wangxiaow/dsh-delivery-assured'],
  ]) {
    assert.equal(parseGitHubRemote(url)?.full, full, url)
  }
  for (const url of [
    'G:/dsh/YH2',
    'C:/repos/bare.git',
    'https://gitlab.com/o/r.git',
    'https://github.com/onlyowner',
    'https://github.com/a/b/c',
    '',
    null,
  ]) {
    assert.equal(parseGitHubRemote(url), null, String(url))
  }
})

test('the repository to read comes from configuration, the environment, or .git/config', () => {
  const root = mkdtempSync(join(tmpdir(), 'gh-repo-'))
  try {
    // A bare `owner/name` override wins over everything.
    assert.equal(resolveStateRepo({ repo: 'o/n', env: { DSH_DELIVERY_CI_REPO: 'x/y' }, repoRoot: root }).repo, 'o/n')
    assert.equal(resolveStateRepo({ env: { DSH_DELIVERY_CI_REPO: 'x/y' }, repoRoot: root }).repo, 'x/y')
    assert.match(resolveStateRepo({ repo: 'not-a-repo', env: {}, repoRoot: root }).reason, /owner\/name/)

    // The remote URL is read from the Git config file — no `git` process is needed, which
    // is what makes this work in the same shell where `git remote get-url` cannot run.
    write(root, '.git/config', '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:wangxiaow/dsh-delivery-assured.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
    assert.equal(resolveStateRepo({ env: {}, repoRoot: join(root, 'project', 'nested') }).repo, 'wangxiaow/dsh-delivery-assured')
    assert.equal(remoteUrl(join(root, 'project', 'nested')).url, 'git@github.com:wangxiaow/dsh-delivery-assured.git')
    assert.equal(findGitDir(join(root, 'project', 'nested')), join(root, '.git'))

    write(root, '.git/config', '[remote "origin"]\n\turl = C:/repos/origin.git\n')
    assert.match(resolveStateRepo({ env: {}, repoRoot: root }).reason, /does not point at github/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the local reader resolves HEAD and refs from the metadata files', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-files-'))
  try {
    // Not a working tree at all: nothing is invented.
    assert.equal(localRevision(root, 'HEAD'), null)

    write(root, '.git/HEAD', 'ref: refs/heads/main\n')
    write(root, '.git/refs/heads/main', `${SHA('c')}\n`)
    assert.equal(localRevision(root, 'HEAD'), SHA('c'))
    // A caller passes the project directory, not the repository root; `git -C` would walk
    // up, and so must the file reader.
    mkdirSync(join(root, 'project'), { recursive: true })
    assert.equal(localRevision(join(root, 'project'), 'HEAD'), SHA('c'))

    // A packed ref resolves too, and a detached HEAD is its own revision.
    rmSync(join(root, '.git', 'refs', 'heads', 'main'), { force: true })
    write(root, '.git/packed-refs', `# pack-refs with: peeled fully-peeled sorted\n${SHA('d')} refs/heads/main\n`)
    assert.equal(localRevision(root, 'HEAD'), SHA('d'))
    write(root, '.git/HEAD', `${SHA('e')}\n`)
    assert.equal(localRevision(root, 'HEAD'), SHA('e'))

    // A linked worktree points at the main Git dir through a `gitdir` file and keeps its
    // refs in the common dir.
    const linked = join(root, 'linked')
    mkdirSync(linked, { recursive: true })
    write(linked, '.git', `gitdir: ${join(root, '.git', 'worktrees', 'linked')}\n`)
    write(root, '.git/worktrees/linked/HEAD', 'ref: refs/heads/feature\n')
    write(root, '.git/worktrees/linked/commondir', '../..\n')
    write(root, '.git/refs/heads/feature', `${SHA('f')}\n`)
    assert.equal(localRevision(linked, 'HEAD'), SHA('f'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the gh CLI is located explicitly, by environment, or on PATH', () => {
  assert.equal(whichCommand('definitely-not-here-xyz', { pathValue: 'C:/nothing', platform: 'win32', exists: () => false }), null)
  assert.equal(whichCommand('gh', { pathValue: 'C:/tools', platform: 'win32', exists: (p) => p === join('C:/tools', 'gh.exe') }), join('C:/tools', 'gh.exe'))
})

/* ------------------------------------------------------------------ the gh channel */

const STATE_TREE = [
  entryFor('.agent/attempts.jsonl', '{"attempt_id":"ci:verify:1-1","result":"passed"}\n', SHA('1')),
  entryFor('tests/spine/manifest.yaml', 'case_ids: ["A-ONE"]\n', SHA('2')),
  { path: 'project', type: 'tree', sha: SHA('3') },
  { path: 'project/.agent', type: 'tree', sha: SHA('4') },
]

test('the gh channel materialises exactly the state scopes, byte-bound to the tree', () => {
  const contents = {
    '.agent/attempts.jsonl': '{"attempt_id":"ci:verify:1-1","result":"passed"}\n',
    'tests/spine/manifest.yaml': 'case_ids: ["A-ONE"]\n',
  }
  const client = fakeGitHub({ tree: STATE_TREE, blobs: contents })
  const state = fetchDurableState({ repoRoot: '.', transport: STATE_TRANSPORT.GH, gh: client, repo: 'o/r' })
  try {
    assert.equal(state.available, true, state.reason)
    assert.equal(state.transport, 'gh')
    assert.equal(state.sha, SHA('a'))
    assert.deepEqual(state.scopes, ['.agent/attempts.jsonl', 'tests/spine/manifest.yaml'])
    assert.deepEqual(state.filled, [])
    assert.equal(readFileSync(join(state.root, '.agent', 'attempts.jsonl'), 'utf8'), contents['.agent/attempts.jsonl'])
    assert.equal(client.served.graphql, 1, 'the blobs come back in one batch')
    assert.equal(client.served.raw, 0, 'no per-object fallback was needed')
  } finally {
    state.dispose()
  }
})

test('a blob the batch cannot return falls back to the exact-bytes endpoint', () => {
  const contents = {
    '.agent/attempts.jsonl': '{"attempt_id":"ci:verify:1-1","result":"passed"}\n',
    'tests/spine/manifest.yaml': 'case_ids: ["A-ONE"]\n',
  }
  // Two independent reasons to fall back: a null `text`, and an object id that does not
  // match the one the tree named.
  const client = fakeGitHub({ tree: STATE_TREE, blobs: contents, batchTextNull: ['.agent/attempts.jsonl'], batchOid: { 'tests/spine/manifest.yaml': SHA('9') } })
  const state = fetchDurableState({ repoRoot: '.', transport: STATE_TRANSPORT.GH, gh: client, repo: 'o/r' })
  try {
    assert.equal(state.available, true, state.reason)
    assert.equal(client.served.raw, 2, 'both suspicious blobs were re-read one by one')
    assert.equal(readFileSync(join(state.root, 'tests', 'spine', 'manifest.yaml'), 'utf8'), contents['tests/spine/manifest.yaml'])
    assert.equal(readFileSync(join(state.root, '.agent', 'attempts.jsonl'), 'utf8'), contents['.agent/attempts.jsonl'])
  } finally {
    state.dispose()
  }
})

test('the gh channel fails closed on anything outside the state scopes', () => {
  const cases = [
    {
      label: 'candidate source',
      tree: [...STATE_TREE, entryFor('src/cli.mjs', '// candidate material\n', SHA('5'))],
      expect: /outside the durable-state scopes: src\/cli\.mjs/,
    },
    {
      label: 'an entry outside project/',
      tree: [...STATE_TREE, { path: 'README.md', type: 'blob', sha: SHA('6'), size: 1 }],
      expect: /outside project\/: README\.md/,
    },
    {
      label: 'a submodule',
      tree: [...STATE_TREE, { path: 'project/ci/evidence', type: 'commit', sha: SHA('7') }],
      expect: /non-file entry of type commit/,
    },
  ]
  for (const scenario of cases) {
    const state = fetchDurableState({ repoRoot: '.', transport: STATE_TRANSPORT.GH, gh: fakeGitHub({ tree: scenario.tree, blobs: {} }), repo: 'o/r' })
    assert.equal(state.available, false, scenario.label)
    assert.match(state.reason, scenario.expect, scenario.label)
    assert.equal(state.root, null)
  }
})

test('a truncated tree refuses the read: the scopes could not be verified', () => {
  const state = fetchDurableState({ repoRoot: '.', transport: STATE_TRANSPORT.GH, gh: fakeGitHub({ tree: STATE_TREE, truncated: true }), repo: 'o/r' })
  assert.equal(state.available, false)
  assert.match(state.reason, /truncated the tree/)
})

test('an unreadable ref is reported with the channel that failed', () => {
  const state = fetchDurableState({ repoRoot: '.', transport: STATE_TRANSPORT.GH, gh: fakeGitHub({ refError: 'gh: Not Found (HTTP 404)' }), repo: 'o/r' })
  assert.equal(state.available, false)
  assert.equal(state.transport, null)
  assert.match(state.reason, /not readable on o\/r: gh: Not Found/)
  assert.deepEqual(state.attempted, [{ transport: 'gh', ok: false, reason: 'delivery-state/main is not readable on o/r: gh: Not Found (HTTP 404)' }])
  assert.deepEqual(state.filled, [])
})

test('an explicitly requested channel does not silently fall back to another one', () => {
  let gitCalls = 0
  const state = fetchDurableState({
    repoRoot: '.',
    transport: STATE_TRANSPORT.GH,
    gh: fakeGitHub({ refError: 'gh: Bad credentials (HTTP 401)' }),
    repo: 'o/r',
    git: () => {
      gitCalls += 1
      return { ok: false, reason: 'must not be called' }
    },
  })
  assert.equal(state.available, false)
  assert.equal(gitCalls, 0, 'the requested channel is the only one tried')
})

test('a state ref that carries no state scope is refused, not treated as empty', () => {
  const state = fetchDurableState({ repoRoot: '.', transport: STATE_TRANSPORT.GH, gh: fakeGitHub({ tree: [{ path: 'project', type: 'tree', sha: SHA('8') }] }), repo: 'o/r' })
  assert.equal(state.available, false)
  assert.match(state.reason, /carries no durable-state scope at all/)
})

test('a scope the ref does not carry is filled from the fallback and reported as filled', () => {
  const root = mkdtempSync(join(tmpdir(), 'fill-'))
  try {
    write(root, '.agent/STANDARD_CHANGES.yaml', 'changes: []\n')
    write(root,'.agent/attempts.jsonl', '{"attempt_id":"worktree"}\n')
    const contents = { '.agent/attempts.jsonl': '{"attempt_id":"state"}\n' }
    const state = fetchDurableState({
      repoRoot: '.',
      transport: STATE_TRANSPORT.GH,
      gh: fakeGitHub({ tree: [entryFor('.agent/attempts.jsonl', contents['.agent/attempts.jsonl'], SHA('1'))], blobs: contents }),
      repo: 'o/r',
      fallbackRoot: root,
    })
    try {
      assert.equal(state.available, true, state.reason)
      assert.deepEqual(state.filled, ['.agent/STANDARD_CHANGES.yaml'])
      assert.match(readFileSync(join(state.root, '.agent', 'attempts.jsonl'), 'utf8'), /"state"/, 'the ref wins where it carries the scope')
      const authority = stateAuthority({ source: STATE_SOURCE.DURABLE_REF, durable: state })
      assert.equal(authority.kind, STATE_AUTHORITY.DURABLE_REF_FILLED)
      assert.equal(authority.authoritative, false, 'a view that used worktree facts is not authoritative')
      assert.equal(authority.degraded, true)
      assert.match(authority.reason, /came from the working tree/)
    } finally {
      state.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the protected reference is read over the same channel, and a 404 is not a read failure', () => {
  const ok = readRemoteRef({ repoRoot: '.', ref: 'refs/heads/baseline/main', transport: STATE_TRANSPORT.GH, gh: fakeGitHub({ refSha: SHA('f') }), repo: 'o/r' })
  assert.deepEqual({ ok: ok.ok, sha: ok.sha, transport: ok.transport, notFound: ok.notFound }, { ok: true, sha: SHA('f'), transport: 'gh', notFound: false })

  const missing = readRemoteRef({ repoRoot: '.', ref: 'refs/heads/baseline/main', transport: STATE_TRANSPORT.GH, gh: fakeGitHub({ refError: 'gh: Not Found (HTTP 404)' }), repo: 'o/r' })
  assert.equal(missing.ok, false)
  assert.equal(missing.notFound, true, 'the platform saying "does not exist" is a different answer from "could not be read"')

  const denied = readRemoteRef({ repoRoot: '.', ref: 'refs/heads/baseline/main', transport: STATE_TRANSPORT.GH, gh: fakeGitHub({ refError: 'gh: Bad credentials (HTTP 401)' }), repo: 'o/r' })
  assert.equal(denied.ok, false)
  assert.equal(denied.notFound, false)
  assert.match(denied.reason, /401/)
})

/* ------------------------------------------------------- authoritative vs worktree */

/** A real (local, network-free) Git repository with a state ref and a divergent worktree. */
function gitFixture() {
  const base = mkdtempSync(join(tmpdir(), 'transport-'))
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

function publishStateRef(root, base, files) {
  const index = join(base, `state-index-${String(Math.random()).slice(2)}`)
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'State', GIT_AUTHOR_EMAIL: 'state@example.invalid',
    GIT_COMMITTER_NAME: 'State', GIT_COMMITTER_EMAIL: 'state@example.invalid',
  }
  const plumbing = (args, input) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, input }).trim()
  plumbing(['read-tree', '--empty'])
  for (const [path, content] of Object.entries(files)) {
    const blob = plumbing(['hash-object', '-w', '--stdin'], content)
    plumbing(['update-index', '--add', '--cacheinfo', '100644', blob, path])
  }
  const commit = plumbing(['commit-tree', plumbing(['write-tree']), '-m', 'state'])
  run(root, ['update-ref', 'refs/heads/delivery-state/main', commit])
  run(root, ['push', '--quiet', '--force', 'origin', 'refs/heads/delivery-state/main:refs/heads/delivery-state/main'])
  rmSync(index, { force: true })
  return commit
}

const ledger = (n, extra = {}) => JSON.stringify({
  attempt_id: `S1-A${n}`, slice_id: 'S1', slice_key: 'S1', at: `2026-01-0${n}T00:00:00.000Z`,
  root_cause_key: 'fixture', hypothesis: `attempt ${n}`, result: 'failed', standard_digest: 'a'.repeat(64),
  required_passed: 1, required_total: 2, spine_failures: 0, critical_violations: [], required_case_ids: ['A-1', 'A-2'], note: '',
  ...extra,
})

test('when the durable ref and the working tree disagree, the authoritative history wins', () => {
  const { base, root } = gitFixture()
  try {
    // The worktree carries a *different* ledger and a *different* baseline: exactly the
    // shape a session sees when someone last ran a local experiment, or when the state
    // moved on without the checkout.
    write(root, 'project/.agent/CONTRACT.yaml', 'version: 4\n')
    write(root, 'project/.agent/attempts.jsonl', `${ledger(1)}\n`)
    write(root, 'project/ci/baseline/BL-999.json', '{"baseline_id":"BL-999","code_revision":"' + SHA('9') + '"}\n')
    write(root, 'project/ci/evidence/worktree.json', '{"evidence_id":"worktree-only"}\n')
    run(root, ['add', '-A'])
    run(root, ['commit', '--quiet', '-m', 'candidate with local state'])

    // The durable ref carries the real history: two attempts, BL-003, and no worktree-only
    // evidence file.
    const stateSha = publishStateRef(root, base, {
      'project/.agent/attempts.jsonl': `${ledger(1)}\n${ledger(2)}\n`,
      'project/ci/baseline/BL-003.json': '{"baseline_id":"BL-003","code_revision":"' + SHA('3') + '"}\n',
    })

    const authoritative = fetchDurableState({ repoRoot: join(root, 'project'), transport: STATE_TRANSPORT.GIT, fallbackRoot: join(root, 'project') })
    try {
      assert.equal(authoritative.available, true, authoritative.reason)
      assert.equal(authoritative.transport, 'git')
      assert.equal(authoritative.sha, stateSha)
      assert.match(readFileSync(join(authoritative.root, '.agent', 'attempts.jsonl'), 'utf8'), /S1-A2/, 'the ref ledger, not the worktree one')
      assert.equal(readFileSync(join(authoritative.root, '.agent', 'attempts.jsonl'), 'utf8').trim().split('\n').length, 2)
      // The ref carries `ci/evidence` and `ci/baseline`, but not these files; nothing the
      // worktree holds inside a state scope is invisible to the report.
      assert.deepEqual([...authoritative.filled].sort(), ['ci/baseline/BL-999.json', 'ci/evidence/worktree.json'])
      const authority = stateAuthority({ source: STATE_SOURCE.DURABLE_REF, durable: authoritative })
      assert.equal(authority.authoritative, false)
      assert.equal(authority.degraded, true)
      assert.match(authority.reason, /BL-999|worktree\.json/, 'the fill is named in the report')
    } finally {
      authoritative.dispose()
    }

    // The worktree-only reader sees exactly the worktree's one attempt and its BL-999, so
    // "the authoritative history won" is a claim with a counterexample.
    const worktreeView = openStateView(join(root, 'project'), { source: STATE_SOURCE.WORKTREE })
    try {
      assert.equal(worktreeView.budget({ candidate: SHA('c'), parentBaseline: null }).counted, 1)
      assert.equal(worktreeView.model.baselines.at(-1)?.baseline_id, 'BL-999')
    } finally {
      worktreeView.dispose()
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a session that cannot reach the ref is degraded, not quietly answered from the worktree', () => {
  const { base, root } = gitFixture()
  try {
    write(root, 'project/.agent/attempts.jsonl', `${ledger(1)}\n`)
    run(root, ['add', '-A'])
    run(root, ['commit', '--quiet', '-m', 'candidate'])
    // No state ref exists anywhere.
    const state = fetchDurableState({ repoRoot: join(root, 'project'), transport: STATE_TRANSPORT.GIT, fallbackRoot: join(root, 'project') })
    assert.equal(state.available, false)
    assert.equal(state.root, null)
    assert.match(state.reason, /not readable on origin/)

    const authority = stateAuthority({ source: STATE_SOURCE.DURABLE_REF, durable: { ...state, requested: true } })
    assert.equal(authority.kind, STATE_AUTHORITY.WORKTREE_FALLBACK)
    assert.equal(authority.authoritative, false)
    assert.equal(authority.degraded, true)
    assert.match(authority.reason, /working-tree facts, not a recovery result/)

    // Choosing the working tree is not degradation; it is an explicit, reported choice.
    const chosen = stateAuthority({ source: STATE_SOURCE.WORKTREE, durable: { available: false, attempted: [] } })
    assert.equal(chosen.kind, STATE_AUTHORITY.WORKTREE)
    assert.equal(chosen.degraded, false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the shared view reports which authority its numbers came from', () => {
  const { base, root } = gitFixture()
  try {
    write(root, 'project/.agent/CONTRACT.yaml', 'version: 4\n')
    write(root, 'project/.agent/attempts.jsonl', `${ledger(1)}\n`)
    run(root, ['add', '-A'])
    run(root, ['commit', '--quiet', '-m', 'candidate'])
    run(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
    const sha = publishStateRef(root, base, { 'project/.agent/attempts.jsonl': `${ledger(1)}\n${ledger(2)}\n${ledger(3)}\n` })

    const refView = openStateView(join(root, 'project'), { source: STATE_SOURCE.DURABLE_REF, transport: STATE_TRANSPORT.GIT })
    const treeView = openStateView(join(root, 'project'), { source: STATE_SOURCE.WORKTREE })
    try {
      assert.equal(refView.authority.kind, STATE_AUTHORITY.DURABLE_REF)
      assert.equal(refView.authority.authoritative, true)
      assert.equal(refView.authority.transport, 'git')
      assert.equal(refView.durable.sha, sha)
      assert.equal(treeView.authority.kind, STATE_AUTHORITY.WORKTREE)
      const refBudget = refView.budget({ candidate: SHA('c'), parentBaseline: null })
      const treeBudget = treeView.budget({ candidate: SHA('c'), parentBaseline: null })
      assert.equal(refBudget.counted, 3)
      assert.equal(treeBudget.counted, 1)
      assert.notEqual(refBudget.counted, treeBudget.counted, 'the two sources are genuinely different histories')
    } finally {
      refView.dispose()
      treeView.dispose()
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
