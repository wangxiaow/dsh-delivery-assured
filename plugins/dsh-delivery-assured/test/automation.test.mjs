#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendIteration, loadIterations, nextIterationId, openIteration, reduceIterations, summarizeRecovery, validateEvent } from '../lib/iterations.js'
import { buildDispatch, observeRun, requestForWorkflow, requestRun } from '../lib/ci-request.js'

const at = (n) => `2026-01-01T00:00:0${n}Z`
const opened = (id = 'IT-001', requirement = '给我一个能用的记账 CLI') => ({ id, kind: 'opened', at: at(1), requirement })

/* ------------------------------------------------------------------ journal */

test('an iteration keeps its whole history and recovery reports it', () => {
  const events = [opened(), { id: 'IT-001', kind: 'noted', at: at(2), detail: '选了 SQLite' }, { id: 'IT-001', kind: 'verified', at: at(3), evidence_ref: 'ci:verify:1-1' }]
  const reduced = reduceIterations(events)
  assert.equal(reduced.current.id, 'IT-001')
  assert.equal(reduced.current.status, 'open')
  assert.equal(reduced.current.notes.length, 1)
  assert.equal(reduced.current.evidence_refs[0].ref, 'ci:verify:1-1')
  assert.deepEqual(reduced.problems, [])
  const lines = summarizeRecovery({ iterations: reduced, resume: { owed: { unmapped: ['J-X'], pending_implementation: [] }, budget: { counted: 2, limits: { total_attempt_limit: 8, replan_limit: 2 }, replans: 1 }, next_actions: ['run the slice check'], blockers: [] } })
  assert.match(lines[0], /IT-001/)
  assert.match(lines[0], /记账 CLI/)
  assert.ok(lines.some((line) => /budget: attempts 2\/8/.test(line)))
  assert.ok(lines.some((line) => /run the slice check/.test(line)))
})

test('a blocked iteration stays visible and a new iteration continues the line', () => {
  const reduced = reduceIterations([opened(), { id: 'IT-001', kind: 'blocked', at: at(2), reason: 'no deploy permission' }, { id: 'IT-002', kind: 'opened', at: at(3), requirement: '第二轮：加导出', iteration_of: 'IT-001' }])
  assert.equal(reduced.blocked.length, 1)
  assert.equal(reduced.current.id, 'IT-002')
  assert.equal(reduced.current.iteration_of, 'IT-001')
  assert.equal(reduced.closed.length, 0)
  assert.equal(nextIterationId(reduced.iterations), 'IT-003')
})

test('closed iterations are kept, not rewritten, and the next one starts clean', () => {
  const reduced = reduceIterations([opened(), { id: 'IT-001', kind: 'closed', at: at(2) }, { id: 'IT-002', kind: 'opened', at: at(3), requirement: '新需求' }])
  assert.equal(reduced.closed.length, 1)
  assert.equal(reduced.current.id, 'IT-002')
  assert.equal(reduced.iterations.length, 2)
})

