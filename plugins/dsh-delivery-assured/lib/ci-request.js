/**
 * Narrow CI request/observe interface for a DSH session (v0.5 §12, §16.4).
 *
 * A session may *ask* the platform to run the frozen verification or promotion
 * workflow, and may read what happened. It never receives a baseline credential,
 * never writes Evidence and never advances a ref — the promotion job remains the
 * only holder of that credential, and this module only builds argument lists and
 * parses the CLI's JSON.
 *
 * Requests are validated against a whitelist: one exact repository, two known
 * workflow names, a full candidate SHA, declared inputs only. A dispatch whose
 * result cannot be identified is reported as `ambiguous` and is never retried,
 * because a blind retry spends another attempt against the same frozen candidate.
 */

export const WORKFLOW_FILE = { verify: 'verify.yml', promote: 'promote.yml' }
const SHA = /^[0-9a-f]{40}$/
const BASELINE = /^(none|BL-[0-9]+)$/
const text = (value) => typeof value === 'string' && value.trim() !== ''

function requireText(value, field) {
  if (!text(value)) throw new Error(`${field} is required`)
  return value.trim()
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

/** Ask the platform to run a frozen workflow. No retry, no credential, no state. */
export async function requestRun(runner, request, { previousRunId = null } = {}) {
  const plan = buildDispatch(request)
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
  const listed = await runner(['run', 'list', '--repo', plan.repository, '--workflow', plan.workflow, '--limit', '5', '--json', 'databaseId,url,status,conclusion,headSha,createdAt,event'])
  let runs = []
  try {
    runs = JSON.parse(listed.stdout || '[]')
  } catch {
    runs = []
  }
  const fresh = runs.filter((run) => String(run.databaseId) !== String(previousRunId ?? ''))
  const created = fresh.find((run) => run.event === 'workflow_dispatch') || fresh[0] || null
  if (!created) {
    return {
      status: 'ambiguous',
      action: plan.action,
      workflow: plan.workflow,
      repository: plan.repository,
      message: 'the dispatch command succeeded but no new run could be identified',
      note: 'do not retry blindly: observe the workflow list first, or the frozen candidate may be spent on a duplicate request',
    }
  }
  return {
    status: 'requested',
    action: plan.action,
    workflow: plan.workflow,
    repository: plan.repository,
    run_id: created.databaseId,
    url: created.url,
    candidate: created.headSha,
    run_status: created.status,
    created_at: created.createdAt,
    note: 'requested is not verified: only the platform result and the durable collection make this attempt real',
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
