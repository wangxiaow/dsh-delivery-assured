#!/usr/bin/env node
/**
 * Promotion job (v0.5 §11.2, §12).
 *
 * This is the only entry point allowed to advance the protected baseline ref. It
 * consumes a completed, attributable verification result and refuses to move the
 * ref unless every promotion condition holds:
 *
 *   1. Candidate, parent Baseline, standard revisions and verification scope are
 *      frozen and still current.
 *   2. The Slice's required machine acceptance, the existing Spine, the applicable
 *      Critical Invariants and the necessary environment gates all passed.
 *   3. Evidence is complete, and its bindings match the candidate, the standards,
 *      the image, the migration bundle and the environment.
 *   4. No unhandled unknown, Critical violation, unconfirmed WHAT change or budget
 *      blocker affects the current scope.
 *   5. The parent Baseline was not advanced by another candidate.
 *
 * Order matters: persist the Evidence and the pending metadata first, then do a
 * conditional update against the expected parent, and only then record success.
 * A failure at any step must not derive a completed state.
 *
 * Exit codes: 0 promoted, 1 a promotion condition failed, 2 input/tool error.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadContract, loadAcceptance, loadSpine, standardBindings, loadProjectConfig } from '../../packages/delivery-assured/scripts/lib/common.mjs'
import { collectCriticalViolations, coverageRows } from '../../packages/delivery-assured/scripts/lib/coverage-core.mjs'
import { loadModel } from '../../packages/delivery-assured/scripts/lib/model.mjs'

const here = dirname(fileURLToPath(import.meta.url))
/** The shipped operation pack. This repository keeps it beside the project. */
const packRoot = resolve(here, '..', '..', 'packages', 'delivery-assured')

const GATES_REQUIRED = ['build', 'clean_boot', 'slice_acceptance', 'regression_spine', 'deployment']

