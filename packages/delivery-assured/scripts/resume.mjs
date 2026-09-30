#!/usr/bin/env node
/**
 * resume — rebuild the trustworthy starting point after any gap, session change
 * or machine change (v0.5 §14.2).
 *
 * Fixed order: protected references → CI evidence and attempts → recomputed
 * Coverage → local working-tree diff → recovery summary → suggested next action.
 *
 * It never reports a promotion or MVP_READY it cannot verify, and never treats
 * `.agent/STATE.yaml` as proof. Offline or without remote access it still prints
 * a bounded diagnostic and says so explicitly.
 *
 * Exit codes: 0 summary produced and nothing blocking, 1 blocking condition found,
 *             2 input/tool error.
 */

import { EXIT, InputError, abs, findProjectRoot, finish, gitDirty, gitRevision, parseArgs, remoteRef, rel } from './lib/common.mjs'
import { STATUS, coverageRows } from './lib/coverage-core.mjs'
import { loadModel } from './lib/model.mjs'

function main() {
  const opts = parseArgs(process.argv.slice(2), {
    project: 'value',
    offline: 'boolean',
    json: 'boolean',
    quiet: 'boolean',
    'fetch-remote': 'boolean',
  })
  if (opts.help) {
    process.stdout.write('resume — print the trustworthy starting point, what is still owed, and the next verification\n')
    return EXIT.PASS
  }
  const root = findProjectRoot(opts.project)
  const model = loadModel(root)
  const candidate = gitRevision(root, 'HEAD')
  const dirty = gitDirty(root)
  const notes = []
  const blockers = []

  // 1. Protected references.
  const baselineRef = model.cfg.baselineRef
  const remote = model.cfg.baselineRemote
  const localBaseline = model.baselines.length > 0 ? model.baselines[model.baselines.length - 1] : null
  let remoteState = { checked: false, sha: null }
  if (!opts.offline) {
    const sha = remoteRef(root, baselineRef, remote)
    remoteState = { checked: true, sha }
    if (!sha) {
      notes.push(
        `remote ${remote} has no ${baselineRef} (no remote configured, no permission, or no Baseline promoted yet)`,
      )
    } else if (!localBaseline) {
      notes.push(`remote ${baselineRef} = ${sha.slice(0, 12)} but no local baseline metadata is available to bind it`)
    } else if (localBaseline.code_revision !== sha) {
      blockers.push(
        `remote ${baselineRef} (${sha.slice(0, 12)}) differs from local baseline ${localBaseline.baseline_id} (${String(localBaseline.code_revision).slice(0, 12)}); re-read the remote before trusting either`,
      )
    }
  } else {
    notes.push('offline mode: remote protected references were not read')
  }

  // 2. CI evidence, attempts and deployment state.
  const trustedIssuer = model.cfg.ci?.trusted_issuer || null
  const trusted = model.evidence.filter((e) => !trustedIssuer || e.issuer?.identity === trustedIssuer)
  const untrusted = model.evidence.length - trusted.length
  const attempts = model.attempts
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null
  const stateHint = model.state || {}

  // 3. Recompute Coverage.
  const { rows, buckets } = coverageRows(model, { candidate, parentBaseline: localBaseline?.baseline_id || null, trustedIssuer })

  // 4. Local diff stays an unverified Candidate.
  if (dirty === null) notes.push('not a git repository: local diff cannot be classified')
  else if (dirty.length > 0) notes.push(`${dirty.length} local change(s) are an unverified Candidate and were not touched`)

  // 5. Budget position.
  const budget = budgetPosition(model, attempts)

  // 6. Suggested action.
  const suggestion = nextAction({ model, buckets, blockers, budget, remoteState, localBaseline, trustedIssuer })

  const code = blockers.length > 0 || budget.blocked ? EXIT.FAIL : EXIT.PASS

  const human = []
  human.push(`project      : ${root}`)
  human.push(`candidate    : ${candidate ? candidate.slice(0, 12) : '(no git revision)'}${dirty && dirty.length ? ` (+${dirty.length} uncommitted)` : ''}`)
  human.push(
    `baseline     : ${localBaseline ? `${localBaseline.baseline_id} @ ${String(localBaseline.code_revision).slice(0, 12)} (${baselineRef})` : '(none recorded locally)'}`,
  )
  human.push(
    `remote ref   : ${opts.offline ? '(not read)' : remoteState.sha ? `${remoteState.sha.slice(0, 12)} on ${remote}` : `absent on ${remote}`}`,
  )
  human.push(
    `evidence     : ${model.evidence.length} local record(s), ${trusted.length} from the trusted issuer${trustedIssuer ? ` (${trustedIssuer})` : ' (no trusted issuer configured)'}${untrusted ? `, ${untrusted} untrusted` : ''}`,
  )
  human.push(`current slice: ${stateHint.current_slice || model.slices.find((s) => s.status && s.status !== 'VERIFIED_DONE')?.id || '(none declared)'}`)
  human.push('')
  human.push('still owed (recomputed from the Contract, not from STATE):')
  const owed = [
    ['unmapped', buckets.unmapped],
    ['pending implementation', buckets.pending_implementation],
    ['standard gap', buckets.standard_gap],
    ['current failure', buckets.current_failure],
    ['stale evidence', buckets.stale_evidence],
    ['manual review pending', buckets.review_pending],
  ]
  for (const [label, list] of owed) {
    human.push(`  ${pad(label, 24)} ${list.length === 0 ? '-' : list.join(', ')}`)
  }
  human.push(`  ${pad('verified', 24)} ${buckets.verified.length}`)
  human.push('')
  human.push('budget:')
  human.push(
    `  attempts ${budget.total}/${budget.limits.total_attempt_limit}  replans ${budget.replans}/${budget.limits.replan_limit}  ` +
      `same-root-cause max ${budget.maxSameRootCause}/${budget.limits.same_root_cause_limit}  no-progress window ${budget.noProgressStreak}/${budget.limits.no_progress_window}`,
  )
  human.push(`  last failure: ${lastAttempt ? `${lastAttempt.attempt_id} ${lastAttempt.result} — ${lastAttempt.hypothesis}` : '(none recorded)'}`)
  if (budget.requiresReplan) human.push('  BLOCK the attempt window is exhausted: write a Replan Record before another attempt')
  if (budget.blocked) human.push('  BLOCK the total attempt budget is exhausted: this needs an explicit budget or scope decision from the owner')
  human.push('')
  for (const blocker of blockers) human.push(`BLOCK ${blocker}`)
  for (const note of notes) human.push(`note  ${note}`)
  human.push('')
  human.push('next:')
  for (const line of suggestion) human.push(`  - ${line}`)
  human.push('')
  human.push('note: STATE.yaml is a hint. Only the trusted CI verification job produces evidence, and only')
  human.push('      its Promotion job may advance the protected baseline reference.')

  return finish({
    code,
    script: 'resume',
    summary:
      blockers.length > 0
        ? `${blockers.length} blocking condition(s)`
        : `${buckets.verified.length} verified, ${owed.reduce((n, [, l]) => n + l.length, 0)} owed, next: ${suggestion[0] || 'none'}`,
    human,
    json: {
      project: root,
      candidate,
      dirty,
      baseline_ref: baselineRef,
      remote: remoteState,
      local_baseline: localBaseline
        ? {
            baseline_id: localBaseline.baseline_id,
            code_revision: localBaseline.code_revision,
            verification_scope: localBaseline.verification_scope,
          }
        : null,
      evidence: { total: model.evidence.length, trusted: trusted.length, trusted_issuer: trustedIssuer },
      current_slice: stateHint.current_slice || null,
      owed: {
        unmapped: buckets.unmapped,
        pending_implementation: buckets.pending_implementation,
        standard_gap: buckets.standard_gap,
        current_failure: buckets.current_failure,
        stale_evidence: buckets.stale_evidence,
        review_pending: buckets.review_pending,
        verified: buckets.verified,
      },
      budget,
      blockers,
      notes,
      next_actions: suggestion,
    },
    color: !opts.quiet,
    jsonRequested: opts.json === true,
  })
}

