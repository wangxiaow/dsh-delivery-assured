#!/usr/bin/env node
/**
 * Read-only view of the durable delivery state.
 *
 * The authoritative Baseline metadata, Evidence, the attempt ledger, the accumulated
 * Spine and the recorded standard changes live on `refs/heads/delivery-state/main`, not
 * on the candidate revision. The CI workflows overlay that tree onto a staged checkout
 * before they verify or promote. A session has no equivalent, so a session that reads
 * only its working tree reports a delivered project as blocked 鈥?the attempt ledger
 * references a comparison approval it cannot see, and no Baseline or Evidence exists
 * locally to bind.
 *
 * This module gives the readers the same view without writing anything into the project:
 *
 *   - one ref is fetched, then read with `git ls-tree` + `git show`;
 *   - only the state-owned scopes are materialised, into a private temporary directory;
 *   - anything outside those scopes refuses the whole overlay;
 *   - an unreadable state is reported as `available: false` with a reason, and it is
 *     never turned into "nothing is owed".
 *
 * It deliberately does not consult the network unless asked, does not touch the project
 * tree, and does not invent a Baseline when the ref is missing.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const STATE_REF = 'refs/heads/delivery-state/main'

/** Exact durable-state scopes, mirroring ci/tools/ci-state-snapshot.mjs. */
export const STATE_FILES = [
  '.agent/attempts.jsonl',
  '.agent/reviews.yaml',
  '.agent/STANDARD_CHANGES.yaml',
  'ci/mvp-ready.json',
  'tests/spine/manifest.yaml',
]
export const STATE_TREES = ['ci/recording', 'ci/evidence', 'ci/baseline']
export const STATE_SCOPES = [...STATE_FILES, ...STATE_TREES]

/** A state path is relative, inside `project/`, and free of traversal or reserved names. */
export function inStateScope(projectRelative) {
  if (typeof projectRelative !== 'string' || projectRelative.length === 0) return false
  if (projectRelative.startsWith('/') || projectRelative.includes('\\') || projectRelative.includes(':')) return false
  const parts = projectRelative.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || /[. ]$/.test(part))) return false
  if (parts.some((part) => /[\x00-\x1f\x7f\ufffd]/.test(part))) return false
  if (parts.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false
  return STATE_FILES.includes(projectRelative) || STATE_TREES.some((tree) => projectRelative === tree || projectRelative.startsWith(`${tree}/`))
}

/**
 * Complete the overlay the way CI does it: state wins where a scope exists, the
 * candidate's own copy is used only where the state branch carries none. CI extracts the
 * state archive *on top of* the staged candidate, so an empty state branch leaves the
 * candidate's files in place; this reproduces that without copying state into the project.
 */
export function completeFromFallback(holder, fallbackRoot, scopes = STATE_SCOPES) {
  const copied = []
  const visit = (relative) => {
    const source = join(fallbackRoot, relative)
    let stats
    try {
      stats = lstatSync(source)
    } catch {
      return
    }
    if (stats.isSymbolicLink()) return
    if (stats.isDirectory()) {
      for (const name of readdirSync(source)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue
        visit(`${relative}/${name}`)
      }
      return
    }
    if (!stats.isFile()) return
    const destination = join(holder, relative)
    if (existsSync(destination)) return
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    copied.push(relative)
  }
  for (const scope of scopes) visit(scope)
  return copied
}

function runGit(git, repo, args) {
  return git(repo, args)
}

/** Default git runner: arguments are passed as a list, never through a shell. */
export function defaultGit(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', shell: false, maxBuffer: 128 * 1024 * 1024 })
  if (result.error) return { ok: false, reason: `git could not run: ${result.error.message}` }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n')[0]
    return { ok: false, reason: detail || `git exited ${result.status}` }
  }
  return { ok: true, stdout: result.stdout }
}

/**
 * Materialise the durable state into a private temporary directory.
 *
 * Returns `{ available, sha, root, reason, scopes, dispose }`. When the state cannot be
 * read the caller must keep reporting its blocking conditions; this function never
 * degrades to an empty ledger.
 */
export function fetchDurableState({
  repoRoot,
  ref = STATE_REF,
  remote = 'origin',
  branchRef = 'refs/heads/delivery-state/main',
  git = defaultGit,
  refLabel = 'delivery-state/main',
  fallbackRoot = null,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return { available: false, sha: null, root: null, scopes: [], reason: 'no repository root was given', dispose() {} }
  }
  const absent = (reason) => ({ available: false, sha: null, root: null, scopes: [], reason, dispose() {} })

  // Every later command runs from the repository top level: `-C <project subdirectory>`
  // would make the `-- project` pathspec cwd-relative and silently match nothing.
  const top = runGit(git, repoRoot, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return absent(`${repoRoot} is not inside a Git working tree: ${top.reason}`)
  const repo = top.stdout.trim()
  if (repo.length === 0) return absent(`${repoRoot} reported an empty repository top level`)

  const probed = runGit(git, repo, ['ls-remote', '--exit-code', remote, ref])
  if (!probed.ok) return absent(`${refLabel} is not readable on ${remote}: ${probed.reason}`)

  const fetched = runGit(git, repo, ['fetch', '--no-tags', '--quiet', remote, ref])
  if (!fetched.ok) return absent(`fetching ${refLabel} failed: ${fetched.reason}`)

  const resolved = runGit(git, repo, ['rev-parse', 'FETCH_HEAD'])
  if (!resolved.ok) return absent(`the fetched ${refLabel} had no revision: ${resolved.reason}`)
  const sha = resolved.stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) return absent(`the fetched ${refLabel} reported an unusable revision`)

  const listed = runGit(git, repo, ['ls-tree', '-r', '--name-only', sha, '--', 'project'])
  if (!listed.ok) return absent(`listing ${refLabel} failed: ${listed.reason}`)
  const entries = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const relative = []
  for (const entry of entries) {
    if (!entry.startsWith('project/')) return absent(`${refLabel} contains an entry outside project/: ${entry}`)
    const path = entry.slice('project/'.length)
    // Tree markers (a bare `ci/evidence`) are allowed; anything else must be in scope.
    if (!inStateScope(path)) return absent(`${refLabel} contains an entry outside the durable-state scopes: ${path}`)
    relative.push(path)
  }
  if (relative.length === 0 && !fallbackRoot) return absent(`${refLabel} carries no durable-state scope at all`)

  const holder = mkdtempSync(join(tmpdir(), 'dsh-durable-state-'))
  try {
    for (const path of relative) {
      const blob = runGit(git, repo, ['show', `${sha}:project/${path}`])
      if (!blob.ok) return absent(`reading ${path} from ${refLabel} failed: ${blob.reason}`)
      const destination = join(holder, path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, blob.stdout, 'utf8')
    }
    if (fallbackRoot) completeFromFallback(holder, fallbackRoot)
  } catch (error) {
    rmSync(holder, { recursive: true, force: true })
    return absent(`materialising ${refLabel} failed: ${String(error?.message || error)}`)
  }

  return {
    available: true,
    sha,
    root: holder,
    scopes: relative.sort(),
    branch: branchRef,
    reason: null,
    dispose() {
      rmSync(holder, { recursive: true, force: true })
    },
  }
}
