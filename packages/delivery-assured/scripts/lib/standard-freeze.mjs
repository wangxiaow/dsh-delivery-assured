/**
 * The frozen-standard anchor for host-executed verification.
 *
 * The trusted-CI backend proves the acceptance standard is frozen by comparing the
 * candidate's `tests/acceptance/spec` with a protected `standards/acceptance` ref.
 * An ordinary project has no such ref, so the default backend needs its own anchor
 * that is just as concrete: one record holding the SHA-256 of every protected
 * standard file at freeze time, plus the revision those bytes were committed at.
 *
 * What that buys:
 *   - a Required case cannot be rewritten, deleted or added to after freeze without
 *     the verification refusing (`STANDARD_DRIFT`), because every byte is compared;
 *   - the freeze is not silently re-created: re-freezing an existing standard needs
 *     `--allow-standard-change` and appends an audit entry naming the previous
 *     standard id, so a changed standard is visible in the delivered record;
 *   - the bytes must be the *committed* bytes at `frozen_revision` (compared through
 *     Git blob ids, which no smudge filter touches), so an uncommitted edit cannot
 *     be frozen into looking original.
 *
 * The accumulated Spine is deliberately NOT part of the freeze: it is a growing
 * durable artifact (the record of what a verified candidate proved), not the
 * standard. Only the Contract, the project configuration, the acceptance manifest
 * and its spec files, the verifier configuration and the Slice declarations are.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { abs, fileDigest, git, listFiles, readJson, readYaml, sha256, rel } from './common.mjs'
import { DEFAULT_FREEZE_PATH } from './verification.mjs'
import { TCB_VERSION, currentTcbDigests, tcbChangeAuthorization, tcbDigest, tcbRepoRoot, verifyTcb } from './tcb.mjs'

export const FREEZE_SCHEMA = 1

/** Project-relative paths whose bytes are the frozen standard. */
export function freezeFiles(root, cfg) {
  const out = new Set()
  const add = (p) => {
    if (!p) return
    const absolute = abs(root, p)
    if (absolute && existsSync(absolute)) out.add(rel(root, absolute).replace(/\\/g, '/'))
  }
  add(cfg.paths.contract)
  add('.agent/project.yaml')
  add(cfg.paths.acceptanceManifest)
  add(cfg.paths.verifier)
  for (const dir of [cfg.paths.acceptanceSpec, cfg.paths.slices]) {
    const absolute = abs(root, dir)
    if (!absolute) continue
    for (const file of listFiles(absolute, () => true)) {
      const relative = rel(root, file).replace(/\\/g, '/')
      // The acceptance manifest is added explicitly; the driver is the Candidate's own
      // adaptation surface and is never part of the frozen standard.
      if (relative === cfg.paths.acceptanceManifest) continue
      if (relative.startsWith('tests/acceptance/driver/')) continue
      out.add(relative)
    }
  }
  return [...out].sort()
}

export function freezePath(root, resolved) {
  return abs(root, resolved?.freezePath || DEFAULT_FREEZE_PATH)
}

export function readFreeze(root, resolved) {
  return readJson(freezePath(root, resolved), { required: false })
}

/** The digest map of the standard as it is on disk right now. */
export function currentFileDigests(root, cfg) {
  const files = {}
  for (const relative of freezeFiles(root, cfg)) files[relative] = fileDigest(join(root, relative))
  return files
}

function standardIdOf(files) {
  const lines = Object.entries(files)
    .map(([path, digest]) => `${path}:${digest}`)
    .sort()
  return sha256(lines.join('\n'))
}

/**
 * Create or replace the freeze record.
 *
 * `allowStandardChange` is the explicit, auditable escape: without it an existing
 * record is never overwritten (a verification would otherwise be able to re-freeze
 * the very standard it is judging).
 *
 * The verifier's Trusted Computing Base is recorded alongside the standard, but it is
 * *not* a standard file a Candidate may change in the same round: re-freezing a changed
 * TCB needs `allowTcbChange`, which the agent-facing surface never passes. That flag is
 * an auditability control, not a security boundary — the session has a shell — so the
 * real boundaries stay outside this process (see docs/TCB.md and lib/tcb.mjs).
 */
