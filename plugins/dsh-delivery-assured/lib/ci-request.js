/**
 * Narrow CI request/observe interface for a DSH session (v0.5 §12, §16.4).
 *
 * A session may *ask* the platform to run the frozen verification or promotion
 * workflow, and may read what happened. It never receives a baseline credential,
 * never writes Evidence and never advances a ref — the promotion job remains the
 * only holder of that credential, and this module only builds argument lists and
 * parses the CLI's JSON.
 *
 * Requests are validated against a whitelist: one exact repository, known action names,
 * a full candidate SHA, declared inputs only — and each action is built from its *own*
 * declared inputs, never from a shared bag (an absent field forwarded as `undefined` made
 * every route fail its own whitelist before the platform was ever asked). A dispatch is
 * correlated with exactly one new run of that workflow, or reported as `ambiguous`; it is
 * never attributed by picking the newest run and never retried, because a blind retry
 * spends another attempt against the same frozen candidate.
 */

/**
 * The recoverable entries ride the same promote workflow (promote.yml's mode field):
 * `record-attempt` re-runs the collector for one exact completed verify run, and
 * `resolve-diagnostic` appends an owner-reviewed resolution to one exact retained
 * diagnostic. Both are whitelisted so a session can self-recover from a collection
 * failure or a blocking diagnostic instead of depending on a manual dispatch — they
 * still write only inside the CI job, never from the session.
 */
export const WORKFLOW_FILE = {
  verify: 'verify.yml',
  promote: 'promote.yml',
  'record-attempt': 'promote.yml',
  'resolve-diagnostic': 'promote.yml',
}
const SHA = /^[0-9a-f]{40}$/
const BASELINE = /^(none|BL-[0-9]+)$/
const text = (value) => typeof value === 'string' && value.trim() !== ''

function requireText(value, field) {
  if (!text(value)) throw new Error(`${field} is required`)
  return value.trim()
}

function requireDigits(value, field) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) throw new Error(`${field} must be an exact positive integer run/attempt number`)
  return String(value)
}