function pad(text, width) {
  const s = String(text)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function budgetPosition(model, attempts) {
  const limits = model.cfg.budget
  const total = attempts.filter((a) => a.result !== 'infra_aborted').length
  const replans = attempts.filter((a) => a.replan).length + (model.state?.replans || 0)
  const byRootCause = new Map()
  for (const attempt of attempts) {
    const key = attempt.root_cause_key || `${attempt.slice_id}:unspecified`
    byRootCause.set(key, (byRootCause.get(key) || 0) + 1)
  }
  const maxSameRootCause = byRootCause.size === 0 ? 0 : Math.max(...byRootCause.values())
  let noProgressStreak = 0
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const attempt = attempts[i]
    if (attempt.result === 'infra_aborted') continue
    const previous = attempts[i - 1]
    const improved =
      previous &&
      typeof attempt.required_passed === 'number' &&
      typeof previous.required_passed === 'number' &&
      (attempt.required_passed > previous.required_passed ||
        (attempt.spine_failures ?? 0) < (previous.spine_failures ?? 0))
    if (attempt.result === 'passed' || improved) break
    noProgressStreak += 1
  }
  return {
    limits,
    total,
    replans,
    maxSameRootCause,
    noProgressStreak,
    requiresReplan: maxSameRootCause >= limits.same_root_cause_limit || noProgressStreak >= limits.no_progress_window,
    blocked: total >= limits.total_attempt_limit || replans >= limits.replan_limit + 1,
  }
}

