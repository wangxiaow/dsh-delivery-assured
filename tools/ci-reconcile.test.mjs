import test from 'node:test'
import assert from 'node:assert/strict'
import { auditCompletedHistory, applyHistoryAudit } from '../ci/tools/ci-history.mjs'
import { reconciliationPlan, dispatchReconciliation } from '../ci/tools/ci-reconcile.mjs'

const repository = 'example/project'
const token = 'test-secret-never-external'
const blocker = key => `completed verification attempt ${key} has no durable receipt; reconcile before Candidate execution`
const audit = (missing = ['41-1', '41-2', '42-1', '43-1']) => ({ diagnostic_only: true, examined: 6, completed: 5, missing, blockers: missing.map(blocker) })
const fixturePlan = () => reconciliationPlan(audit())
const dispatch = (plan, request, extra = {}) => dispatchReconciliation({ repository, token, plan, request, ...extra })

test('default and positive caps select only explicit exact keys, preserving overflow without mutation', () => {
  const source = audit(), before = structuredClone(source)
  const plan = reconciliationPlan(source)
  assert.deepEqual(plan.dispatches, [
    { run_key: '41-1', run_id: 41, run_attempt: 1 },
    { run_key: '41-2', run_id: 41, run_attempt: 2 },
    { run_key: '42-1', run_id: 42, run_attempt: 1 }
  ])
  assert.deepEqual(plan.unresolved, ['43-1'])
  assert.deepEqual(plan.missing, source.missing)
  assert.deepEqual(source, before)
  assert.equal(reconciliationPlan(source, { maxDispatches: 1 }).dispatches.length, 1)
  assert.deepEqual(reconciliationPlan(source, { maxDispatches: 10 }).unresolved, [])
  const exactOnly = reconciliationPlan(audit(['41-2']))
  assert.deepEqual(exactOnly.dispatches.map(e => e.run_key), ['41-2'])
  for (const maxDispatches of [0, -1, 1.5, '3', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => reconciliationPlan(source, { maxDispatches }))
})

test('malformed audits, identities, duplicate exact IDs, and dishonest counts/blockers fail closed', () => {
  for (const value of [null, [], {}, { ...audit(), diagnostic_only: false }, { ...audit(), completed: 7 }, { ...audit(), completed: 3 }, { ...audit(), examined: -1 }, { ...audit(), examined: '6' }, { ...audit(), completed: 1.5 }, { ...audit(), completed: Infinity }, { ...audit(), examined: Number.MAX_SAFE_INTEGER + 1 }, { ...audit(), missing: null }, { ...audit(), blockers: [] }, { ...audit(), blockers: ['pretend recorded'] }, { ...audit(), baseline: 'authorized' }]) assert.throws(() => reconciliationPlan(value))
  for (const key of ['', '0-1', '1-0', '01-1', '1-01', '1.0-1', '-1-1', '1-1\n', '9007199254740992-1', '1-9007199254740992', 41, null]) assert.throws(() => reconciliationPlan(audit([key])))
  assert.throws(() => reconciliationPlan(audit(['41-1', '41-1'])))
  assert.throws(() => reconciliationPlan({ ...audit(), missing: new Array(1) }))
})

test('204 POSTs use only fixed main/record-attempt inputs, safe headers, redirects and finite timeout', async t => {
  const timeoutCalls = []
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeoutCalls.push(milliseconds)
    return new AbortController().signal
  })
  const calls = [], plan = fixturePlan(), before = structuredClone(plan)
  const result = await dispatch(plan, async (url, options) => {
    calls.push([url, options])
    assert.equal(url, 'https://api.github.com/repos/example/project/actions/workflows/promote.yml/dispatches')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.signal.aborted, false)
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28')
    return { status: 204, json() { throw new Error('must never read response body') } }
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(timeoutCalls, [30000, 30000, 30000])
  assert.deepEqual(calls.map(([, options]) => JSON.parse(options.body)), plan.dispatches.map(e => ({ ref: 'main', inputs: { mode: 'record-attempt', verify_run_id: String(e.run_id), verify_run_attempt: String(e.run_attempt) } })))
  assert.equal(result.status, 'queued')
  assert.deepEqual(result.queued, ['41-1', '41-2', '42-1'])
  assert.deepEqual(result.unsubmitted, ['43-1'])
  assert.deepEqual(result.unresolved, plan.missing)
  assert.deepEqual(result.blockers, plan.blockers)
  assert.deepEqual(plan, before)
  const forbidden = /recorded|runtime_isolation_verified|transport_verified|baseline|evidence_id|state_sha/
  assert.equal(forbidden.test(JSON.stringify(result)), false)
})