/** Validate one request and return the exact `gh workflow run` argument list. */
export function buildDispatch(request = {}) {
  const action = request.action
  if (!Object.hasOwn(WORKFLOW_FILE, action)) throw new Error(`action must be one of ${Object.keys(WORKFLOW_FILE).join(', ')}`)
  const repo = requireText(request.repository, 'repository')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('repository must be owner/name')
  const args = ['workflow', 'run', WORKFLOW_FILE[action], '--repo', repo]
  const fields = []
  if (action === 'verify') {
    if (!SHA.test(request.candidate || '')) throw new Error('candidate must be the full 40-character commit SHA that was actually frozen')
    const parent = request.parent_baseline ?? 'none'
    if (!BASELINE.test(parent)) throw new Error('parent_baseline must be none or BL-<digits>')
    fields.push(['candidate_ref', request.candidate], ['parent_baseline', parent], ['slice_id', requireText(request.slice, 'slice')], ['sliceKey', request.slice_key || request.slice], ['hypothesis', requireText(request.hypothesis, 'hypothesis')])
    if (text(request.comparison_approval_ref)) fields.push(['comparisonApprovalRef', request.comparison_approval_ref.trim()])
    const known = new Set(['action', 'repository', 'candidate', 'parent_baseline', 'slice', 'slice_key', 'hypothesis', 'comparison_approval_ref'])
    for (const key of Object.keys(request)) if (!known.has(key)) throw new Error(`unknown verify input ${key}`)
  } else if (action === 'record-attempt') {
    const runId = requireDigits(request.verify_run_id, 'verify_run_id')
    const runAttempt = requireDigits(request.verify_run_attempt, 'verify_run_attempt')
    fields.push(['mode', 'record-attempt'], ['verify_run_id', runId], ['verify_run_attempt', runAttempt])
    const known = new Set(['action', 'repository', 'verify_run_id', 'verify_run_attempt'])
    for (const key of Object.keys(request)) if (!known.has(key)) throw new Error(`unknown record-attempt input ${key}`)
  } else if (action === 'resolve-diagnostic') {
    if (!SHA.test(request.expected_state_sha || '')) throw new Error('expected_state_sha must be the exact 40-character delivery-state SHA reviewed for this resolution')
    const value = (field, message) => {
      const owner = requireText(request[field], field)
      if (/^(?:todo|tbd|unknown|none|null|undefined|n\/?a|placeholder|pending|example|test|dummy|replace(?:(?:[_ -]).*)?)$/i.test(owner)) throw new Error(message)
      return owner
    }
    fields.push(
      ['mode', 'resolve-diagnostic'],
      ['resolution_owner', value('resolution_owner', 'resolution_owner must be the real reviewing actor, not a placeholder')],
      ['expected_state_sha', request.expected_state_sha.trim()],
      ['verify_run_id', requireDigits(request.verify_run_id, 'verify_run_id')],
      ['verify_run_attempt', requireDigits(request.verify_run_attempt, 'verify_run_attempt')],
      ['resolution_confirmation', value('resolution_confirmation', 'resolution_confirmation must be a real diagnostic confirmation reference, not a placeholder')],
    )
    const known = new Set(['action', 'repository', 'resolution_owner', 'expected_state_sha', 'verify_run_id', 'verify_run_attempt', 'resolution_confirmation'])
    for (const key of Object.keys(request)) if (!known.has(key)) throw new Error(`unknown resolve-diagnostic input ${key}`)
  } else {
    const mode = requireText(request.mode, 'mode')
    if (!['promote-baseline', 'MVP_READY'].includes(mode)) throw new Error('mode must be promote-baseline or MVP_READY')
    const parent = requireText(request.expected_parent, 'expected_parent')
    if (!BASELINE.test(parent)) throw new Error('expected_parent must be none or BL-<digits>')
    if (!/^[1-9][0-9]*$/.test(String(request.verify_run_id ?? '')) || !/^[1-9][0-9]*$/.test(String(request.verify_run_attempt ?? ''))) {
      throw new Error('an exact verify run id and attempt are required; promotion consumes a completed run, it never re-verifies')
    }
    fields.push(['mode', mode], ['expected_parent', parent], ['verify_run_id', String(request.verify_run_id)], ['verify_run_attempt', String(request.verify_run_attempt)])
    if (text(request.owner_approval_ref)) fields.push(['owner_approval_ref', request.owner_approval_ref.trim()])
    const known = new Set(['action', 'repository', 'mode', 'expected_parent', 'verify_run_id', 'verify_run_attempt', 'owner_approval_ref'])
    for (const key of Object.keys(request)) if (!known.has(key)) throw new Error(`unknown promote input ${key}`)
  }
  for (const [key, value] of fields) args.push('-f', `${key}=${value}`)
  return { action, repository: repo, workflow: WORKFLOW_FILE[action], args }
}

/**
 * The exact input each dispatch action accepts, per its workflow schema.
 *
 * `buildDispatch` refuses an unknown field on purpose: a request must carry declared
 * inputs only. That makes a caller which forwards its whole argument bag — including the
 * fields that belong to a different action, present as `undefined` — fail on every route:
 * `unknown verify input mode`, `unknown promote input verify_run_id`, and so on. The
 * per-action lists below are therefore the only path from tool arguments to a request:
 * an absent field is never forwarded, and a field belonging to another action is dropped
 * instead of being sent as `undefined`.
 */
export const ACTION_INPUTS = {
  verify: ['candidate', 'parent_baseline', 'slice', 'slice_key', 'hypothesis', 'comparison_approval_ref'],
  promote: ['mode', 'expected_parent', 'verify_run_id', 'verify_run_attempt', 'owner_approval_ref'],
  'record-attempt': ['verify_run_id', 'verify_run_attempt'],
  'resolve-diagnostic': ['expected_state_sha', 'resolution_owner', 'verify_run_id', 'verify_run_attempt', 'resolution_confirmation'],
}

/**
 * Build one request from a tool's arguments for one action. Never a shared bag: only the
 * declared inputs of that action, only when they carry a value.
 */
