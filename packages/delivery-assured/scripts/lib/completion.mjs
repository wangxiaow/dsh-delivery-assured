/**
 * Completion policy — the single place that decides how a delivery may be closed.
 *
 * The owner's default is independent automatic acceptance: real execution of frozen
 * acceptance on a frozen revision, observed by CI, with platform-observed release
 * prerequisites. Human review stays available as an explicitly chosen mode, and
 * historical owner receipts keep their original meaning.
 *
 * Nothing here invents a pass. An undeclared policy resolves to `human_review`
 * (the conservative legacy behaviour) so a missing field can never make a project
 * automatically deliverable; automated reviews must name protected Required cases
 * that actually executed, and a case with no unique PASS in the exact run blocks.
 */

import { classifyEvidence, isPlaceholder } from './model.mjs'
import { blockingForView, collectCriticalViolations, coverageRows } from './coverage-core.mjs'
import { VERIFICATION_BACKEND, issuerAssurance } from './verification.mjs'
import { assessBackendCapability, capabilityMessage } from './capability.mjs'

export const COMPLETION_MODES = ['independent_auto', 'human_review']

const text = (value) => typeof value === 'string' && value.trim() !== '' && !isPlaceholder(value)
const ids = (value) => Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length

/** Resolve the declared policy without ever widening it by omission. */
export function resolveCompletionPolicy(contract) {
  const declared = contract?.completion_policy
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return { mode: 'human_review', declared: false, authorization_ref: null, detail: 'no completion_policy is declared; the legacy human review rule applies' }
  }
  const mode = typeof declared.mode === 'string' ? declared.mode : null
  if (!COMPLETION_MODES.includes(mode)) {
    return { mode: 'human_review', declared: true, authorization_ref: declared.authorization_ref ?? null, detail: `unknown completion mode ${JSON.stringify(declared.mode ?? null)}; treated as human_review` }
  }
  return { mode, declared: true, authorization_ref: declared.authorization_ref ?? null, detail: `declared completion mode ${mode}` }
}

/** Automated review definitions map obligations to protected Required cases. */
export function automatedReviewDefinitions(contract) {
  const declared = contract?.acceptance?.automated_reviews
  return Array.isArray(declared) ? declared : []
}

/**
 * Structural check of the policy itself. Fails closed on an undeclared or
 * inconsistent policy so `check-gaps` cannot report a project as closeable when
 * the rule that says who may close it is missing.
 */
export function checkCompletionPolicy(model, issues, { phase = 'contract' } = {}) {
  const { contract } = model
  const declared = contract?.completion_policy
  const resolved = resolveCompletionPolicy(contract)
  const manual = contract?.acceptance?.manual_reviews || []
  const automated = automatedReviewDefinitions(contract)
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    issues.push({ level: phase === 'contract' ? 'fail' : 'fail', code: 'COMPLETION_POLICY_MISSING', message: 'contract declares no completion_policy; the default completion rule must be stated explicitly' })
  } else if (!COMPLETION_MODES.includes(declared.mode)) {
    issues.push({ level: 'fail', code: 'COMPLETION_POLICY_UNKNOWN', message: `completion_policy.mode ${JSON.stringify(declared.mode ?? null)} is not one of ${COMPLETION_MODES.join(', ')}` })
  }
  if (resolved.mode === 'independent_auto') {
    if (!text(declared.authorization_ref)) {
      issues.push({ level: 'fail', code: 'COMPLETION_POLICY_NO_AUTHORIZATION', message: 'independent_auto must cite the requirement authorization that replaced the default human sign-off' })
    }
    if (automated.length === 0) {
      issues.push({ level: 'fail', code: 'AUTO_REVIEWS_MISSING', message: 'independent_auto requires at least one automated review mapping obligations to protected Required cases' })
    }
    if (manual.length > 0) {
      issues.push({ level: 'fail', code: 'COMPLETION_POLICY_CONFLICT', message: 'independent_auto cannot silently keep manual reviews; migrate each one explicitly (automated mapping or an explicitly chosen human_review project)' })
    }
  } else {
    if (manual.length === 0) {
      issues.push({ level: 'fail', code: 'HUMAN_REVIEWS_MISSING', message: 'human_review completion requires at least one declared manual review with a real reviewer role' })
    }
  }
  const seen = new Set()
  for (const definition of automated) {
    const id = definition?.id
    if (!/^R-[A-Z0-9-]+$/.test(String(id))) {
      issues.push({ level: 'fail', code: 'BAD_ID', message: `automated review id ${JSON.stringify(id ?? null)} must match R-*` })
    }
    if (seen.has(id)) issues.push({ level: 'fail', code: 'DUPLICATE_ID', message: `automated review ${id} is declared twice` })
    seen.add(id)
    if (!ids(definition?.case_ids)) {
      issues.push({ level: 'fail', code: 'AUTO_REVIEW_NO_CASES', message: `automated review ${id} must name the protected Required cases it executes` })
    }
    if (!ids(definition?.obligation_ids)) {
      issues.push({ level: 'fail', code: 'AUTO_REVIEW_NO_OBLIGATIONS', message: `automated review ${id} must name the obligations it closes` })
    }
    for (const caseId of definition?.case_ids || []) {
      const testCase = (model.acceptance?.cases || []).find((c) => c.id === caseId)
      if (!testCase) issues.push({ level: 'fail', code: 'DANGLING_REFERENCE', message: `automated review ${id} references unknown acceptance case ${caseId}`, id: caseId })
      else if (testCase.required !== true || testCase.method !== 'automated') {
        issues.push({ level: 'fail', code: 'AUTO_REVIEW_NOT_REQUIRED', message: `automated review ${id} case ${caseId} is not protected Required automated acceptance`, id: caseId })
      }
    }
    for (const obligationId of definition?.obligation_ids || []) {
      if (!model.obligations.has(obligationId)) {
        issues.push({ level: 'fail', code: 'DANGLING_REFERENCE', message: `automated review ${id} references unknown obligation ${obligationId}`, id: obligationId })
      }
    }
  }
}

