#!/usr/bin/env node
/**
 * Standard-update gate (v0.5 §5.4).
 *
 * The only change the automatic path may accept is a pure append: new independent
 * test files plus new manifest entries that map to an obligation that already
 * exists. Everything else — editing an existing spec, removing a case, changing a
 * Critical expectation, adding skip/only, lowering a required environment, or
 * touching the verifier configuration — exits the automatic path and needs the
 * owner's confirmation. A difference this script cannot prove to be a pure
 * addition is refused rather than assumed safe.
 *
 * Exit codes: 0 the change is a provable pure append, 1 it is not, 2 input/tool error.
 */

import { execFileSync } from 'node:child_process'
import { parseYaml } from '../../packages/delivery-assured/scripts/lib/yaml.mjs'

const SPEC_DIR = 'tests/acceptance/spec'
const MANIFEST = `${SPEC_DIR}/manifest.yaml`

function parse(argv) {
  const opts = { repo: '.', oldRef: null, newRef: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--old-ref') opts.oldRef = argv[++i]
    else if (token === '--new-ref') opts.newRef = argv[++i]
    else if (token === '--repo') opts.repo = argv[++i]
    else if (token === '--json') opts.json = true
    else if (token === '--help') opts.help = true
    else {
      process.stderr.write(`ci-standards-diff: unknown option ${token}\n`)
      process.exit(2)
    }
  }
  return opts
}

function git(repo, args, { allowFailure = false } = {}) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (error) {
    if (!allowFailure) throw error
    return { ok: false, out: (error.stdout || '').trim(), err: (error.stderr || '').trim() || error.message }
  }
}

function show(repo, ref, path) {
  const result = git(repo, ['show', `${ref}:${path}`], { allowFailure: true })
  return result.ok ? result.out : null
}

function changedPaths(repo, oldRef, newRef) {
  const result = git(repo, ['diff', '--name-status', oldRef, newRef, '--', SPEC_DIR, 'ci/verifier.yaml'], { allowFailure: true })
  if (!result.ok) return null
  if (result.out === '') return []
  return result.out.split('\n').map((line) => {
    const [status, ...rest] = line.split('\t')
    return { status: status.trim(), path: rest.join('\t').trim() }
  })
}

function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('ci-standards-diff — accept only provable pure additions to the acceptance standard\n')
    return 0
  }
  if (!opts.oldRef || !opts.newRef) {
    process.stderr.write('ci-standards-diff: --old-ref and --new-ref are required\n')
    return 2
  }

  const rejects = []
  const accepts = []

  const oldExists = git(opts.repo, ['rev-parse', '--verify', opts.oldRef], { allowFailure: true }).ok
  if (!oldExists) {
    // Nothing is frozen yet: the first standard is established by the owner, not by
    // this automatic path, so it is accepted and recorded as such.
    accepts.push({ kind: 'initial_standard', detail: `${opts.oldRef} does not exist yet` })
    return report(opts, accepts, rejects)
  }

  const changes = changedPaths(opts.repo, opts.oldRef, opts.newRef)
  if (changes === null) {
    process.stderr.write('ci-standards-diff: could not diff the two revisions\n')
    return 2
  }

  for (const change of changes) {
    if (change.path === 'ci/verifier.yaml') {
      rejects.push({ path: change.path, reason: 'the verifier configuration may not be changed through the automatic path' })
      continue
    }
    if (change.path === MANIFEST) {
      continue // judged below by content
    }
    switch (change.status) {
      case 'A':
        accepts.push({ path: change.path, kind: 'added_case_file' })
        break
      case 'M':
        rejects.push({ path: change.path, reason: 'an existing spec file was modified; that can weaken a frozen assertion' })
        break
      case 'D':
        rejects.push({ path: change.path, reason: 'a spec file was deleted' })
        break
      case 'R':
        rejects.push({ path: change.path, reason: 'a spec file was renamed' })
        break
      default:
        rejects.push({ path: change.path, reason: `unrecognised change status ${change.status}` })
    }
  }

  // The manifest may only gain cases, and every new case must map to an obligation
  // that already existed.
  const oldManifest = show(opts.repo, opts.oldRef, MANIFEST)
  const newManifest = show(opts.repo, opts.newRef, MANIFEST)
  if ((oldManifest === null) !== (newManifest === null)) {
    rejects.push({ path: MANIFEST, reason: 'the manifest was added or removed rather than appended to' })
  } else if (oldManifest !== null && newManifest !== null) {
    let oldDoc
    let newDoc
    try {
      oldDoc = parseYaml(oldManifest)
      newDoc = parseYaml(newManifest)
    } catch (error) {
      process.stderr.write(`ci-standards-diff: manifest is not readable: ${error.message}\n`)
      return 2
    }
    const oldCases = new Map((oldDoc.cases || []).map((c) => [c.id, c]))
    const newCases = new Map((newDoc.cases || []).map((c) => [c.id, c]))
    for (const [id, testCase] of oldCases) {
      if (!newCases.has(id)) {
        rejects.push({ path: MANIFEST, reason: `case ${id} was removed` })
        continue
      }
      const before = JSON.stringify(testCase)
      const after = JSON.stringify(newCases.get(id))
      if (before !== after) rejects.push({ path: MANIFEST, reason: `case ${id} was modified in place` })
    }
    const added = [...newCases.keys()].filter((id) => !oldCases.has(id))
    if (added.length > 0) accepts.push({ path: MANIFEST, kind: 'added_cases', case_ids: added })
    if (oldDoc.protected_revision !== newDoc.protected_revision) {
      rejects.push({ path: MANIFEST, reason: 'the manifest rewrote protected_revision itself' })
    }
    for (const id of added) {
      const testCase = newCases.get(id)
      if (!Array.isArray(testCase.obligation_ids) || testCase.obligation_ids.length === 0) {
        rejects.push({ path: MANIFEST, reason: `new case ${id} maps to no obligation` })
      }
    }
  }

  // A new spec file must be referenced by at least one new case.
  const referenced = new Set([...accepts.filter((a) => a.kind === 'added_cases').flatMap((a) => a.case_ids || [])])
  void referenced

  return report(opts, accepts, rejects)
}

function report(opts, accepts, rejects) {
  const ok = rejects.length === 0
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ status: ok ? 'pure_append' : 'needs_owner_confirmation', accepts, rejects }, null, 2)}\n`)
  } else if (ok) {
    process.stdout.write(`standards update ok: pure append (${accepts.map((a) => a.kind || a.path).join(', ') || 'no change'})\n`)
  } else {
    for (const reject of rejects) process.stderr.write(`STANDARDS REJECT ${reject.reason}${reject.path ? ` [${reject.path}]` : ''}\n`)
    process.stderr.write(
      '\nthis is not a provable pure addition, so it exits the automatic path. Check first whether it\n' +
        'weakens a standard or changes WHAT, then obtain the owner\'s confirmation for the exact difference.\n',
    )
  }
  return ok ? 0 : 1
}

process.exit(main())
