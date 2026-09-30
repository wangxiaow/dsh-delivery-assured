#!/usr/bin/env node
/**
 * attempts — count attempts per Slice, judge progress, and stop non-convergence.
 *
 * The attempt log (`.agent/attempts.jsonl`, one JSON record per line) accumulates
 * across sessions; changing session, renaming a Slice or Replanning never resets
 * the budget (v0.5 §9.2). A CI rerun aborted for infrastructure reasons is marked
 * `infra_aborted`: it is reported separately and never counted as progress or as
 * a pass.
 *
 * Progress is judged only on the same standard and the same case set: rising
 * required passes, falling spine failures, cleared blockers, vanished Critical
 * violations. Swapping the case set, deleting assertions, shrinking Required or
 * weakening the environment is not progress.
 *
 * Exit codes: 0 within budget, 1 Replan required or budget exhausted, 2 input error.
 */

import { appendFileSync, existsSync } from 'node:fs'
import { EXIT, InputError, abs, findProjectRoot, finish, parseArgs, rel } from './lib/common.mjs'
import { loadModel } from './lib/model.mjs'

const RESULTS = ['passed', 'failed', 'infra_aborted', 'blocked']

function main() {
  const opts = parseArgs(process.argv.slice(2), {
    project: 'value',
    slice: 'value',
    json: 'boolean',
    quiet: 'boolean',
    record: 'boolean',
    replan: 'boolean',
    'root-cause': 'value',
    hypothesis: 'value',
    result: 'value',
    'required-passed': 'value',
    'required-total': 'value',
    'spine-failures': 'value',
    'critical-violations': 'list',
    'ci-ref': 'value',
    note: 'value',
    'falsified-assumption': 'value',
    'previous-approach': 'value',
    'new-approach': 'value',
    'next-check': 'list',
    'preserved-obligation': 'list',
    'evidence-ref': 'list',
    'scope-changed': 'boolean',
  })
  if (opts.help) {
    process.stdout.write(
      'attempts — report budget/progress; --record appends an attempt; --replan appends a Replan Record\n',
    )
    return EXIT.PASS
  }

  const root = findProjectRoot(opts.project)
  const model = loadModel(root)
  const logPath = abs(root, model.cfg.paths.attemptsLog)

  if (opts.record) return recordAttempt(model, logPath, opts)
  if (opts.replan) return recordReplan(model, logPath, opts)
  return report(model, logPath, opts)
}

/* ------------------------------------------------------------------ report */