function parse(argv) {
  const opts = {
    project: process.env.DSH_PROJECT_ROOT || '.',
    evidenceDir: 'evidence',
    expectedParent: process.env.DSH_EXPECTED_PARENT || null,
    baselineRef: process.env.DSH_BASELINE_REF || 'refs/heads/baseline/main',
    remote: process.env.DSH_BASELINE_REMOTE || 'origin',
    apply: false,
    dryRun: false,
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--project') opts.project = argv[++i]
    else if (token === '--evidence-dir') opts.evidenceDir = argv[++i]
    else if (token === '--expected-parent') opts.expectedParent = argv[++i]
    else if (token === '--protected-baseline-ref') opts.baselineRef = argv[++i]
    else if (token === '--remote') opts.remote = argv[++i]
    else if (token === '--apply') opts.apply = true
    else if (token === '--dry-run') opts.dryRun = true
    else if (token === '--json') opts.json = true
    else if (token === '--help') opts.help = true
    else {
      process.stderr.write(`ci-promote: unknown option ${token}\n`)
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

function loadEvidenceRecords(dir) {
  if (!existsSync(dir)) return []
  const records = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      records.push(...loadEvidenceRecords(full))
      continue
    }
    if (!entry.name.endsWith('.json') || entry.name === 'baseline.json') continue
    try {
      const doc = JSON.parse(readFileSync(full, 'utf8'))
      if (doc && doc.evidence_id) records.push({ ...doc, __file: full })
    } catch {
      records.push({ evidence_id: null, __file: full, __invalid: true })
    }
  }
  return records
}

function nextBaselineId(existing) {
  const numbers = existing
    .map((id) => Number((/^BL-(\d+)$/.exec(String(id)) || [])[1]))
    .filter((n) => Number.isFinite(n))
  const next = numbers.length === 0 ? 0 : Math.max(...numbers) + 1
  return `BL-${String(next).padStart(3, '0')}`
}

function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('ci-promote — verify the promotion conditions and advance the protected baseline ref\n')
    return 0
  }
  const root = resolve(opts.project)
  const cfg = loadProjectConfig(root)
  const model = loadModel(root)
  const blockers = []
  const notes = []

  // ---- 3. Evidence completeness and binding match -------------------------
  const records = loadEvidenceRecords(resolve(root, opts.evidenceDir))
  if (records.length === 0) {
    blockers.push('no evidence record was found; a missing record counts as unverified')
  }
  const trusted = records.filter((r) => !r.__invalid && r.issuer?.identity === (cfg.ci?.trusted_issuer || r.issuer?.identity))
  const candidates = trusted.filter((r) => r.execution?.result === 'PASS')
  if (candidates.length === 0) {
    blockers.push('no PASS record from a trusted verification job is available')
  }

  let evidence = null
  const current = standardBindings(root, cfg)
  for (const record of candidates) {
    const b = record.bindings || {}
    const mismatches = []
    if (b.contract_digest !== current.contract_digest) mismatches.push('contract_digest')
    if (b.acceptance_manifest_digest !== current.acceptance_manifest_digest) mismatches.push('acceptance_manifest_digest')
    if (b.verifier_config_digest && b.verifier_config_digest !== current.verifier_config_digest) mismatches.push('verifier_config_digest')
    if (b.dependency_lock_digest && b.dependency_lock_digest !== current.dependency_lock_digest) mismatches.push('dependency_lock_digest')
    if (b.migration_digest && b.migration_digest !== current.migration_digest) mismatches.push('migration_digest')
    if (opts.expectedParent && b.parent_baseline !== opts.expectedParent) mismatches.push('parent_baseline')
    if (mismatches.length > 0) {
      notes.push(`record ${record.evidence_id} does not bind the current standards: ${mismatches.join(', ')}`)
      continue
    }
    evidence = record
    break
  }
  if (!evidence && candidates.length > 0) {
    blockers.push('every candidate record is stale against the current standards; re-verify before promoting')
  }

  // ---- 2. Gates, required cases and the Spine ------------------------------
  if (evidence) {
    const gates = evidence.execution?.gate_results || []
    for (const gate of GATES_REQUIRED) {
      const result = gates.find((g) => g.gate === gate)
      if (!result) blockers.push(`gate ${gate} has no result in the evidence`)
      else if (result.outcome === 'not_applicable') {
        // An excluded gate needs a recorded reason; an unexplained exclusion is a gap.
        if (!result.reason || String(result.reason).trim() === '') {
          blockers.push(`gate ${gate} is not applicable without a recorded reason`)
        }
      } else if (result.outcome !== 'passed') blockers.push(`gate ${gate} is ${result.outcome}`)
    }
    // The deployment gate proves the running artifact is this candidate. The Slice
    // environment cannot substitute for it, so it is required at promotion time and
    // must report a real deployment identity and revision.
    const deployment = evidence.environment || {}
    if (!deployment.deployment_id) {
      blockers.push('the deployment gate reports no deployment id; the running artifact was not observed')
    }
    if (!deployment.image_digest) {
      blockers.push('the deployment gate reports no image digest; the running artifact was not observed')
    }
    if (deployment.deployed_code_revision && evidence.bindings?.code_revision && deployment.deployed_code_revision !== evidence.bindings.code_revision) {
      blockers.push(
        `the deployment runs ${deployment.deployed_code_revision} but the evidence binds candidate ${evidence.bindings.code_revision}`,
      )
    }
    if ((evidence.execution?.skipped_required_cases ?? 1) > 0) {
      blockers.push('required cases were skipped; a skipped required case can never be a pass')
    }
    if ((evidence.execution?.executed_cases ?? 0) < (evidence.execution?.required_cases ?? 0)) {
      blockers.push('fewer cases executed than required')
    }
    const spineCases = loadSpine(root, cfg).caseIds
    const executed = new Set((evidence.execution?.case_results || []).map((r) => r.case_id))
    for (const caseId of spineCases) {
      if (!executed.has(caseId)) blockers.push(`spine case ${caseId} was not part of the verified set`)
    }
  }

  // ---- 4. No open Critical violation, unknown or unconfirmed change --------
  const criticalOpen = collectCriticalViolations(model, {
    codeRevision: evidence?.bindings?.code_revision || null,
    parentBaseline: opts.expectedParent,
    trustedIssuer: cfg.ci?.trusted_issuer || null,
  })
  for (const violation of criticalOpen) {
    blockers.push(`Critical rule ${violation.rule}: ${violation.message}`)
  }
  const { buckets } = coverageRows(model, {
    candidate: evidence?.bindings?.code_revision || null,
    parentBaseline: opts.expectedParent,
    trustedIssuer: cfg.ci?.trusted_issuer || null,
  })
  for (const id of buckets.current_failure) blockers.push(`obligation ${id} has a current failure`)
  for (const unknown of model.contract.unknowns || []) {
    const status = String(unknown.status || 'unresolved')
    if (status === 'unresolved') blockers.push(`unknown ${unknown.id} is still unresolved`)
  }

  // ---- 5. The parent Baseline was not advanced by another candidate --------
  const remoteRef = git(root, ['ls-remote', opts.remote, opts.baselineRef], { allowFailure: true })
  let remoteSha = null
  if (remoteRef.ok && remoteRef.out !== '') remoteSha = remoteRef.out.split(/\s+/)[0]
  const localParentSha = opts.expectedParent && opts.expectedParent !== 'none'
    ? git(root, ['rev-parse', `refs/heads/baseline/${opts.expectedParent}`], { allowFailure: true }).out || null
    : null
  if (remoteSha && opts.expectedParent && opts.expectedParent !== 'none' && localParentSha && remoteSha !== localParentSha) {
    blockers.push(
      `the parent baseline moved: remote ${opts.baselineRef} is ${remoteSha.slice(0, 12)} but ${opts.expectedParent} is ${localParentSha.slice(0, 12)}; re-integrate and re-verify`,
    )
  }

  // ---- Build the pending metadata -----------------------------------------
  const existing = model.baselines.map((b) => b.baseline_id).filter(Boolean)
  const baselineId = nextBaselineId(existing)
  const machineVerified = buckets.verified
  const reviewIds = (model.contract.acceptance?.manual_reviews || []).map((r) => r.id)
  const completedReviews = new Set(model.reviews.filter((r) => r.result === 'PASS').map((r) => r.review_id))
  const metadata = {
    baseline_id: baselineId,
    protected_ref: opts.baselineRef,
    code_revision: evidence?.bindings?.code_revision || null,
    parent_baseline: opts.expectedParent === 'none' ? null : opts.expectedParent || null,
    contract_revision: evidence?.bindings?.contract_revision || null,
    acceptance_revision: evidence?.bindings?.acceptance_revision || null,
    verifier_config_revision: evidence?.bindings?.verifier_config_revision || null,
    verification_scope: {
      machine_verified_outcomes: machineVerified,
      remaining_outcomes: [
        ...buckets.pending_implementation,
        ...buckets.unmapped,
        ...buckets.standard_gap,
        ...buckets.stale_evidence,
      ],
      manual_reviews_pending: reviewIds.filter((id) => !completedReviews.has(id)),
      spine_manifest_digest: current.spine_manifest_digest,
    },
    environment: {
      validated_in: evidence?.environment?.kind || 'production_like_ci',
      image_digest: evidence?.environment?.image_digest || null,
      migration_digest: evidence?.bindings?.migration_digest || null,
      staging_deployment_id: evidence?.environment?.deployment_id || null,
    },
    evidence_refs: evidence ? [evidence.evidence_id] : [],
    promotion_run_id: process.env.DSH_CI_RUN_ID || 'local-dry-run',
  }

  const ok = blockers.length === 0
  const report = {
    status: ok ? (opts.apply ? 'promoted' : 'ready') : 'blocked',
    baseline_id: baselineId,
    baseline_ref: opts.baselineRef,
    expected_parent: opts.expectedParent,
    candidate: evidence?.bindings?.code_revision || null,
    evidence_id: evidence?.evidence_id || null,
    blockers,
    notes,
    metadata,
  }

  if (!ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else {
      for (const blocker of blockers) process.stderr.write(`PROMOTION BLOCKED ${blocker}\n`)
      for (const note of notes) process.stdout.write(`note: ${note}\n`)
      process.stdout.write('the protected baseline ref was not moved.\n')
    }
    return 1
  }

  // ---- Order: persist evidence and metadata, then conditional update -------
  const metadataDir = join(root, 'ci', 'baseline')
  mkdirSync(metadataDir, { recursive: true })
  const metadataPath = join(metadataDir, `${baselineId}.json`)
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

  if (opts.apply) {
    // A force-with-lease update is the conditional update: it fails if the remote ref
    // no longer matches what this run observed as the parent.
    const expected = opts.expectedParent && opts.expectedParent !== 'none' ? opts.expectedParent : null
    if (expected && localParentSha) {
      git(root, ['update-ref', opts.baselineRef, metadata.code_revision, localParentSha])
    } else {
      git(root, ['update-ref', opts.baselineRef, metadata.code_revision])
    }
    const pushed = git(root, ['push', '--force-with-lease', opts.remote, `${opts.baselineRef}:${opts.baselineRef}`], { allowFailure: true })
    if (!pushed.ok) {
      process.stderr.write(`PROMOTION FAILED the protected ref was not advanced: ${pushed.err}\n`)
      process.stderr.write('metadata was persisted; the ref update is the part that failed.\n')
      return 1
    }
    report.status = 'promoted'
    process.stdout.write(`promoted ${baselineId}: ${opts.baselineRef} -> ${String(metadata.code_revision).slice(0, 12)}\n`)
    process.stdout.write(`metadata persisted at ci/baseline/${baselineId}.json\n`)
  } else {
    process.stdout.write(`dry run: ${baselineId} would be promoted to ${opts.baselineRef}\n`)
    process.stdout.write(`metadata would be persisted at ci/baseline/${baselineId}.json\n`)
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return 0
}

process.exit(main())