function nextAction({ model, buckets, blockers, budget, remoteState, localBaseline, trustedIssuer }) {
  const out = []
  if (blockers.length > 0) {
    out.push('resolve the blocking condition above before any further promotion attempt')
    return out
  }
  if (budget.blocked) {
    out.push('stop: the attempt budget is exhausted; the owner must adjust the budget or the product goal')
    return out
  }
  if (budget.requiresReplan) {
    out.push('stop patching: write a Replan Record (falsified assumption, new approach, discriminating checks)')
  }
  if (buckets.unmapped.length > 0) {
    out.push(`close the discovery gap: ${buckets.unmapped.slice(0, 5).join(', ')} — a required result no Slice claims`)
  }
  if (buckets.standard_gap.length > 0) {
    out.push(`close the standard gap: ${buckets.standard_gap.slice(0, 5).join(', ')} — run the independent Acceptance session`)
  }
  if (buckets.current_failure.length > 0) {
    out.push(`diagnose the current failure on ${buckets.current_failure.slice(0, 5).join(', ')} before adding scope`)
  }
  if (!remoteState.sha && !model.state?.baseline_ref) {
    out.push(`after the remote is reachable, promote Baseline #0 through the Promotion job so ${model.cfg.baselineRef} exists`)
  }
  if (!trustedIssuer) {
    out.push('configure ci.trusted_issuer in .agent/project.yaml so evidence can be attributed to the real verification job')
  }
  if (buckets.review_pending.length > 0 && buckets.pending_implementation.length === 0 && buckets.current_failure.length === 0) {
    out.push(`machine work is closed; the owner still owes the final Journey Review for ${buckets.review_pending.slice(0, 5).join(', ')}`)
  }
  if (out.length === 0) {
    out.push(
      `run the structural check for this Slice, then the local gates: ` +
        `check-gaps.mjs --phase slice --slice ${model.state?.current_slice || '<id>'}, then verify.mjs --local`,
    )
  }
  return out
}

try {
  process.exitCode = main()
} catch (error) {
  if (error instanceof InputError) {
    process.stderr.write(`resume: ${error.message}\n`)
    process.exitCode = EXIT.ERROR
  } else {
    process.stderr.write(`resume: unexpected error: ${error?.stack || error}\n`)
    process.exitCode = EXIT.ERROR
  }
}