test('only 204 counts as queued; HTTP errors retain exact unresolved IDs and report partial failures', async () => {
  for (const status of [200, 201, 202, 301, 302, 400, 401, 403, 404, 409, 422, 429, 500, 503]) {
    const result = await dispatch(reconciliationPlan(audit(['41-1'])), async () => ({ status, ok: true }))
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.queued, [])
    assert.deepEqual(result.unsubmitted, ['41-1'])
    assert.deepEqual(result.unresolved, ['41-1'])
    assert.deepEqual(result.failures, [{ run_key: '41-1', kind: 'http', status }])
  }
  let calls = 0
  const result = await dispatch(fixturePlan(), async () => ({ status: [204, 403, 204][calls++] }))
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.queued, ['41-1', '42-1'])
  assert.deepEqual(result.unsubmitted, ['41-2', '43-1'])
  assert.deepEqual(result.unresolved, audit().missing)
})

test('ambiguous transport, timeout, redirect and malformed responses abort further submission without leaking secrets', async () => {
  for (const failure of [new Error(token), Object.assign(new Error(token), { name: 'TimeoutError' }), Object.assign(new Error(token), { name: 'AbortError' }), 'redirect error']) {
    let calls = 0
    const result = await dispatch(fixturePlan(), async () => { if (++calls === 1) return { status: 204 }; throw failure })
    assert.equal(calls, 2)
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.attempted, ['41-1', '41-2'])
    assert.deepEqual(result.queued, ['41-1'])
    assert.deepEqual(result.failures, [{ run_key: '41-2', kind: 'transport-unknown' }])
    assert.deepEqual(result.unsubmitted, ['41-2', '42-1', '43-1'])
    assert.equal(JSON.stringify(result).includes(token), false)
  }
  for (const response of [null, {}, { status: '204' }, { status: 999 }, { status: 204, redirected: true }]) {
    let calls = 0
    const result = await dispatch(fixturePlan(), async () => { calls++; return response })
    assert.equal(calls, 1)
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.failures, [{ run_key: '41-1', kind: 'ambiguous-response' }])
    assert.deepEqual(result.unsubmitted, audit().missing)
  }
})

test('configuration and altered or forged plans are rejected before any request', async () => {
  const request = () => { assert.fail('invalid input must not dispatch') }
  for (const repository of ['', '../repo', 'owner/..', 'owner/repo/extra', 'owner/repo?x', 'owner repo/name', 'https://github.com/owner/repo', null, 42]) await assert.rejects(dispatch(fixturePlan(), request, { repository }))
  for (const token of ['', ' ', null, 1, 'secret\nvalue']) await assert.rejects(dispatch(fixturePlan(), request, { token }))
  await assert.rejects(dispatch(fixturePlan(), null))
  for (const alter of [
    p => { p.dispatches[0].run_id = 42 },
    p => { p.dispatches[0].run_attempt = 0 },
    p => { p.dispatches[0].run_id = Number.MAX_SAFE_INTEGER + 1 },
    p => { p.dispatches[1] = p.dispatches[0] },
    p => { p.dispatches.push({ run_key: '43-1', run_id: 43, run_attempt: 1 }) },
    p => { p.unresolved = [] },
    p => { p.max_dispatches = 0 },
    p => { p.missing = ['99-1'] },
    p => { p.mode = 'promote-baseline' },
    p => { p.dispatches[0].ref = 'candidate' },
    p => { p.dispatches = new Array(3) }
  ]) {
    const plan = fixturePlan(); alter(plan)
    await assert.rejects(dispatch(plan, request))
  }
})

test('independent audit retains blockers after queuing; only separately stored authenticated receipts remove missing history', async () => {
  const run = { id: 41, run_attempt: 1, path: '.github/workflows/verify.yml', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: repository }, status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40) }
  const request = async url => ({ ok: true, status: 200, json: async () => url.includes('/attempts/') ? run : { total_count: 1, workflow_runs: [run] } })
  const source = await auditCompletedHistory({ repository, token, receipts: [], request })
  const result = await dispatch(reconciliationPlan(source), async () => ({ status: 204 }))
  assert.deepEqual(result.queued, ['41-1'])
  assert.deepEqual(result.missing, ['41-1'])
  const stillMissing = await auditCompletedHistory({ repository, token, receipts: [], request })
  assert.deepEqual(stillMissing, source)
  const blocked = applyHistoryAudit({ blockers: [], budget: { remaining: 3, terminal_passed: true } }, stillMissing)
  assert.equal(blocked.budget.blocked, true)
  assert.equal(blocked.budget.history_known, false)
  const receipts = [{ repository, run_id: 41, run_attempt: 1, run_key: '41-1', verifier_revision: run.head_sha, conclusion: run.conclusion, path: run.path, event: run.event, head_branch: run.head_branch }]
  const independent = await auditCompletedHistory({ repository, token, receipts, request })
  assert.deepEqual(independent.missing, [])
  const empty = reconciliationPlan(independent)
  const noDispatch = await dispatch(empty, () => assert.fail('empty audit cannot POST'))
  assert.deepEqual(noDispatch.queued, [])
  assert.deepEqual(noDispatch.unresolved, [])
})