/**
 * Prove automated reviews from one exact CI run. There is no field an implementer
 * can write to make this true: every case must be part of the frozen required set
 * and must carry exactly one `passed` outcome in that run's case results.
 */
export function assessAutomatedReviews(model, record, { sourceReference = null } = {}) {
  const blocking = []
  const definitions = automatedReviewDefinitions(model.contract)
  if (definitions.length === 0) blocking.push('independent automated Journey acceptance is not declared')
  const executed = new Map()
  for (const result of record?.execution?.case_results || []) {
    executed.set(result.case_id, (executed.get(result.case_id) || 0) + (result.outcome === 'passed' ? 1 : 0))
  }
  const required = new Set(record?.scope?.required_case_ids || [])
  const reviews = definitions.map((definition) => {
    const problems = []
    if (!ids(definition?.case_ids) || !ids(definition?.obligation_ids)) problems.push('review needs explicit nonempty case and obligation sets')
    for (const caseId of definition?.case_ids || []) {
      const testCase = (model.acceptance?.cases || []).find((c) => c.id === caseId)
      if (!testCase || testCase.required !== true || testCase.method !== 'automated') problems.push(`${caseId} is not protected Required automated acceptance`)
      else if (!required.has(caseId)) problems.push(`${caseId} is missing from this run's frozen required set`)
      else if (executed.get(caseId) !== 1) problems.push(`${caseId} lacks exactly one actual PASS in this exact run`)
    }
    for (const obligationId of definition?.obligation_ids || []) {
      if (!model.obligations?.has?.(obligationId)) problems.push(`${obligationId} is not a Contract obligation`)
      else if (!(definition.case_ids || []).some((caseId) => {
        const testCase = (model.acceptance?.cases || []).find((c) => c.id === caseId)
        return testCase && [...(testCase.obligation_ids || []), ...(testCase.outcome_ids || [])].includes(obligationId)
      })) problems.push(`${obligationId} is not covered by the review's cases`)
    }
    return {
      review_id: definition?.id,
      result: problems.length ? 'UNVERIFIED' : 'PASS',
      case_ids: definition?.case_ids || [],
      evidence_ref: record?.evidence_id ?? null,
      execution_ref: sourceReference,
      ...(problems.length ? { problems } : {}),
    }
  })
  for (const review of reviews) for (const problem of review.problems || []) blocking.push(`${review.review_id || '(unnamed review)'}: ${problem}`)
  return { blocking, reviews }
}

/* -------------------------------------------------------------- delivered */

/**
 * The best independent execution that proves the current candidate.
 *
 * "Best" is ordered by assurance (a trusted-CI record outranks a host-executed one),
 * then by when it finished. Only fresh records qualify: a record bound to another
 * revision, another standard or an incomplete Required set is not a pass, so it can
 * never be selected here.
 */