export function requestForWorkflow(action, args = {}, { repository = null } = {}) {
  if (!Object.hasOwn(ACTION_INPUTS, action)) throw new Error(`action must be one of ${Object.keys(ACTION_INPUTS).join(', ')}`)
  const request = { action }
  if (repository !== null && repository !== undefined) request.repository = repository
  for (const field of ACTION_INPUTS[action]) {
    const value = args[field]
    if (value === undefined || value === null || value === '') continue
    request[field] = value
  }
  return request
}

/** The exact `gh run list` fields the correlation needs. */
const RUN_LIST_FIELDS = 'databaseId,url,status,conclusion,headSha,headBranch,event,createdAt,workflowName'

/**
 * Read the workflow's recent runs. Returns `null` when the platform could not answer:
 * correlation must then fail closed instead of guessing from an empty list.
 */
async function listRuns(runner, repository, workflow) {
  const listed = await runner(['run', 'list', '--repo', repository, '--workflow', workflow, '--limit', '20', '--json', RUN_LIST_FIELDS])
  if (listed.exit_code !== 0) return null
  try {
    const parsed = JSON.parse(listed.stdout || '[]')
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const runIds = (runs) => runs.map((run) => String(run.databaseId)).filter((id) => /^[1-9][0-9]*$/.test(id))

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ask the platform to run a frozen workflow and correlate exactly one run with this
 * request. No retry, no credential, no state.
 *
 * Correlation is proven, never assumed:
 *   1. the run set is read *before* the dispatch (a dispatch that cannot be correlated is
 *      not made at all, because an unattributable run would still spend a frozen candidate);
 *   2. after the dispatch, runs that are new, `workflow_dispatch` events, and on the
 *      dispatched branch (when the caller pins one) are the only eligible ones. Creation
 *      time is *not* used: the platform clock and this clock are different clocks, and a
 *      run that was not in the pre-dispatch set cannot be an older run anyway;
 *   3. exactly one eligible run is required. Zero, or more than one, is reported as
 *      `ambiguous` with the ids it saw — never resolved by picking the newest run.
 * The list read is re-polled a bounded number of times; the dispatch itself is never
 * repeated.
 *
 * @param options.attempts        how many times to re-read the run list after dispatch
 * @param options.delayMs         delay between those reads
 * @param options.sleep           injectable for tests
 * @param options.knownRunIds     run ids already seen before this dispatch (skips the pre-read)
 * @param options.branch          expected dispatch branch; only applied when the caller pins one
 */
export async function requestRun(
  runner,
  request,
  { previousRunId = null, knownRunIds = null, branch = null, attempts = 3, delayMs = 2000, sleep = sleepMs } = {},
) {
  const plan = buildDispatch(request)
  const exclude = new Set()
  if (knownRunIds) {
    for (const id of knownRunIds) exclude.add(String(id))
  } else {
    const priorRuns = await listRuns(runner, plan.repository, plan.workflow)
    if (priorRuns === null) {
      return {
        status: 'ambiguous',
        action: plan.action,
        workflow: plan.workflow,
        repository: plan.repository,
        message: 'the runs already present could not be read, so a dispatch could not be attributed to this request; no dispatch was made',
        note: 'do not retry blindly: restore read access to the run list first, because a dispatch whose run cannot be identified still spends the frozen candidate',
      }
    }
    for (const id of runIds(priorRuns)) exclude.add(id)
  }
  if (previousRunId) exclude.add(String(previousRunId))

  const dispatch = await runner(plan.args)
  if (dispatch.exit_code !== 0) {
    return {
      status: 'refused',
      action: plan.action,
      workflow: plan.workflow,
      repository: plan.repository,
      exit_code: dispatch.exit_code,
      message: `the platform refused the dispatch: ${String(dispatch.stderr || dispatch.stdout || '').trim().slice(0, 400)}`,
      note: 'no run was created by this request; fix the cause before asking again',
    }
  }

  let lastSaw = []
  let lastFresh = []
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    if (attempt > 0) await sleep(delayMs)
    const runs = await listRuns(runner, plan.repository, plan.workflow)
    if (runs === null) {
      return {
        status: 'ambiguous',
        action: plan.action,
        workflow: plan.workflow,
        repository: plan.repository,
        message: 'the dispatch command succeeded but the run list could not be read, so this run cannot be attributed to this request',
        note: 'do not retry blindly: observe the workflow list first, or the frozen candidate may be spent on a duplicate request',
      }
    }
    lastSaw = runs
    const fresh = runs.filter((run) => !exclude.has(String(run.databaseId)))
    lastFresh = fresh
    const eligible = fresh.filter((run) => {
      if (run.event !== 'workflow_dispatch') return false
      if (branch && run.headBranch && run.headBranch !== branch) return false
      return true
    })
    if (eligible.length === 1) {
      const created = eligible[0]
      return {
        status: 'requested',
        action: plan.action,
        workflow: plan.workflow,
        repository: plan.repository,
        run_id: created.databaseId,
        url: created.url,
        run_head_sha: created.headSha ?? null,
        run_branch: created.headBranch ?? null,
        run_status: created.status,
        created_at: created.createdAt,
        // What this request actually asked to verify: the run's head commit is the branch
        // the workflow was dispatched on, not the frozen candidate.
        frozen_candidate: plan.args.find((arg) => arg.startsWith('candidate_ref='))?.slice('candidate_ref='.length) ?? null,
        correlation: {
          new_run_ids: runIds(fresh),
          eligible_run_ids: runIds(eligible),
          excluded_run_ids: [...exclude],
          method: 'unique new workflow_dispatch run after this dispatch',
        },
        note: 'requested is not verified: only the platform result and the durable collection make this attempt real',
      }
    }
    if (eligible.length > 1) {
      return {
        status: 'ambiguous',
        action: plan.action,
        workflow: plan.workflow,
        repository: plan.repository,
        message: `the dispatch command succeeded but ${eligible.length} new runs of ${plan.workflow} appeared, so none of them can be attributed to this request`,
        correlation: { new_run_ids: runIds(fresh), eligible_run_ids: runIds(eligible), excluded_run_ids: [...exclude], method: 'unique new workflow_dispatch run after this dispatch' },
        note: 'do not retry blindly: observe the workflow list and decide which run this request created; a second dispatch would spend the frozen candidate again',
      }
    }
  }
  return {
    status: 'ambiguous',
    action: plan.action,
    workflow: plan.workflow,
    repository: plan.repository,
    message: `the dispatch command succeeded but no run of ${plan.workflow} could be attributed to this request`,
    correlation: { new_run_ids: runIds(lastFresh), eligible_run_ids: [], excluded_run_ids: [...exclude], method: 'unique new workflow_dispatch run after this dispatch', observed_run_ids: runIds(lastSaw) },
    note: 'do not retry blindly: observe the workflow list first, or the frozen candidate may be spent on a duplicate request',
  }
}

/** Read one exact run. Reported facts only; no interpretation of success. */
export async function observeRun(runner, { repository, runId }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository || ''))) throw new Error('repository must be owner/name')
  if (!/^[1-9][0-9]*$/.test(String(runId ?? ''))) throw new Error('run id must be an exact positive integer')
  const result = await runner(['run', 'view', String(runId), '--repo', repository, '--json', 'databaseId,status,conclusion,headSha,url,event,workflowName,createdAt,updatedAt,jobs'])
  if (result.exit_code !== 0) {
    return { status: 'unknown', run_id: String(runId), message: `the platform could not report this run: ${String(result.stderr || '').trim().slice(0, 300)}` }
  }
  let data
  try {
    data = JSON.parse(result.stdout || '{}')
  } catch (error) {
    return { status: 'unknown', run_id: String(runId), message: `run report was not valid JSON: ${error.message}` }
  }
  const jobs = (data.jobs || []).map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion }))
  const complete = data.status === 'completed'
  return {
    status: data.status,
    conclusion: data.conclusion ?? null,
    run_id: String(data.databaseId ?? runId),
    url: data.url ?? null,
    workflow: data.workflowName ?? null,
    candidate: data.headSha ?? null,
    jobs,
    completed: complete,
    successful: complete && data.conclusion === 'success',
    note: complete
      ? 'a completed run is still not promotion: the durable collector records the attempt, and only the promotion job moves a Baseline'
      : 'the run is still in flight; do not treat progress as a result',
  }
}
