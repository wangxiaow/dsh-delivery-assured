/**
 * A-AUTO-POLICY-DEFAULT / A-AUTO-NO-FALSE-PASS / A-ITERATION-RECOVERY
 *
 * Frozen acceptance standard for the automatic-delivery default: the completion
 * rule is declared and executed as declared, automatic acceptance closes a project
 * only from actually executed acceptance plus platform-observed release
 * prerequisites, and an interrupted session can recover its iteration without the
 * user repeating anything.
 *
 * Behaviour only: these cases never read implementation source, never assert on
 * private helpers and never decide what counts as success for the product.
 */

const EXECUTED = {
  outcome: 'passed',
  caseResults: [{ case_id: 'A-SPEC-AUTO', outcome: 'passed' }],
}

function autoModel({ policy = { mode: 'independent_auto', authorization_ref: 'spec:user-authorization' }, manualReviews = [], automatedReviews = [{ id: 'R-SPEC-AUTO', obligation_ids: ['C-SPEC-AUTO'], case_ids: ['A-SPEC-AUTO'] }], includePolicy = true } = {}) {
  return {
    contract: {
      ...(includePolicy ? { completion_policy: policy } : {}),
      acceptance: { manual_reviews: manualReviews, automated_reviews: automatedReviews },
      deployment: {
        mvp_ready_environment: 'production_like_ci',
        release_prerequisites: [
          { id: 'spec-required-checks', verification: 'required_check_runs_on_candidate', expects: ['structural checks', 'verify candidate'] },
          { id: 'spec-baseline-readable', verification: 'baseline_ref_readable' },
        ],
        operational_acceptance_ids: ['A-SPEC-AUTO'],
        environment_limitations: ['自动结论只覆盖机器可观察结果'],
      },
      unknowns: [],
    },
    cfg: { mvpReadyEnvironment: 'production_like_ci', ci: { trusted_issuer: 'spec-trusted-verifier' } },
    currentBindings: { contract_digest: 'b'.repeat(64), acceptance_digest: 'c'.repeat(64) },
    obligations: new Map([['C-SPEC-AUTO', { id: 'C-SPEC-AUTO', kind: 'capability', required: true }]]),
    acceptance: { cases: [{ id: 'A-SPEC-AUTO', required: true, method: 'automated', obligation_ids: ['C-SPEC-AUTO'] }] },
    slices: [{ id: 'S-SPEC', obligations: ['C-SPEC-AUTO'], acceptance: ['A-SPEC-AUTO'] }],
    spine: { caseIds: ['A-SPEC-AUTO'] },
    baselines: [],
    attempts: [],
    reviews: [],
    evidence: [],
  }
}

function runRecord() {
  const revision = 'a'.repeat(40)
  return {
    evidence_id: 'spec:verify:1-1',
    issuer: { identity: 'spec-trusted-verifier' },
    scope: { slice_id: 'S-SPEC', obligation_ids: ['C-SPEC-AUTO'], required_case_ids: ['A-SPEC-AUTO'] },
    bindings: {
      code_revision: revision, contract_revision: revision, acceptance_revision: revision, verifier_config_revision: revision,
      contract_digest: 'b'.repeat(64), acceptance_manifest_digest: 'c'.repeat(64), acceptance_digest: 'c'.repeat(64), verifier_config_digest: 'd'.repeat(64),
      dependency_lock_digest: null, migration_digest: null, spine_manifest_digest: 'e'.repeat(64), slice_manifest_digest: 'f'.repeat(64), parent_baseline: null,
    },
    environment: { kind: 'production_like_ci', image_digest: `sha256:${'1'.repeat(64)}`, config_fingerprint: 'd'.repeat(64), fixture_revision: revision, deployment_id: 'spec-install-1', deployed_code_revision: revision, deployed_image_digest: `sha256:${'1'.repeat(64)}` },
    execution: {
      ci_run_id: '1-1', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z', result: 'PASS',
      required_cases: 1, executed_cases: 1, skipped_required_cases: 0, case_results: EXECUTED.caseResults, artifacts: ['results.json'],
      gate_results: ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment'].map((gate) => ({ gate, outcome: 'passed', exit_code: 0 })),
    },
    structural_notes: [],
    spine_case_ids: ['A-SPEC-AUTO'],
  }
}

const okReceipt = (record) => ({
  result: 'PASS',
  confirmation_ref: 'github:owner/repo/branches/main',
  bindings: { ...record.bindings, image_digest: record.environment.image_digest, deployment_id: record.environment.deployment_id },
  prerequisites: [
    { id: 'spec-required-checks', result: 'PASS', observation: { observed: true } },
    { id: 'spec-baseline-readable', result: 'PASS', observation: { observed: true } },
  ],
})

const okOptions = (record) => ({ sourceDigest: '9'.repeat(64), sourceReference: 'github:actions/runs/1/attempts/1', finalizationRun: '2-1', finalizerRevision: 'a'.repeat(40), parentBaseline: null, candidate: record.bindings.code_revision })