export function independentVerification(model, { candidate, parentBaseline = null, acceptedIssuers = null, trustedIssuer = null, verification = null } = {}) {
  let best = null
  for (const record of model.evidence || []) {
    const classified = classifyEvidence(record, { model, codeRevision: candidate, parentBaseline, acceptedIssuers, trustedIssuer })
    if (!classified.fresh) continue
    if (record.execution?.result !== 'PASS') continue
    const assurance = verification ? issuerAssurance(record.issuer?.identity, verification) : 1
    const at = Date.parse(record.execution?.finished_at) || 0
    const rank = [assurance, at]
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) {
      best = { rank, record, classified, assurance, at }
    }
  }
  if (!best) return null
  const x = best.record.execution || {}
  const e = best.record.environment || {}
  return {
    evidence_id: best.record.evidence_id,
    issuer: best.record.issuer?.identity ?? null,
    assurance: best.assurance,
    backend: e.kind === 'host_independent' ? VERIFICATION_BACKEND.HOST : VERIFICATION_BACKEND.TRUSTED_CI,
    finished_at: x.finished_at || null,
    required_cases: x.required_cases ?? null,
    executed_cases: x.executed_cases ?? null,
    skipped_required_cases: x.skipped_required_cases ?? null,
    deployment_observed: Boolean(e.deployment_id || e.deployed_code_revision),
    run_log: x.run_log || null,
    standards: best.record.standards || null,
    // The caller may show the raw record; nothing here is recomputed from a claim.
    record: best.record,
  }
}

/**
 * The one delivery verdict.
 *
 * `Delivered` is computed, never declared: it holds only when the Contract's remaining
 * obligations are all proved by a fresh execution of the frozen Required set on this
 * exact candidate, that execution's backend can actually observe every fact the
 * Contract requires, no Critical rule lacks a current pass, and the budget is not
 * exhausted. The backend is named, and the observations it could not make are reported
 * as limitations of the verdict — but for a *Required* observable a missing capability
 * is a block, never a limitation (see lib/capability.mjs).
 */
export function assessDelivery(model, { candidate, parentBaseline = null, acceptedIssuers = null, trustedIssuer = null, verification = null, budget = null } = {}) {
  const { buckets } = coverageRows(model, { candidate, parentBaseline, trustedIssuer, acceptedIssuers })
  const critical = collectCriticalViolations(model, { codeRevision: candidate, parentBaseline, trustedIssuer, acceptedIssuers })
  const blockingObligations = blockingForView(buckets, 'mvp')
  const record = independentVerification(model, { candidate, parentBaseline, acceptedIssuers, trustedIssuer, verification })
  // Evidence covers the Contract's required observability only when the backend that
  // produced the record can observe every required fact. `not_observed` is never a pass.
  // The capability verdict is computed from the *raw* record — `independentVerification`
  // returns a summary that carries it under `record` — because the backend and its own
  // statements are exactly what the completeness check reads.
  const evidenceRecord = record?.record ?? null
  const capability = evidenceRecord ? assessBackendCapability(model, evidenceRecord) : null
  const blocking = []
  const blockingEntries = []
  if (blockingObligations.length > 0) {
    blockingEntries.push({
      code: 'REQUIRED_OBLIGATIONS_UNPROVED',
      message: `${blockingObligations.length} required obligation(s) are not proved on this candidate: ${blockingObligations.slice(0, 8).join(', ')}`,
      obligations: blockingObligations,
    })
  }
  for (const violation of critical) {
    blockingEntries.push({ code: 'CRITICAL_WITHOUT_CURRENT_PASS', message: `Critical ${violation.rule}: ${violation.message}`, rule: violation.rule, case_id: violation.case_id ?? null })
  }
  if (!record) {
    blockingEntries.push({
      code: 'NO_FRESH_INDEPENDENT_EXECUTION',
      message:
        'no fresh independent execution of the frozen Required set covers this exact candidate; ' +
        'a declaration, a local diagnostic or a record bound to another revision is not a pass',
    })
  }
  if (budget?.budget_blocked === true) {
    blockingEntries.push({ code: 'BUDGET_EXHAUSTED', message: 'the attempt budget is exhausted; this needs an explicit budget or scope decision' })
  }
  // Only meaningful once a record exists: without one the verdict is already
  // NOT_DELIVERED, and the missing execution is the more precise reason.
  if (capability && !capability.ok) {
    blockingEntries.push({
      code: capability.code,
      message: capabilityMessage(capability),
      backend: capability.backend,
      required_observables: capability.required_observables,
      missing_observables: capability.missing_observables,
    })
  }
  for (const entry of blockingEntries) blocking.push(entry.message)
  const limitations = []
  if (record && record.backend === VERIFICATION_BACKEND.HOST) {
    limitations.push('the record was produced by the host-executed verifier: no packaged deployment or runtime isolation was observed')
  }
  return {
    delivered: blocking.length === 0,
    completion_mode: resolveCompletionPolicy(model.contract).mode,
    backend: record?.backend ?? (verification?.backend ?? null),
    candidate: candidate ?? null,
    verification: record,
    capability,
    blocking,
    // The stable, machine-readable form of the same facts: a consumer may not parse
    // the human sentence above to find out *which* observable was missing.
    blocking_entries: blockingEntries,
    owed: {
      blocking_obligations: blockingObligations,
      critical: critical.map((entry) => `${entry.rule}${entry.case_id ? `/${entry.case_id}` : ''}`),
      verified: buckets.verified,
    },
    limitations,
  }
}
