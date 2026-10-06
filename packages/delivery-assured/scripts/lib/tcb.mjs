/**
 * The finite Trusted Computing Base (TCB).
 *
 * The rule this module exists to enforce:
 *
 *   A Candidate may not modify the logic that decides whether the Candidate
 *   itself is Delivered, and then use the modified logic to prove itself.
 *
 * There is no "verifier of the verifier of the verifier" here, and no recursion:
 * the TCB is a *finite, named* set of files — the ones that decide the verdict —
 * whose bytes are recorded at freeze time and re-checked at verification time.
 * Drift is `TCB_DRIFT` and the verdict is NOT_DELIVERED.
 *
 * What makes the check more than a self-referential digest:
 *
 *   - the freeze record holds `tcb_files` / `tcb_digest` / `tcb_version`, so the
 *     "current" side is compared against bytes that were named before the run;
 *   - when the TCB lives inside the candidate's own Git repository (the
 *     self-hosting case, where `verifier` and `product` ship together), an *additional*
 *     comparison runs through Git blob ids at the record's `frozen_revision`. Editing a
 *     TCB member and only rewriting the digest file therefore does not pass, because
 *     `<frozen_revision>:<path>` is read from the object database and not from the JSON;
 *   - when the TCB lives outside the candidate's repository (an ordinary project,
 *     whose operation pack is installed elsewhere), the inversion is different and
 *     stated honestly: that pack is not part of the Candidate's revision, so the
 *     Candidate cannot change it at all, and the recorded digest exists to catch an
 *     out-of-band pack upgrade between freeze and verification.
 *
 * Residual limitation, stated rather than hidden — the anchor is only as good as the
 * revision it names, and that revision lives in the same record a Candidate can write:
 *
 *   - a Candidate that edits a TCB member **and** rewrites `tcb_digest`/`tcb_files`
 *     **and** points `frozen_revision` at the commit containing that edit produces a
 *     self-consistent record that this check cannot distinguish. No external anchor is
 *     available to a purely local reader, and inventing one would be the
 *     attestation/recursion this round explicitly excludes;
 *   - a Candidate that rewrites `tcb.mjs` itself to always return `ok: true` is likewise
 *     beyond a finite self-referential check. `tcb.mjs` is a member, so every *other*
 *     edit of it is drift — but the rewrite that disables the check is, by construction,
 *     the one that reports its own verdict.
 *
 * Both are control-plane forgeries rather than delivery iterations, and both are closed
 * where an external anchor exists: the trusted-CI backend takes `packages/` and
 * `plugins/` from `canonical` (`ci/tools/ci-stage.mjs`) instead of from the candidate,
 * the protected refs forbid rewriting history, and changing the verifier is a separate
 * maintenance flow (docs/TCB.md). `frozen-tcb.test.mjs` pins both residuals explicitly
 * so they cannot be mistaken for protection.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileDigest, git, rel, sha256 } from './common.mjs'

/**
 * Bump this when the TCB *set* (or the meaning of an existing member) changes. A
 * freeze record recorded under another version is drift, not a pass: the version is
 * part of what was frozen.
 *
 * v2 widened the set to every shipped module that decides a verdict or the facts a
 * verdict is computed from (Contract parsing, budget/convergence, MVP readiness, state
 * authority, and the checker itself).
 */
export const TCB_VERSION = 2

/**
 * The files that decide a delivery verdict. Everything here is on the path between
 * a Contract and `Delivered`: Contract/model parsing, Required-set derivation,
 * acceptance-case selection, Evidence validation, backend capability completeness,
 * the frozen-standard check, the freeze digest logic, the Delivered predicate, the
 * verifier launcher/authority boundary, and the subprocess environment the verifier
 * constructs.
 *
 * Paths are relative to the repository that ships the operation pack, so the set is
 * the same whether the pack is the project's own repository or an external install.
 *
 * `tcb.mjs` lists itself. That is not circular in any way that matters: the digest is
 * computed from the file's bytes, and its bytes do not depend on the digest. It means a
 * changed checker is visible as drift to the *frozen* checker — a checker that has been
 * rewritten to always pass still runs, which is the residual limitation documented in
 * docs/TCB.md rather than something a finite file list can solve.
 */