export function declareCases({ driver }) {
  return [
    {
      id: 'A-AUTO-POLICY-DEFAULT',
      obligationIds: ['C-AUTO-COMPLETION', 'J-AUTO-DELIVERY'],
      run: async () => {
        const failures = []
        const declared = { mode: 'independent_auto', authorization_ref: 'spec:user-authorization' }

        // A declared automatic policy is accepted only together with an authorizing
        // requirement and an automated review that names real protected cases.
        const complete = await driver.completionPolicyObservation({ completion_policy: declared }, { model: autoModel({ policy: declared }) })
        if (complete.resolved.mode !== 'independent_auto') failures.push(`a declared automatic policy resolved to ${complete.resolved.mode}`)
        if (complete.issues.some((issue) => issue.level === 'fail')) failures.push(`a complete automatic policy reported gaps: ${complete.issues.map((i) => i.code).join(', ')}`)

        const noAuthorization = await driver.completionPolicyObservation({ completion_policy: { mode: 'independent_auto' } }, { model: autoModel({ policy: { mode: 'independent_auto' } }) })
        if (!noAuthorization.issues.some((issue) => issue.code === 'COMPLETION_POLICY_NO_AUTHORIZATION')) failures.push('an automatic policy without the authorizing requirement was accepted')

        const noAutomatedMapping = await driver.completionPolicyObservation({ completion_policy: declared }, { model: autoModel({ policy: declared, automatedReviews: [] }) })
        if (!noAutomatedMapping.issues.some((issue) => issue.code === 'AUTO_REVIEWS_MISSING')) failures.push('an automatic policy with no executed acceptance mapping was accepted')

        const leftoverManual = await driver.completionPolicyObservation({ completion_policy: declared }, { model: autoModel({ policy: declared, manualReviews: [{ id: 'R-SPEC-OLD', reviewer: 'product_owner', obligation_ids: ['C-SPEC-AUTO'] }] }) })
        if (!leftoverManual.issues.some((issue) => issue.code === 'COMPLETION_POLICY_CONFLICT')) failures.push('a leftover human review was silently absorbed by the automatic policy')

        // Silence must fail closed: an undeclared policy means a human must close it.
        const undeclared = await driver.completionPolicyObservation({}, { model: autoModel({ includePolicy: false }) })
        if (undeclared.resolved.mode !== 'human_review' || undeclared.resolved.declared !== false) failures.push(`an undeclared policy resolved to ${JSON.stringify(undeclared.resolved)} instead of human_review`)
        if (!undeclared.issues.some((issue) => issue.code === 'COMPLETION_POLICY_MISSING' && issue.level === 'fail')) failures.push('an undeclared completion policy produced no blocking gap')

        // An invented mode is never a shortcut to automatic delivery.
        const invented = await driver.completionPolicyObservation({ completion_policy: { mode: 'auto_trust_me' } }, { model: autoModel({ policy: { mode: 'auto_trust_me' } }) })
        if (invented.resolved.mode !== 'human_review' || !invented.issues.some((issue) => issue.code === 'COMPLETION_POLICY_UNKNOWN')) failures.push('an unknown completion mode did not fall back to the human rule with a gap')

        return { ok: failures.length === 0, failures }
      },
    },
    {
      id: 'A-AUTO-NO-FALSE-PASS',
      obligationIds: ['BR-AUTO-EVIDENCE-ONLY', 'C-AUTO-COMPLETION'],
      run: async () => {
        const failures = []
        const record = runRecord()
        // The promotion consumer loads the authenticated record into the model it
        // assesses; the fixture mirrors that instead of inventing a shortcut.
        const ready = () => {
          const model = autoModel()
          model.evidence = [record]
          model.currentBindings = record.bindings
          return model
        }

        const complete = await driver.autoFinalizationObservation({ model: ready(), record, receipt: okReceipt(record), options: okOptions(record) })
        if (!complete.ready) failures.push(`a complete executed record with observed prerequisites was not closeable: ${complete.blocking.join('; ')}`)
        if (complete.completion_mode !== 'independent_auto') failures.push(`the decision was not attributed to automatic completion: ${complete.completion_mode}`)
        if (complete.automated_reviews.some((review) => review.result !== 'PASS')) failures.push('an executed review was not reported as passed')
        if (!complete.inputs_unchanged) failures.push('finalization mutated its inputs; the original evidence must stay byte-identical')
        if (complete.limitations.length === 0) failures.push('the automatic decision reported no limitation, although it only covers machine-observable results')

        const mutations = {
          'a missing case': (r) => ({ ...r, execution: { ...r.execution, case_results: [], executed_cases: 0, required_cases: 1 } }),
          'a skipped case': (r) => ({ ...r, execution: { ...r.execution, case_results: [{ case_id: 'A-SPEC-AUTO', outcome: 'skipped' }], skipped_required_cases: 1 } }),
          'a failed case': (r) => ({ ...r, execution: { ...r.execution, result: 'FAIL', case_results: [{ case_id: 'A-SPEC-AUTO', outcome: 'failed' }] } }),
          'stale bindings': (r) => ({ ...r, bindings: { ...r.bindings, contract_digest: '0'.repeat(64) } }),
        }
        for (const [label, mutate] of Object.entries(mutations)) {
          const broken = mutate(record)
          const outcome = await driver.autoFinalizationObservation({ model: ready(), record: broken, receipt: okReceipt(record), options: okOptions(broken) })
          if (outcome.ready) failures.push(`${label} still produced a closeable delivery`)
          if (outcome.blocking.length === 0) failures.push(`${label} produced no explicit blocking reason`)
        }

        const weakObservations = await driver.releaseObservationOutcome({
          model: autoModel(),
          fetchImpl: async (url) => (url.includes('/check-runs')
            ? { ok: true, json: async () => ({ check_runs: [{ name: 'structural checks', status: 'completed', conclusion: 'success' }] }) }
            : url.includes('/git/ref/heads/')
              ? { ok: true, json: async () => ({ object: { sha: 'a'.repeat(40) } }) }
              : { ok: true, json: async () => ({ state: 'active' }) }),
        })
        if (weakObservations.result === 'PASS') failures.push('an absent required check was observed as a passing release prerequisite')
        if (!weakObservations.prerequisites.some((item) => item.result === 'UNVERIFIED' && item.error)) failures.push('an unobservable prerequisite was not reported with its reason')

        const unreachable = await driver.releaseObservationOutcome({ model: autoModel(), fetchImpl: async () => ({ ok: false, status: 403 }) })
        if (unreachable.result === 'PASS') failures.push('a permission failure was reported as a satisfied release prerequisite')

        const blockedRecord = { ...record, execution: { ...record.execution, case_results: [{ case_id: 'A-SPEC-AUTO', outcome: 'skipped' }] } }
        const withWeakReceipt = await driver.autoFinalizationObservation({
          model: ready(),
          record: blockedRecord,
          receipt: { ...okReceipt(record), result: 'UNVERIFIED', prerequisites: [{ id: 'spec-required-checks', result: 'UNVERIFIED', error: 'observed 403' }, { id: 'spec-baseline-readable', result: 'PASS', observation: { observed: true } }] },
          options: okOptions(blockedRecord),
        })
        if (withWeakReceipt.ready) failures.push('unverified release observations produced a closeable delivery')

        return { ok: failures.length === 0, failures }
      },
    },
    {
      id: 'A-ITERATION-RECOVERY',
      obligationIds: ['C-RECOVERY', 'J-AUTO-DELIVERY'],
      run: async () => {
        const failures = []
        const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`
        const observed = await driver.iterationObservation({
          events: [
            { id: 'IT-001', kind: 'opened', at: at(1), requirement: '做一个只读状态工具' },
            { id: 'IT-001', kind: 'noted', at: at(2), detail: '实现只读报告' },
            { id: 'IT-001', kind: 'closed', at: at(3) },
            { id: 'IT-002', kind: 'opened', at: at(4), requirement: '默认改为自动验收，不要人工签收', iteration_of: 'IT-001' },
            { id: 'IT-002', kind: 'verified', at: at(5), evidence_ref: 'spec:verify:1-1' },
            { id: 'IT-002', kind: 'blocked', at: at(6), reason: '等待平台权限' },
          ],
          invalidEvent: { id: 'IT-002', kind: 'verified', at: at(7) },
        })

        if (observed.unreadable_lines !== 0) failures.push(`a valid journal reported ${observed.unreadable_lines} unreadable line(s)`)
        if (observed.iterations.length !== 2) failures.push(`expected two iterations after restart, observed ${observed.iterations.length}`)
        if (observed.closed.length !== 1) failures.push('a closed iteration was lost')
        if (!observed.current || observed.current.id !== 'IT-002') failures.push(`recovery did not resume the open iteration: ${JSON.stringify(observed.current?.id)}`)
        if (!observed.current?.requirement?.includes('自动验收')) failures.push('the recovered iteration lost the user requirement')
        if (observed.current?.iteration_of !== 'IT-001') failures.push('the recovered iteration lost the iteration it continues')
        if (observed.blocked.length !== 1 || !observed.blocked[0].blocked_reason?.includes('平台权限')) failures.push('the blocking reason was not recovered')
        if (!observed.current?.evidence_refs?.some((entry) => entry.ref === 'spec:verify:1-1')) failures.push('an observed evidence reference was not retained')
        if (!observed.invalid_refused) failures.push('an evidence-free completion event was accepted into the journal')
        if (!observed.bytes || !observed.bytes.includes('IT-001')) failures.push('the journal is not an append-only durable record')
        if (!observed.summary.some((line) => /IT-002/.test(line))) failures.push('the recovery summary does not name the current iteration')

        // Two journals in the same project never overwrite each other's history.
        const reopened = await driver.iterationObservation({ events: [{ id: 'IT-003', kind: 'opened', at: at(8), requirement: '第二轮：加入导出' }] })
        if (reopened.iterations.length !== 1) failures.push('a fresh journal did not start clean')

        return { ok: failures.length === 0, failures }
      },
    },
  ]
}