function report(model, logPath, opts) {
  const limits = model.cfg.budget
  const all = model.attempts
  const sliceFilter = opts.slice || null
  const attempts = sliceFilter ? all.filter((a) => a.slice_id === sliceFilter) : all

  const invalid = validateLog(attempts)
  const counted = attempts.filter((a) => a.result !== 'infra_aborted')
  const infraAborted = attempts.filter((a) => a.result === 'infra_aborted')
  const replans = all.filter((a) => a.replan)

  const byRootCause = new Map()
  for (const attempt of counted) {
    const key = attempt.root_cause_key || `${attempt.slice_id}:unspecified`
    byRootCause.set(key, (byRootCause.get(key) || 0) + 1)
  }
  const maxSameRootCause = byRootCause.size === 0 ? 0 : Math.max(...byRootCause.values())

  const progress = progressSignal(counted)
  const oscillation = detectOscillation(counted)
  const budgetBlocked = counted.length >= limits.total_attempt_limit || replans.length > limits.replan_limit
  const requiresReplan =
    maxSameRootCause >= limits.same_root_cause_limit ||
    progress.noProgressStreak >= limits.no_progress_window ||
    oscillation.oscillating

  const criticalOpen = criticalOpenFromModel(model)
  const code = invalid.length > 0 || budgetBlocked || requiresReplan || criticalOpen.length > 0 ? EXIT.FAIL : EXIT.PASS

  const human = []
  human.push(`log: ${rel(model.root, logPath)}${existsSync(logPath) ? '' : ' (not created yet)'}`)
  human.push(`slice filter: ${sliceFilter || '(all slices)'}`)
  human.push('')
  human.push(
    `attempts ${counted.length}/${limits.total_attempt_limit}   replans ${replans.length}/${limits.replan_limit}   ` +
      `same-root-cause max ${maxSameRootCause}/${limits.same_root_cause_limit}   no-progress streak ${progress.noProgressStreak}/${limits.no_progress_window}`,
  )
  if (infraAborted.length > 0) human.push(`infrastructure-aborted reruns (not counted as progress or pass): ${infraAborted.length}`)
  human.push('')
  human.push('per root cause:')
  if (byRootCause.size === 0) human.push('  (no attempts recorded)')
  for (const [key, count] of [...byRootCause.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = count >= limits.same_root_cause_limit ? '  <-- limit reached' : ''
    human.push(`  ${String(count).padStart(2)}  ${key}${flag}`)
  }
  human.push('')
  human.push('progress on the same standard and case set:')
  human.push(`  required passed trend : ${progress.requiredTrend.join(' -> ') || '(none)'}`)
  human.push(`  spine failures trend  : ${progress.spineTrend.join(' -> ') || '(none)'}`)
  human.push(`  critical violations   : ${criticalOpen.length === 0 ? 'none open' : criticalOpen.join(', ')}`)
  if (oscillation.detail) human.push(`  oscillation           : ${oscillation.detail}`)
  human.push('')
  if (invalid.length > 0) {
    human.push('invalid log entries:')
    for (const problem of invalid) human.push(`  BLOCK line ${problem.line}: ${problem.message}`)
  }
  if (criticalOpen.length > 0) {
    human.push('A Critical rule has no current pass: promotion is blocked immediately, not deferred as debt.')
  }
  if (requiresReplan && !budgetBlocked) {
    human.push('ACTION stop patching. Write a Replan Record: which assumption was falsified, how the new')
    human.push('       approach differs, which checks will discriminate, and which obligations are preserved.')
    human.push('       Command: node scripts/attempts.mjs --replan --slice <id> --falsified-assumption ... ')
  }
  if (budgetBlocked) {
    human.push('ACTION the budget is exhausted. This needs an explicit owner decision on budget or product goal;')
    human.push('       another session, a renamed Slice or a Replan does not reset it.')
  }
  if (invalid.length === 0 && !requiresReplan && !budgetBlocked && criticalOpen.length === 0) {
    human.push(`ACTION you may make one more attempt with the remaining budget (${limits.total_attempt_limit - counted.length} left).`)
  }

  return finish({
    code,
    script: 'attempts',
    summary: budgetBlocked
      ? `budget exhausted: ${counted.length}/${limits.total_attempt_limit} attempts`
      : requiresReplan
        ? `Replan required (same-root-cause ${maxSameRootCause}, no-progress ${progress.noProgressStreak})`
        : `${counted.length}/${limits.total_attempt_limit} attempts, ${limits.total_attempt_limit - counted.length} left`,
    human,
    json: {
      project: model.root,
      log: rel(model.root, logPath),
      slice: sliceFilter,
      limits,
      counted: counted.length,
      infra_aborted: infraAborted.length,
      replans: replans.length,
      per_root_cause: Object.fromEntries(byRootCause),
      max_same_root_cause: maxSameRootCause,
      progress,
      oscillation,
      critical_open: criticalOpen,
      invalid_entries: invalid,
      requires_replan: requiresReplan,
      budget_blocked: budgetBlocked,
    },
    color: !opts.quiet,
    jsonRequested: opts.json === true,
  })
}

/* ------------------------------------------------------------------ record */

function recordAttempt(model, logPath, opts) {
  const sliceId = opts.slice || model.state?.current_slice
  if (!sliceId) throw new InputError('--record needs --slice <id> (or current_slice in STATE.yaml)')
  const result = opts.result
  if (!result) throw new InputError('--record needs --result <passed|failed|infra_aborted|blocked>')
  if (!RESULTS.includes(result)) throw new InputError(`--result must be one of ${RESULTS.join(', ')}`)
  if (!opts.hypothesis) throw new InputError('--record needs --hypothesis: the assumption this attempt tested')

  if (result === 'passed') {
    // A passing attempt is only meaningful when the trusted verifier produced a record for it.
    const proof = model.evidence.find(
      (record) =>
        record.execution?.result === 'PASS' &&
        record.scope?.slice_id === sliceId &&
        (!model.cfg.ci?.trusted_issuer || record.issuer?.identity === model.cfg.ci.trusted_issuer),
    )
    if (!proof) {
      throw new InputError(
        'refusing to record a passed attempt without a PASS record from the trusted CI verifier. ' +
          'A local green run is a diagnostic, not an attempt result (v0.5 §9.1).',
      )
    }
  }

  const existing = model.attempts.filter((a) => a.slice_id === sliceId)
  const entry = {
    attempt_id: `${sliceId}-A${String(existing.length + 1).padStart(2, '0')}`,
    slice_id: sliceId,
    at: opts.at || new Date().toISOString(),
    root_cause_key: opts['root-cause'] || `${sliceId}:unspecified`,
    hypothesis: opts.hypothesis,
    result,
    required_passed: numberOrNull(opts['required-passed']),
    required_total: numberOrNull(opts['required-total']),
    spine_failures: numberOrNull(opts['spine-failures']),
    critical_violations: opts['critical-violations'] || [],
    ci_ref: opts['ci-ref'] || '',
    note: opts.note || '',
  }
  if (entry.required_passed === null) delete entry.required_passed
  if (entry.required_total === null) delete entry.required_total
  if (entry.spine_failures === null) delete entry.spine_failures

  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  process.stdout.write(`appended ${entry.attempt_id} (${entry.result}) to ${rel(model.root, logPath)}\n`)
  process.stdout.write('note: the attempt log is an editable summary, not evidence. It counts attempts; it never proves a pass.\n')
  return EXIT.PASS
}

function recordReplan(model, logPath, opts) {
  const sliceId = opts.slice || model.state?.current_slice
  if (!sliceId) throw new InputError('--replan needs --slice <id>')
  const required = ['falsified-assumption', 'previous-approach', 'new-approach']
  for (const field of required) {
    if (!opts[field]) throw new InputError(`--replan needs --${field}`)
  }
  if (!opts['next-check'] || opts['next-check'].length === 0) {
    throw new InputError('--replan needs at least one --next-check: the discriminating check for the new approach')
  }
  if (!opts['preserved-obligation'] || opts['preserved-obligation'].length === 0) {
    throw new InputError('--replan needs --preserved-obligation: Replan must not silently drop Required obligations')
  }
  const replans = model.attempts.filter((a) => a.replan)
  if (replans.length + 1 > model.cfg.budget.replan_limit) {
    throw new InputError(
      `replan limit (${model.cfg.budget.replan_limit}) is already reached; another Replan is not a way around the budget`,
    )
  }
  const entry = {
    attempt_id: `${sliceId}-R${String(replans.length + 1).padStart(2, '0')}`,
    slice_id: sliceId,
    at: new Date().toISOString(),
    hypothesis: `Replan: ${opts['falsified-assumption']}`,
    result: 'blocked',
    replan: {
      slice_id: sliceId,
      falsified_assumption: opts['falsified-assumption'],
      evidence_refs: opts['evidence-ref'] || [],
      previous_approach: opts['previous-approach'],
      new_approach: opts['new-approach'],
      next_discriminating_checks: opts['next-check'],
      preserved_obligations: opts['preserved-obligation'],
      scope_changed: opts['scope-changed'] === true,
    },
  }
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  process.stdout.write(`appended ${entry.attempt_id} Replan Record to ${rel(model.root, logPath)}\n`)
  if (entry.replan.scope_changed) {
    process.stdout.write(
      'note: scope_changed=true. A Replan may not change product semantics; that path is the three-question triage and needs the owner.\n',
    )
  }
  return EXIT.PASS
}

/* ----------------------------------------------------------------- helpers */

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function validateLog(attempts) {
  const problems = []
  attempts.forEach((attempt, index) => {
    const line = index + 1
    if (!attempt.attempt_id) problems.push({ line, message: 'missing attempt_id' })
    if (!attempt.slice_id) problems.push({ line, message: 'missing slice_id' })
    if (!RESULTS.includes(attempt.result)) problems.push({ line, message: `invalid result ${JSON.stringify(attempt.result)}` })
    if (!attempt.hypothesis) problems.push({ line, message: 'missing hypothesis: a rerun without a hypothesis is not an attempt' })
    if (attempt.replan) {
      const replan = attempt.replan
      for (const field of ['falsified_assumption', 'previous_approach', 'new_approach']) {
        if (!replan[field]) problems.push({ line, message: `Replan Record missing ${field}` })
      }
      if (!Array.isArray(replan.next_discriminating_checks) || replan.next_discriminating_checks.length === 0) {
        problems.push({ line, message: 'Replan Record has no next_discriminating_checks' })
      }
      if (!Array.isArray(replan.preserved_obligations) || replan.preserved_obligations.length === 0) {
        problems.push({ line, message: 'Replan Record preserves no obligations' })
      }
      if (typeof replan.scope_changed !== 'boolean') {
        problems.push({ line, message: 'Replan Record must state scope_changed explicitly' })
      }
    }
  })
  return problems
}

function progressSignal(attempts) {
  const requiredTrend = []
  const spineTrend = []
  for (const attempt of attempts) {
    if (typeof attempt.required_passed === 'number') requiredTrend.push(attempt.required_passed)
    if (typeof attempt.spine_failures === 'number') spineTrend.push(attempt.spine_failures)
  }
  let noProgressStreak = 0
  for (let i = attempts.length - 1; i > 0; i -= 1) {
    const current = attempts[i]
    const previous = attempts[i - 1]
    const requiredImproved =
      typeof current.required_passed === 'number' &&
      typeof previous.required_passed === 'number' &&
      current.required_passed > previous.required_passed
    const spineImproved =
      typeof current.spine_failures === 'number' &&
      typeof previous.spine_failures === 'number' &&
      current.spine_failures < previous.spine_failures
    const criticalCleared =
      (current.critical_violations?.length ?? 0) < (previous.critical_violations?.length ?? 0)
    if (current.result === 'passed' || requiredImproved || spineImproved || criticalCleared) break
    noProgressStreak += 1
  }
  return { requiredTrend, spineTrend, noProgressStreak }
}

/** Rotating build/auth/regression failures indicate oscillation, not convergence. */
function detectOscillation(attempts) {
  const categories = attempts
    .map((a) => categorize(a.note || a.hypothesis || ''))
    .filter((c) => c !== null)
  if (categories.length < 3) return { oscillating: false, detail: null }
  const recent = categories.slice(-4)
  const distinct = new Set(recent)
  if (distinct.size >= 3) {
    return { oscillating: true, detail: `recent failures rotate across ${[...distinct].join(', ')}` }
  }
  return { oscillating: false, detail: null }
}

function categorize(text) {
  const t = String(text).toLowerCase()
  if (/\b(build|compile|typecheck|typescript|tsc)\b/.test(t)) return 'build'
  if (/\b(auth|login|session|token|identity|permission|authz)\b/.test(t)) return 'auth'
  if (/\b(regression|spine|previously passing|broke)\b/.test(t)) return 'regression'
  if (/\b(migration|schema|database|db)\b/.test(t)) return 'migration'
  if (/\b(env|environment|deploy|deployment|infra)\b/.test(t)) return 'environment'
  return null
}

function criticalOpenFromModel(model) {
  const open = []
  for (const rule of model.contract.business_rules || []) {
    if (rule.severity !== 'critical') continue
    const cases = model.acceptance.cases.filter((c) => (c.obligation_ids || []).includes(rule.id))
    if (cases.length === 0) {
      open.push(`${rule.id} (no acceptance case)`)
      continue
    }
    const hasCurrentPass = cases.some((testCase) =>
      model.evidence.some(
        (record) =>
          record.execution?.result === 'PASS' &&
          (record.execution.case_results || []).some((r) => r.case_id === testCase.id && r.outcome === 'passed'),
      ),
    )
    if (!hasCurrentPass) open.push(`${rule.id} (no current passing record)`)
  }
  return open
}

try {
  process.exitCode = main()
} catch (error) {
  if (error instanceof InputError) {
    process.stderr.write(`attempts: ${error.message}\n`)
    process.exitCode = EXIT.ERROR
  } else {
    process.stderr.write(`attempts: unexpected error: ${error?.stack || error}\n`)
    process.exitCode = EXIT.ERROR
  }
}
