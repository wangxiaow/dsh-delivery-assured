#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendIteration, loadIterations, nextIterationId, reduceIterations, summarizeRecovery, validateEvent } from '../lib/iterations.js'
import { buildDispatch, observeRun, requestRun } from '../lib/ci-request.js'

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

test('dispatching reports the created run, refuses blind retries and never claims a result', async () => {
  const calls = []
  const runner = async (args) => {
    calls.push(args.join(' '))
    if (args[1] === 'list') return { exit_code: 0, stdout: JSON.stringify([{ databaseId: 77, url: 'https://example/run/77', status: 'queued', conclusion: null, headSha: 'a'.repeat(40), createdAt: at(1), event: 'workflow_dispatch' }]), stderr: '' }
    return { exit_code: 0, stdout: '', stderr: '' }
  }
  const requested = await requestRun(runner, { action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x' })
  assert.equal(requested.status, 'requested')
  assert.equal(requested.run_id, 77)
  assert.match(requested.note, /requested is not verified/)
  assert.equal(calls.length, 2)

  const ambiguous = await requestRun(async (args) => args[1] === 'list' ? { exit_code: 0, stdout: '[]', stderr: '' } : { exit_code: 0, stdout: '', stderr: '' }, { action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x' })
  assert.equal(ambiguous.status, 'ambiguous')
  assert.match(ambiguous.note, /do not retry blindly/)

  const refused = await requestRun(async () => ({ exit_code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }), { action: 'verify', repository: 'owner/repo', candidate: 'a'.repeat(40), parent_baseline: 'none', slice: 'S1', hypothesis: 'x' })
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