export const TCB_FILES = Object.freeze([
  'packages/delivery-assured/scripts/verify.mjs',
  'packages/delivery-assured/scripts/resume.mjs',
  'packages/delivery-assured/scripts/lib/common.mjs',
  'packages/delivery-assured/scripts/lib/yaml.mjs',
  'packages/delivery-assured/scripts/lib/evidence.mjs',
  'packages/delivery-assured/scripts/lib/model.mjs',
  'packages/delivery-assured/scripts/lib/selection.mjs',
  'packages/delivery-assured/scripts/lib/completion.mjs',
  'packages/delivery-assured/scripts/lib/coverage-core.mjs',
  'packages/delivery-assured/scripts/lib/capability.mjs',
  'packages/delivery-assured/scripts/lib/convergence.mjs',
  'packages/delivery-assured/scripts/lib/mvp.mjs',
  'packages/delivery-assured/scripts/lib/standard-freeze.mjs',
  'packages/delivery-assured/scripts/lib/verification.mjs',
  'packages/delivery-assured/scripts/lib/env.mjs',
  'packages/delivery-assured/scripts/lib/state-view.mjs',
  'packages/delivery-assured/scripts/lib/durable-state.mjs',
  'packages/delivery-assured/scripts/lib/gh-api.mjs',
  'packages/delivery-assured/scripts/lib/worktree-git.mjs',
  'packages/delivery-assured/scripts/lib/tcb.mjs',
  // The launcher/authority boundary of the default completion path and the audited
  // agent-facing surface it registers: they decide which arguments (and therefore which
  // switches) ever reach the verifier.
  'plugins/dsh-delivery-assured/lib/host.js',
  'plugins/dsh-delivery-assured/lib/tool-surface.js',
])

/**
 * The repository that ships the pack. Derived from this module's own location —
 * `…/packages/delivery-assured/scripts/lib/tcb.mjs` — never from configuration or an
 * environment variable, because a configurable TCB root would be an escape hatch.
 */
export function tcbRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
}

/** The TCB members that actually exist under `root`, sorted. */
export function tcbFiles(root = tcbRepoRoot()) {
  return TCB_FILES.filter((relative) => existsSync(join(root, relative)))
}

/** The digest map of the TCB as it is on disk right now. */
export function currentTcbDigests(root = tcbRepoRoot()) {
  const files = {}
  for (const relative of tcbFiles(root)) files[relative] = fileDigest(join(root, relative))
  return files
}

/** The one digest that stands for a TCB file set, independent of key order. */
export function tcbDigest(files) {
  const lines = Object.entries(files || {})
    .map(([path, digest]) => `${path}:${digest}`)
    .sort()
  return sha256(lines.join('\n'))
}

/** Whether `child` is `parent` or lies inside it (both absolute, real paths). */
function isInside(parent, child) {
  const root = resolve(parent).replace(/[\\/]+$/, '')
  const target = resolve(child).replace(/[\\/]+$/, '')
  if (process.platform === 'win32') return target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(`${root.toLowerCase()}\\`)
  return target === root || target.startsWith(`${root}/`)
}

/**
 * Check the TCB against a freeze record.
 *
 * Returns `{ ok, problems, recorded_digest, current_digest, git_checked, external,
 * tcb_version }`. `external` is true when the TCB is not inside the project's Git
 * repository, which is reported rather than treated as proof of immutability.
 */