export function createFreeze(root, cfg, resolved, { at = new Date().toISOString(), allowStandardChange = false, reason = null, allowTcbChange = false, tcbRoot = tcbRepoRoot() } = {}) {
  const path = freezePath(root, resolved)
  const files = currentFileDigests(root, cfg)
  if (Object.keys(files).length === 0) {
    return { ok: false, problems: [`no protected standard file was found under ${root}; there is nothing to freeze`] }
  }
  const tcbFilesNow = currentTcbDigests(tcbRoot)
  const tcb = { tcb_version: TCB_VERSION, tcb_files: tcbFilesNow, tcb_digest: tcbDigest(tcbFilesNow) }
  const existing = readJson(path, { required: false })
  if (existing && !allowStandardChange) {
    return {
      ok: false,
      problems: [
        `a frozen standard already exists (${existing.standard_id}) at ${rel(root, path)}; ` +
          're-freezing requires --allow-standard-change so the change is recorded instead of erased',
      ],
      existing,
    }
  }
  // A changed TCB is not a standard change a Candidate may perform on itself. It is
  // refused here rather than silently recorded, so "the verifier was upgraded" is
  // always an explicit control-plane act with its own review (docs/TCB.md).
  const authorization = tcbChangeAuthorization(existing, tcb, { allowTcbChange })
  if (!authorization.ok) {
    return { ok: false, problems: [authorization.problem], existing, tcb }
  }
  const revision = git(root, ['rev-parse', 'HEAD']).ok ? git(root, ['rev-parse', 'HEAD']).out : null
  const manifestPath = abs(root, cfg.paths.acceptanceManifest)
  const manifest = manifestPath && existsSync(manifestPath) ? readYaml(manifestPath, { required: false }) : null
  const standardId = standardIdOf(files)
  const record = {
    schema: FREEZE_SCHEMA,
    standard_id: standardId,
    frozen_at: at,
    frozen_revision: revision,
    manifest_revision: manifest?.revision ?? null,
    files,
    ...tcb,
    previous_standard_id: existing?.standard_id ?? null,
    previous_tcb_digest: existing?.tcb_digest ?? null,
    history: [
      ...(Array.isArray(existing?.history) ? existing.history : []),
      ...(existing
        ? [{
            at,
            from_standard_id: existing.standard_id,
            to_standard_id: standardId,
            from_tcb_digest: existing.tcb_digest ?? null,
            to_tcb_digest: tcb.tcb_digest,
            reason: reason || '(no reason recorded)',
          }]
        : []),
    ],
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { ok: true, record, path, changed: Boolean(existing), tcb }
}

/**
 * Verify that the standard on disk is exactly the frozen one, and that it is the
 * committed one at the recorded revision.
 *
 * Returns `{ ok, problems, record, drift }`. `committed_verified` says whether the
 * Git cross-check actually ran; it is `null` when the project has no Git revision to
 * compare against, which the evidence validator reports as a limitation rather than
 * as proof.
 */
export function verifyFreeze(root, cfg, resolved, { requireRecord = true, tcbRoot = tcbRepoRoot() } = {}) {
  const path = freezePath(root, resolved)
  const record = readJson(path, { required: false })
  const problems = []
  if (!record) {
    return {
      ok: false,
      problems: [
        {
          code: 'FREEZE_MISSING',
          message:
            `no frozen standard is recorded at ${rel(root, path)}; the host verifier cannot prove the acceptance ` +
            'it is about to run is the frozen one (run verify.mjs --freeze-standard once, before implementing)',
        },
      ],
      record: null,
      committed_verified: null,
      tcb: null,
    }
  }
  if (record.schema !== FREEZE_SCHEMA) {
    problems.push({ code: 'FREEZE_SCHEMA', message: `freeze record schema ${JSON.stringify(record.schema ?? null)} is not supported` })
  }
  const recorded = record.files && typeof record.files === 'object' ? record.files : {}
  const current = currentFileDigests(root, cfg)
  const paths = [...new Set([...Object.keys(recorded), ...Object.keys(current)])].sort()
  const drift = []
  for (const relative of paths) {
    const before = recorded[relative] || null
    const now = current[relative] || null
    if (before === now) continue
    drift.push({
      path: relative,
      frozen: before,
      current: now,
      kind: before === null ? 'added' : now === null ? 'removed' : 'modified',
    })
  }
  for (const entry of drift) {
    problems.push({
      code: 'STANDARD_DRIFT',
      message: `${entry.path} is ${entry.kind} relative to the frozen standard (${record.standard_id})`,
    })
  }
  if (record.standard_id !== standardIdOf(recorded)) {
    problems.push({ code: 'FREEZE_TAMPERED', message: 'the freeze record does not match its own standard id' })
  }

  // The verifier Trusted Computing Base is re-checked here, before a single gate runs.
  // A Candidate that edited the logic which decides its own verdict cannot verify
  // itself with it, and rewriting the recorded digest does not help when the TCB lives
  // inside this repository: the comparison is against Git blobs at the frozen revision.
  const tcb = verifyTcb(record, { root: tcbRoot, projectRoot: root, frozenRevision: record.frozen_revision })
  for (const problem of tcb.problems) problems.push(problem)

  // Committed-bytes cross-check. Git blob ids are computed over the bytes in the
  // object database, so no checkout/line-ending filter can make an edited file look
  // like the committed one.
  let committedVerified = null
  if (record.frozen_revision) {
    const probe = git(root, ['rev-parse', `${record.frozen_revision}^{commit}`])
    if (!probe.ok) {
      committedVerified = false
      problems.push({
        code: 'FREEZE_REVISION_UNREADABLE',
        message: `the frozen revision ${record.frozen_revision} cannot be read in this repository: ${probe.err}`,
      })
    } else {
      committedVerified = true
      for (const relative of Object.keys(recorded)) {
        const head = git(root, ['rev-parse', `${record.frozen_revision}:${relative}`])
        const worktree = git(root, ['hash-object', join(root, relative)])
        if (!head.ok || !worktree.ok) {
          if (head.err.includes('unknown revision') || head.err.includes('does not exist') || /exists on disk, but not in/.test(head.err)) {
            committedVerified = false
            problems.push({
              code: 'FREEZE_NOT_FROZEN_BY_COMMIT',
              message: `${relative} is not part of the frozen revision ${record.frozen_revision}; the standard was added after it was frozen`,
            })
            continue
          }
          committedVerified = null
          break
        }
        if (head.out !== worktree.out) {
          committedVerified = false
          problems.push({
            code: 'FREEZE_UNCOMMITTED_EDIT',
            message: `${relative} has uncommitted bytes that differ from the frozen revision ${record.frozen_revision}`,
          })
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, record, drift, committed_verified: committedVerified, tcb }
}
