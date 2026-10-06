/**
 * `delivery status` — the observable behaviour of the first vertical slice.
 *
 * Every fact is recomputed from the Contract, the frozen acceptance manifest and
 * CI records through the same core the five scripts use. `.agent/STATE.yaml` is a
 * hint only; a local run is labelled `local_diagnostic` and can never produce a
 * VERIFIED status on its own.
 */

import {
  EXIT,
  InputError,
  STATE_SOURCE,
  assessDelivery,
  blockingForView,
  collectCriticalViolations,
  coverageRows,
  findProjectRoot,
  openStateView,
  resolveVerification,
  worktreeRevision,
} from '../../../packages/delivery-assured/scripts/lib/index.mjs'

export async function statusCommand(opts) {
  const root = findProjectRoot(opts.project)
  // The Baseline metadata, Evidence and accumulated Spine live on the durable-state ref;
  // CI overlays it before verifying, and `--durable-state` gives the CLI the same
  // read-only view so `delivery status` can see the delivered Baseline instead of
  // reporting that none was recorded locally. The shared view keeps this reader, resume
  // and the plugin tools on one source and one budget calculation.
  const view = openStateView(root, {
    source: opts['durable-state'] ? STATE_SOURCE.DURABLE_REF : STATE_SOURCE.WORKTREE,
    repoRoot: root,
    fallbackRoot: root,
    transport: opts['state-transport'] || 'auto',
    repo: opts['state-repo'] || null,
  })
  let model
  try {
    model = view.model
  } catch (error) {
    view.dispose()
    if (error instanceof InputError) {
      throw new InputError(`${error.message} (looked for a delivery repository at ${root})`)
    }
    throw error
  }

  const candidateSource = worktreeRevision(root, 'HEAD')
  const candidate = candidateSource.revision
  const trustedIssuer = model.cfg.ci?.trusted_issuer || null
  const verification = view.verification || resolveVerification(model.cfg)
  const acceptedIssuers = verification.acceptedIssuers
  const localBaseline = model.baselines.length > 0 ? model.baselines[model.baselines.length - 1] : null
  const { rows, buckets, gapClasses } = coverageRows(model, {
    candidate,
    parentBaseline: localBaseline?.baseline_id || null,
    trustedIssuer,
    acceptedIssuers,
    includeOptional: opts.all === true,
  })
  const critical = collectCriticalViolations(model, {
    codeRevision: candidate,
    parentBaseline: localBaseline?.baseline_id || null,
    trustedIssuer,
    acceptedIssuers,
  })
  const blocking = blockingForView(buckets, 'mvp')
  const authority = view.authority
  // `--durable-state` that could not be read is not a smaller answer: the statuses below
  // would describe the working tree instead of the platform's state. It fails, and the
  // report says which channel failed. A repository that simply has no durable-state ref
  // (the host-executed default) is not a failed read.
  const degraded = opts['durable-state'] === true && authority.degraded
  // The one delivery verdict, computed from executed records — never from a declaration.
  const delivery = assessDelivery(model, {
    candidate,
    parentBaseline: localBaseline?.baseline_id || null,
    trustedIssuer,
    acceptedIssuers,
    verification,
  })

  const payload = {
    report_kind: 'local_diagnostic',
    note:
      'A local run is a diagnostic. Completion requires an independent execution of the frozen Required set on this exact ' +
      `candidate (backend: ${verification.backend}); a declaration, a stale record or a STATE marker is not a pass.`,
    project: root,
    candidate,
    candidate_source: candidateSource.source,
    trusted_issuer: trustedIssuer,
    verification: {
      backend: verification.backend,
      declared: verification.declared,
      declared_value: verification.declared_value,
      accepted_issuers: acceptedIssuers,
      trusted_ci_configured: verification.trustedCiConfigured,
      problems: verification.problems,
    },
    delivered: delivery.delivered,
    delivery: {
      completion_mode: delivery.completion_mode,
      backend: delivery.backend,
      blocking: delivery.blocking,
      blocking_entries: delivery.blocking_entries,
      capability: delivery.capability,
      limitations: delivery.limitations,
      verification: delivery.verification
        ? {
            evidence_id: delivery.verification.evidence_id,
            issuer: delivery.verification.issuer,
            backend: delivery.verification.backend,
            required_cases: delivery.verification.required_cases,
            executed_cases: delivery.verification.executed_cases,
            skipped_required_cases: delivery.verification.skipped_required_cases,
            deployment_observed: delivery.verification.deployment_observed,
          }
        : null,
    },
    state_authority: authority.kind,
    state_authoritative: authority.authoritative,
    state_degraded: authority.degraded,
    state_degraded_reason: authority.reason,
    durable_state: {
      requested: opts['durable-state'] === true,
      available: view.durable.available === true,
      sha: view.durable.sha || null,
      transport: view.durable.transport || null,
      worktree_filled: authority.worktree_filled,
      attempted: authority.attempted,
      reason: view.durable.reason || null,
    },
    baseline: localBaseline
      ? { baseline_id: localBaseline.baseline_id, code_revision: localBaseline.code_revision }
      : null,
    required_obligations: rows.length,
    statuses: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      reason: row.reason,
      slices: row.slices,
      acceptance: row.acceptance,
      manual_reviews: row.manual_reviews,
    })),
    buckets,
    gap_classes: gapClasses,
    critical_without_current_pass: critical,
    blocking,
    exit_code: degraded || blocking.length > 0 || critical.length > 0 ? EXIT.FAIL : EXIT.PASS,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    view.dispose()
    return payload.exit_code
  }

  const out = []
  out.push(`report kind : ${payload.report_kind}`)
  out.push(`project     : ${root}`)
  out.push(`candidate   : ${candidate ? candidate.slice(0, 12) : '(no git revision)'}`)
  out.push(`state source: ${authority.kind}${authority.transport ? ` (${authority.transport})` : ''}`)
  if (degraded) out.push(`BLOCK       : ${authority.reason}`)
  out.push(`baseline    : ${payload.baseline ? `${payload.baseline.baseline_id} @ ${String(payload.baseline.code_revision).slice(0, 12)}` : '(none recorded locally)'}`)
  out.push(`trusted CI  : ${trustedIssuer || '(not configured)'}`)
  out.push(`source      : ${authority.kind}${authority.transport ? ` (${authority.transport})` : ''}`)
  out.push(`verification: ${verification.backend}${verification.declared ? '' : ' (default; nothing was declared)'}`)
  out.push(
    `delivered   : ${delivery.delivered ? 'yes' : 'no'}` +
      (delivery.verification
        ? ` — ${delivery.verification.evidence_id} (${delivery.verification.backend}, ${delivery.verification.executed_cases}/${delivery.verification.required_cases} cases executed)`
        : ' — no independent execution of the frozen Required set covers this candidate'),
  )
  out.push('')
  out.push(`required obligations: ${rows.length}`)
  out.push('')
  out.push('obligation                        kind       status                      basis')
  out.push('-'.repeat(112))
  for (const row of rows) {
    out.push(
      [row.id.padEnd(33), row.kind.padEnd(10), row.status.padEnd(27), row.reason].join(' '),
    )
  }
  out.push('')
  out.push(
    `verified ${buckets.verified.length} | pending ${buckets.pending_implementation.length} | unmapped ${buckets.unmapped.length} | ` +
      `standard_gap ${buckets.standard_gap.length} | failure ${buckets.current_failure.length} | ` +
      `stale ${buckets.stale_evidence.length} | review_pending ${buckets.review_pending.length}`,
  )
  if (critical.length > 0) {
    out.push('')
    out.push('critical rules without a current pass from the trusted verifier:')
    for (const violation of critical) out.push(`  BLOCK ${violation.rule}: ${violation.message}`)
  }
  out.push('')
  out.push('still owed:')
  out.push(`  discovery / standard     ${gapClasses.discovery_or_standard.join(', ') || '-'}`)
  out.push(`  execution                ${gapClasses.execution.join(', ') || '-'}`)
  out.push(`  regression / environment ${gapClasses.regression_or_environment.join(', ') || '-'}`)
  out.push('')
  out.push(payload.note)
  process.stdout.write(`${out.join('\n')}\n`)
  view.dispose()
  return payload.exit_code
}