export function verifyTcb(record, { root = tcbRepoRoot(), projectRoot = null, frozenRevision = null, current = null } = {}) {
  const problems = []
  const recorded = record?.tcb_files && typeof record.tcb_files === 'object' && !Array.isArray(record.tcb_files) ? record.tcb_files : null
  const currentFiles = current || currentTcbDigests(root)
  if (!recorded || Object.keys(recorded).length === 0) {
    return {
      ok: false,
      problems: [
        {
          code: 'TCB_NOT_RECORDED',
          message:
            'the freeze record carries no verifier Trusted Computing Base manifest, so nothing anchors the logic that decides ' +
            'Delivered; re-record the frozen standard in a control-plane step before verifying again',
        },
      ],
      recorded_digest: null,
      current_digest: tcbDigest(currentFiles),
      files: currentFiles,
      git_checked: false,
      external: null,
      tcb_version: record?.tcb_version ?? null,
    }
  }
  if (record.tcb_version !== TCB_VERSION) {
    problems.push({
      code: 'TCB_VERSION_MISMATCH',
      message: `the frozen standard names verifier TCB version ${JSON.stringify(record.tcb_version ?? null)} but this verifier implements version ${TCB_VERSION}`,
    })
  }
  const recordedDigest = tcbDigest(recorded)
  if (record.tcb_digest && record.tcb_digest !== recordedDigest) {
    problems.push({
      code: 'TCB_RECORD_TAMPERED',
      message: 'the freeze record\'s tcb_digest does not match its own tcb_files manifest',
    })
  }
  for (const path of Object.keys(recorded)) {
    if (!(path in currentFiles)) {
      problems.push({ code: 'TCB_DRIFT', message: `${path} is a frozen TCB member that is no longer present` })
    } else if (currentFiles[path] !== recorded[path]) {
      problems.push({ code: 'TCB_DRIFT', message: `${path} differs from the frozen verifier Trusted Computing Base` })
    }
  }
  for (const path of Object.keys(currentFiles)) {
    if (!(path in recorded)) {
      problems.push({ code: 'TCB_DRIFT', message: `${path} joined the verifier Trusted Computing Base after the freeze` })
    }
  }

  // The Git anchor. When the TCB is inside the candidate's repository, the bytes at
  // the frozen revision — not the digest file — decide whether the verifier is the
  // frozen one. `git hash-object` reads the bytes on disk, so no checkout filter can
  // make an edited verifier look like the committed one.
  const revision = frozenRevision || record?.frozen_revision || null
  let gitChecked = false
  let external = null
  if (projectRoot && revision) {
    const topLevel = git(projectRoot, ['rev-parse', '--show-toplevel'])
    if (topLevel.ok && topLevel.out !== '') {
      const top = topLevel.out
      if (isInside(top, root)) {
        gitChecked = true
        external = false
        for (const path of Object.keys(recorded)) {
          const absolute = join(root, path)
          const relative = rel(top, absolute)
          const frozenBlob = git(top, ['rev-parse', `${revision}:${relative}`])
          const worktreeBlob = git(top, ['hash-object', absolute])
          if (!frozenBlob.ok || frozenBlob.out === '' || !worktreeBlob.ok || worktreeBlob.out === '') {
            problems.push({
              code: 'TCB_DRIFT',
              message: `${path} cannot be shown to be the bytes at the frozen revision ${String(revision).slice(0, 12)}; a TCB member this verifier uses must exist there`,
            })
            continue
          }
          if (frozenBlob.out !== worktreeBlob.out) {
            problems.push({
              code: 'TCB_DRIFT',
              message:
                `${path} has bytes that differ from the frozen revision ${String(revision).slice(0, 12)}; ` +
                'rewriting the digest file does not make the deciding logic frozen',
            })
          }
        }
      } else {
        external = true
      }
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    recorded_digest: recordedDigest,
    current_digest: tcbDigest(currentFiles),
    files: currentFiles,
    git_checked: gitChecked,
    external,
    tcb_version: record?.tcb_version ?? null,
  }
}

/** The TCB fields a freeze record carries. */
export function tcbRecord(root = tcbRepoRoot()) {
  const files = currentTcbDigests(root)
  return { tcb_version: TCB_VERSION, tcb_files: files, tcb_digest: tcbDigest(files) }
}

/**
 * May an existing freeze record be re-recorded with this Trusted Computing Base?
 *
 * Re-freezing the *standard* is an ordinary, auditable act (a Contract or spec change
 * recorded in the history). Re-freezing the *verifier* is not: it would let a
 * Candidate modify the logic that decides its own verdict and then legalize the
 * change by rewriting the digest. That takes the control-plane promotion described in
 * docs/TCB.md.
 *
 * The `allowTcbChange` authorization is **not a security boundary** and is not claimed
 * as one: the session has a shell and can run this CLI directly. What it buys is that
 * the change cannot happen *silently* — it is refused by default, and when authorized it
 * is recorded as `from_tcb_digest`/`to_tcb_digest` in the freeze history, so "the
 * verifier was replaced" stays visible in the record. The actual boundaries are outside
 * this process: the trusted-CI backend stages the pack from `canonical`, the protected
 * refs forbid rewriting history, and promoting a new verifier version is a separate
 * reviewed change (docs/TCB.md).
 *
 * A record written before the TCB existed (no `tcb_digest`) is a schema upgrade, not a
 * TCB change: it is anchored for the first time, and its previous value is recorded as
 * null so the history shows exactly what happened.
 */
export function tcbChangeAuthorization(existing, next, { allowTcbChange = false } = {}) {
  if (!existing || !existing.tcb_digest) return { ok: true, reason: existing ? 'the freeze record predates the verifier TCB manifest' : 'first freeze' }
  if (existing.tcb_digest === next?.tcb_digest) return { ok: true, reason: 'the verifier Trusted Computing Base is unchanged' }
  if (allowTcbChange === true) return { ok: true, reason: 'explicit control-plane authorization', changed: true }
  return {
    ok: false,
    changed: true,
    problem:
      'TCB_CHANGE_REQUIRES_CONTROL_PLANE: the verifier Trusted Computing Base differs from the frozen one ' +
      `(${String(existing.tcb_digest).slice(0, 12)} -> ${String(next?.tcb_digest).slice(0, 12)}); ` +
      'a Candidate may not re-record the logic that decides its own Delivered verdict. Promote the new verifier ' +
      'version in a separate maintenance flow (docs/TCB.md) — that flow, not this one, carries the authorization.',
  }
}
