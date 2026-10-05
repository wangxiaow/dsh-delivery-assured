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
  blockingForView,
  collectCriticalViolations,
  coverageRows,
  fetchDurableState,
  findProjectRoot,
  gitRevision,
  loadModel,
} from '../../../packages/delivery-assured/scripts/lib/index.mjs'

export async function statusCommand(opts) {
  const root = findProjectRoot(opts.project)
  // The Baseline metadata, Evidence and accumulated Spine live on the durable-state ref;
  // CI overlays it before verifying, and `--durable-state` gives the CLI the same
  // read-only view so `delivery status` can see the delivered Baseline instead of
  // reporting that none was recorded locally.
  const durable = opts['durable-state']
    ? fetchDurableState({ repoRoot: root, fallbackRoot: root })
    : { available: false, sha: null, root: null, reason: null, dispose() {} }
  let model
  try {
    model = loadModel(root, { stateRoot: durable.available ? durable.root : null })
  } catch (error) {
    durable.dispose?.()
    if (error instanceof InputError) {
      throw new InputError(`${error.message} (looked for a delivery repository at ${root})`)
    }
    throw error
  }

  const candidate = gitRevision(root, 'HEAD')
  const trustedIssuer = model.cfg.ci?.trusted_issuer || null
  const localBaseline = model.baselines.length > 0 ? model.baselines[model.baselines.length - 1] : null
  const { rows, buckets, gapClasses } = coverageRows(model, {
    candidate,
    parentBaseline: localBaseline?.baseline_id || null,
    trustedIssuer,
    includeOptional: opts.all === true,
  })
  const critical = collectCriticalViolations(model, {
    codeRevision: candidate,
    parentBaseline: localBaseline?.baseline_id || null,
    trustedIssuer,
  })
  const blocking = blockingForView(buckets, 'mvp')

  const payload = {
    report_kind: 'local_diagnostic',
    note:
      'A local run is a diagnostic. Evidence comes only from the trusted CI verifier, and only its Promotion job may advance the protected baseline reference.',
    project: root,
    candidate,
    trusted_issuer: trustedIssuer,
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
    exit_code: blocking.length > 0 || critical.length > 0 ? EXIT.FAIL : EXIT.PASS,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return payload.exit_code
  }

  const out = []
  out.push(`report kind : ${payload.report_kind}`)
  out.push(`project     : ${root}`)
  out.push(`candidate   : ${candidate ? candidate.slice(0, 12) : '(no git revision)'}`)
  out.push(`baseline    : ${payload.baseline ? `${payload.baseline.baseline_id} @ ${String(payload.baseline.code_revision).slice(0, 12)}` : '(none recorded locally)'}`)
  out.push(`trusted CI  : ${trustedIssuer || '(not configured)'}`)
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
  durable.dispose?.()
  return payload.exit_code
}