test('a malformed journal line is reported instead of silently dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-iterations-'))
  try {
    mkdirSync(join(root, '.agent'), { recursive: true })
    writeFileSync(join(root, '.agent', 'ITERATIONS.jsonl'), `${JSON.stringify(opened())}\n{not json\n`, 'utf8')
    const loaded = loadIterations(root)
    assert.equal(loaded.events.length, 1)
    assert.equal(loaded.problems.length, 1)
    appendIteration(root, { id: 'IT-001', kind: 'noted', at: at(2), detail: 'kept appending' })
    const after = loadIterations(root)
    assert.equal(after.events.length, 2)
    assert.equal(after.problems.length, 1)
    assert.match(summarizeRecovery({ iterations: reduceIterations(after.events), problems: after.problems }).join('\n'), /1 unreadable journal line/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('invalid events are refused before they reach the journal', () => {
  for (const event of [
    { id: 'IT-001', kind: 'opened', at: at(1) },
    { id: 'IT-001', kind: 'noted', at: at(1) },
    { id: 'X-1', kind: 'noted', at: at(1), detail: 'x' },
    { id: 'IT-001', kind: 'verified', at: at(1) },
    { id: 'IT-001', kind: 'blocked', at: at(1) },
    { id: 'IT-001', kind: 'noted', at: 'not-a-time', detail: 'x' },
    { id: 'IT-001', kind: 'noted', at: at(1), detail: 'x', trusted: true },
  ]) assert.ok(validateEvent(event).length > 0, JSON.stringify(event))
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-iterations-'))
  try {
    assert.throws(() => appendIteration(scratch, { id: 'IT-001', kind: 'closed', at: at(1), trusted: true }), /invalid iteration event/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------ opening a round */

function scratchJournal(initial = null) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-iterations-open-'))
  if (initial !== null) {
    mkdirSync(join(root, '.agent'), { recursive: true })
    writeFileSync(join(root, '.agent', 'ITERATIONS.jsonl'), initial, 'utf8')
  }
  return root
}

test('a first requirement opens the first iteration, with no predecessor and no id required', () => {
  const root = scratchJournal()
  try {
    const first = openIteration(root, { requirement: '给我一个只读状态工具', at: at(1) })
    assert.equal(first.event.id, 'IT-001')
    assert.equal(first.event.requirement, '给我一个只读状态工具')
    assert.equal(first.previous, null)
    assert.equal(first.event.iteration_of, undefined)
    assert.equal(first.unreadable_lines, 0)
    const reduced = reduceIterations(loadIterations(root).events)
    assert.equal(reduced.current.id, 'IT-001')
    assert.equal(reduced.current.requirement, '给我一个只读状态工具')
    assert.deepEqual(reduced.problems, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a delivered project opens the next round from the closed history, still append-only', () => {
  const root = scratchJournal()
  try {
    openIteration(root, { requirement: '第一轮需求', at: at(1) })
    appendIteration(root, { id: 'IT-001', kind: 'closed', at: at(2) })
    // Nothing is open now: opening must not depend on a current iteration.
    assert.equal(reduceIterations(loadIterations(root).events).current, null)

    const second = openIteration(root, { requirement: '第二轮：加入导出', at: at(3) })
    assert.equal(second.event.id, 'IT-002')
    assert.equal(second.previous, 'IT-001')
    assert.equal(second.event.iteration_of, 'IT-001')

    const reduced = reduceIterations(loadIterations(root).events)
    assert.equal(reduced.current.id, 'IT-002')
    assert.equal(reduced.current.iteration_of, 'IT-001')
    assert.equal(reduced.closed.length, 1)
    assert.equal(reduced.iterations.length, 2)
    const bytes = readFileSync(join(root, '.agent', 'ITERATIONS.jsonl'), 'utf8')
    assert.match(bytes, /IT-001/)
    assert.match(bytes, /IT-002/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty journal opens cleanly, and an unreadable line is reported instead of blocking or hidden', () => {
  const empty = scratchJournal('')
  const damaged = scratchJournal('{not json\n')
  try {
    assert.equal(openIteration(empty, { requirement: '空账本也要能开', at: at(1) }).event.id, 'IT-001')
    const opened = openIteration(damaged, { requirement: '坏行不吞掉', at: at(1) })
    assert.equal(opened.event.id, 'IT-001')
    assert.equal(opened.unreadable_lines, 1)
    const reduced = reduceIterations(loadIterations(damaged).events)
    assert.equal(reduced.current.requirement, '坏行不吞掉')
    assert.throws(() => openIteration(empty, { at: at(2) }), /requirement/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
    rmSync(damaged, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------- CI request */

test('a verify request is frozen, whitelisted and spends nothing unknown', () => {
  const plan = buildDispatch({ action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'BL-001', slice: 'S2', hypothesis: 'the policy change closes the flow' })
  assert.equal(plan.workflow, 'verify.yml')
  assert.deepEqual(plan.args.slice(0, 3), ['workflow', 'run', 'verify.yml'])
  assert.ok(plan.args.includes('candidate_ref=' + 'a'.repeat(40)))
  assert.throws(() => buildDispatch({ action: 'verify', repository: 'owner/repo', candidate: 'main', parent_baseline: 'none', slice: 'S2', hypothesis: 'x' }), /full 40-character/)
  assert.throws(() => buildDispatch({ action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S2', hypothesis: 'x', ref: 'evil' }), /unknown verify input/)
  assert.throws(() => buildDispatch({ action: 'deploy', repository: 'owner/repo' }), /action must be one of/)
  assert.throws(() => buildDispatch({ action: 'verify', repository: 'not-a-repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S2', hypothesis: 'x' }), /owner\/name/)
})

test('a promotion request consumes an exact completed verification, not a fresh one', () => {
  const plan = buildDispatch({ action: 'promote', repository: 'owner/repo', mode: 'MVP_READY', expected_parent: 'BL-001', verify_run_id: 42, verify_run_attempt: 1 })
  assert.equal(plan.workflow, 'promote.yml')
  assert.ok(plan.args.includes('verify_run_id=42'))
  assert.throws(() => buildDispatch({ action: 'promote', repository: 'owner/repo', mode: 'MVP_READY', expected_parent: 'BL-001' }), /exact verify run id/)
  assert.throws(() => buildDispatch({ action: 'promote', repository: 'owner/repo', mode: 'ship-it', expected_parent: 'BL-001', verify_run_id: 42, verify_run_attempt: 1 }), /mode must be/)
})

test('record-attempt re-runs the collector for one exact completed run, nothing else', () => {
  const plan = buildDispatch({ action: 'record-attempt', repository: 'owner/repo', verify_run_id: 42, verify_run_attempt: 2 })
  assert.equal(plan.workflow, 'promote.yml')
  assert.ok(plan.args.includes('mode=record-attempt'))
  assert.ok(plan.args.includes('verify_run_id=42'))
  assert.ok(plan.args.includes('verify_run_attempt=2'))
  assert.throws(() => buildDispatch({ action: 'record-attempt', repository: 'owner/repo' }), /verify_run_id must be an exact positive/)
  assert.throws(() => buildDispatch({ action: 'record-attempt', repository: 'owner/repo', verify_run_id: '0' }), /verify_run_id must be an exact positive/)
  assert.throws(() => buildDispatch({ action: 'record-attempt', repository: 'owner/repo', verify_run_id: 42, verify_run_attempt: 2, mode: 'evil' }), /unknown record-attempt input/)
})

test('resolve-diagnostic is bound to the reviewed state SHA, a real owner and a real confirmation', () => {
  const plan = buildDispatch({
    action: 'resolve-diagnostic',
    repository: 'owner/repo',
    expected_state_sha: 'c'.repeat(40),
    resolution_owner: 'wangxiaow',
    verify_run_id: 42,
    verify_run_attempt: 1,
    resolution_confirmation: 'owner-reviewed diagnostic 42-1: the collection veto was earned by a missing approval file, resolution acknowledged-unrecorded-bookkeeping-failure',
  })
  assert.equal(plan.workflow, 'promote.yml')
  assert.ok(plan.args.includes('mode=resolve-diagnostic'))
  assert.ok(plan.args.includes('expected_state_sha=' + 'c'.repeat(40)))
  assert.ok(plan.args.some((field) => field.startsWith('resolution_owner=wangxiaow')))

  assert.throws(() => buildDispatch({ action: 'resolve-diagnostic', repository: 'owner/repo' }), /expected_state_sha must be the exact 40-character/)
  assert.throws(
    () => buildDispatch({ action: 'resolve-diagnostic', repository: 'owner/repo', expected_state_sha: 'c'.repeat(40), resolution_owner: 'wangxiaow', verify_run_id: 42, verify_run_attempt: 1 }),
    /resolution_confirmation/,
  )
  assert.throws(
    () => buildDispatch({
      action: 'resolve-diagnostic',
      repository: 'owner/repo',
      expected_state_sha: 'c'.repeat(40),
      resolution_owner: 'pending',
      verify_run_id: 42,
      verify_run_attempt: 1,
      resolution_confirmation: 'a real confirmation reference from the review',
    }),
    /not a placeholder/,
  )
  assert.throws(
    () => buildDispatch({
      action: 'resolve-diagnostic',
      repository: 'owner/repo',
      expected_state_sha: 'c'.repeat(40),
      resolution_owner: 'wangxiaow',
      verify_run_id: 42,
      verify_run_attempt: 1,
      resolution_confirmation: 'real',
      extra: 'no',
    }),
    /unknown resolve-diagnostic input/,
  )
})

test('each action is built from its own declared inputs, so no undefined field is ever forwarded', () => {
  // Exactly what a tool call hands over: one action's fields plus every other field the
  // schema declares, absent. Forwarding the whole bag made every verify request fail with
  // `unknown verify input mode` before the platform was ever asked.
  const bag = {
    candidate: 'a'.repeat(40),
    parent_baseline: 'BL-003',
    slice: 'S2',
    hypothesis: 'the policy change closes the flow',
    comparison_approval_ref: undefined,
    mode: undefined,
    expected_parent: undefined,
    verify_run_id: undefined,
    verify_run_attempt: undefined,
    owner_approval_ref: undefined,
    expected_state_sha: undefined,
    resolution_owner: undefined,
    resolution_confirmation: undefined,
    run_id: undefined,
  }
  const verify = buildDispatch(requestForWorkflow('verify', bag, { repository: 'owner/repo' }))
  assert.equal(verify.workflow, 'verify.yml')
  assert.ok(verify.args.includes(`candidate_ref=${'a'.repeat(40)}`))
  assert.ok(verify.args.includes('parent_baseline=BL-003'))
  assert.ok(verify.args.includes('slice_id=S2'))
  assert.ok(verify.args.includes('sliceKey=S2'))
  assert.ok(!verify.args.some((a) => a.startsWith('mode=')))
  assert.ok(!verify.args.some((a) => a.startsWith('expected_parent=')))
  assert.ok(!verify.args.some((a) => /undefined|null/.test(a)))

  const promote = buildDispatch(requestForWorkflow('promote', { ...bag, mode: 'MVP_READY', expected_parent: 'BL-003', verify_run_id: '42', verify_run_attempt: '1' }, { repository: 'owner/repo' }))
  assert.equal(promote.workflow, 'promote.yml')
  assert.ok(promote.args.includes('mode=MVP_READY'))
  assert.ok(promote.args.includes('expected_parent=BL-003'))
  assert.ok(promote.args.includes('verify_run_id=42'))
  assert.ok(!promote.args.some((a) => a.startsWith('candidate_ref=')))
  assert.ok(!promote.args.some((a) => a.startsWith('slice_id=')))

  const record = buildDispatch(requestForWorkflow('record-attempt', { ...bag, verify_run_id: '42', verify_run_attempt: '2' }, { repository: 'owner/repo' }))
  assert.ok(record.args.includes('mode=record-attempt'))
  assert.ok(!record.args.some((a) => a.startsWith('candidate_ref=')))

  const resolve = buildDispatch(requestForWorkflow('resolve-diagnostic', {
    ...bag,
    expected_state_sha: 'b'.repeat(40),
    resolution_owner: 'wangxiaow',
    verify_run_id: '42',
    verify_run_attempt: '1',
    resolution_confirmation: 'owner-reviewed retention of diagnostic 42-1',
  }, { repository: 'owner/repo' }))
  assert.ok(resolve.args.includes('mode=resolve-diagnostic'))
  assert.ok(resolve.args.includes(`expected_state_sha=${'b'.repeat(40)}`))

  for (const action of ['verify', 'promote', 'record-attempt', 'resolve-diagnostic']) {
    const request = requestForWorkflow(action, bag, { repository: 'owner/repo' })
    assert.ok(Object.values(request).every((value) => value !== undefined && value !== null && value !== ''), `${action} forwarded an empty value: ${JSON.stringify(request)}`)
    assert.deepEqual(Object.keys(request).filter((key) => !['action', 'repository'].includes(key)), Object.keys(request).filter((key) => !['action', 'repository'].includes(key) && bag[key] !== undefined))
  }
  assert.throws(() => requestForWorkflow('deploy', bag, { repository: 'owner/repo' }), /action must be one of/)
})

test('a dispatch is attributed to exactly one new run, never to the newest run', async () => {
  const request = { action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x' }
  const run = (id, extra = {}) => ({ databaseId: id, url: `https://example/run/${id}`, status: 'queued', conclusion: null, headSha: 'f'.repeat(40), headBranch: 'main', event: 'workflow_dispatch', createdAt: '2026-01-01T00:00:05Z', ...extra })
  const listOf = (runs) => ({ exit_code: 0, stdout: JSON.stringify(runs), stderr: '' })
  const dispatches = (calls) => calls.filter((call) => call.startsWith('workflow run')).length

  // One new run after the dispatch: that is the one this request created.
  {
    const calls = []
    let reads = 0
    const runner = async (args) => {
      calls.push(args.join(' '))
      if (args[1] === 'list') {
        reads += 1
        return listOf(reads === 1 ? [run(77)] : [run(88), run(77)])
      }
      return { exit_code: 0, stdout: '', stderr: '' }
    }
    const correlated = await requestRun(runner, request, { sleep: async () => {}, delayMs: 0 })
    assert.equal(correlated.status, 'requested')
    assert.equal(correlated.run_id, 88)
    assert.deepEqual(correlated.correlation.eligible_run_ids, ['88'])
    assert.equal(correlated.correlation.new_run_ids.includes('88'), true)
    assert.equal(correlated.frozen_candidate, 'a'.repeat(40))
    assert.equal(correlated.run_head_sha, 'f'.repeat(40))
    assert.equal(dispatches(calls), 1)
  }

  // Two new runs: nothing proves which is ours, so do not pick the newest.
  {
    const calls = []
    let reads = 0
    const runner = async (args) => {
      calls.push(args.join(' '))
      if (args[1] === 'list') {
        reads += 1
        return listOf(reads === 1 ? [run(77)] : [run(89), run(88), run(77)])
      }
      return { exit_code: 0, stdout: '', stderr: '' }
    }
    const ambiguous = await requestRun(runner, request, { sleep: async () => {}, delayMs: 0 })
    assert.equal(ambiguous.status, 'ambiguous')
    assert.match(ambiguous.message, /2 new runs/)
    assert.deepEqual([...ambiguous.correlation.eligible_run_ids].sort(), ['88', '89'])
    assert.equal(ambiguous.run_id, undefined)
    assert.equal(dispatches(calls), 1)
  }

  // A new run of this workflow that is not a dispatch (verify.yml also runs on pull
  // requests) is not eligible, and must not be adopted as this dispatch's run.
  {
    let reads = 0
    const runner = async (args) => {
      if (args[1] === 'list') {
        reads += 1
        return listOf(reads === 1 ? [run(77)] : [run(90, { event: 'pull_request' }), run(77)])
      }
      return { exit_code: 0, stdout: '', stderr: '' }
    }
    const ambiguous = await requestRun(runner, request, { sleep: async () => {}, delayMs: 0, attempts: 2 })
    assert.equal(ambiguous.status, 'ambiguous')
    assert.equal(ambiguous.run_id, undefined)
    assert.deepEqual(ambiguous.correlation.new_run_ids, ['90'])
    assert.deepEqual(ambiguous.correlation.eligible_run_ids, [])
  }

  // The run appears only on a later read: the list is re-read, the dispatch is not repeated.
  {
    const calls = []
    let reads = 0
    const runner = async (args) => {
      calls.push(args.join(' '))
      if (args[1] === 'list') {
        reads += 1
        if (reads <= 2) return listOf([run(77)])
        return listOf([run(99), run(77)])
      }
      return { exit_code: 0, stdout: '', stderr: '' }
    }
    const correlated = await requestRun(runner, request, { sleep: async () => {}, delayMs: 0, attempts: 3 })
    assert.equal(correlated.status, 'requested')
    assert.equal(correlated.run_id, 99)
    assert.equal(dispatches(calls), 1)
  }

  // The run set cannot be read before dispatching: no dispatch is made at all, because a
  // run that cannot be attributed would still spend the frozen candidate.
  {
    let dispatched = false
    const runner = async (args) => {
      if (args[1] === 'list') return { exit_code: 1, stdout: '', stderr: 'HTTP 403' }
      dispatched = true
      return { exit_code: 0, stdout: '', stderr: '' }
    }
    const result = await requestRun(runner, request, { sleep: async () => {}, delayMs: 0 })
    assert.equal(result.status, 'ambiguous')
    assert.equal(dispatched, false)
    assert.match(result.message, /no dispatch was made/)
  }

  // A refused dispatch is refused before any correlation attempt.
  {
    let listed = 0
    const refused = await requestRun(async (args) => {
      if (args[1] === 'list') { listed += 1; return listOf([run(77)]) }
      return { exit_code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }
    }, request, { sleep: async () => {}, delayMs: 0 })
    assert.equal(refused.status, 'refused')
    assert.match(refused.message, /403/)
    assert.equal(listed, 1, 'the refused dispatch is not correlated')
  }
})

test('dispatching reports the created run, refuses blind retries and never claims a result', async () => {
  const calls = []
  let reads = 0
  const runner = async (args) => {
    calls.push(args.join(' '))
    if (args[1] === 'list') {
      reads += 1
      return { exit_code: 0, stdout: JSON.stringify(reads === 1 ? [{ databaseId: 77, url: 'https://example/run/77', status: 'queued', conclusion: null, headSha: 'a'.repeat(40), headBranch: 'main', createdAt: at(1), event: 'workflow_dispatch' }] : [{ databaseId: 88, url: 'https://example/run/88', status: 'queued', conclusion: null, headSha: 'a'.repeat(40), headBranch: 'main', createdAt: at(1), event: 'workflow_dispatch' }, { databaseId: 77, url: 'https://example/run/77', status: 'queued', conclusion: null, headSha: 'a'.repeat(40), headBranch: 'main', createdAt: at(1), event: 'workflow_dispatch' }]), stderr: '' }
    }
    return { exit_code: 0, stdout: '', stderr: '' }
  }
  const requested = await requestRun(runner, { action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x' }, { sleep: async () => {}, delayMs: 0 })
  assert.equal(requested.status, 'requested')
  assert.equal(requested.run_id, 88)
  assert.equal(requested.correlation.excluded_run_ids.includes('77'), true)
  assert.match(requested.note, /requested is not verified/)
  assert.equal(calls.length, 3)

  const ambiguous = await requestRun(async (args) => args[1] === 'list' ? { exit_code: 0, stdout: '[]', stderr: '' } : { exit_code: 0, stdout: '', stderr: '' }, { action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x' }, { sleep: async () => {}, delayMs: 0, attempts: 2 })
  assert.equal(ambiguous.status, 'ambiguous')
  assert.match(ambiguous.note, /do not retry blindly/)

  const refused = await requestRun(async (args) => args[1] === 'list' ? { exit_code: 0, stdout: '[]', stderr: '' } : { exit_code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }, { action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x' }, { sleep: async () => {}, delayMs: 0 })
  assert.equal(refused.status, 'refused')
  assert.match(refused.message, /403/)
})

test('observing a run reports the platform facts without inventing a promotion', async () => {
  const completed = await observeRun(async () => ({ exit_code: 0, stdout: JSON.stringify({ databaseId: 77, status: 'completed', conclusion: 'success', headSha: 'a'.repeat(40), url: 'https://example/run/77', event: 'workflow_dispatch', workflowName: 'verify', jobs: [{ name: 'verify candidate', status: 'completed', conclusion: 'success' }] }), stderr: '' }), { repository: 'owner/repo', runId: 77 })
  assert.equal(completed.successful, true)
  assert.equal(completed.jobs[0].name, 'verify candidate')
  assert.match(completed.note, /still not promotion/)

  const running = await observeRun(async () => ({ exit_code: 0, stdout: JSON.stringify({ databaseId: 78, status: 'in_progress', conclusion: null, jobs: [] }), stderr: '' }), { repository: 'owner/repo', runId: 78 })
  assert.equal(running.successful, false)
  assert.equal(running.completed, false)
  assert.match(running.note, /still in flight/)

  const unknown = await observeRun(async () => ({ exit_code: 1, stdout: '', stderr: 'not found' }), { repository: 'owner/repo', runId: 99 })
  assert.equal(unknown.status, 'unknown')
  await assert.rejects(() => observeRun(async () => ({ exit_code: 0, stdout: '{}', stderr: '' }), { repository: 'owner/repo', runId: 'latest' }), /positive integer/)
})
