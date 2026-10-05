/**
 * Durable iteration journal — the resumable spine of automatic delivery.
 *
 * One append-only file per project (`<project>/.agent/ITERATIONS.jsonl`) records
 * what the user asked for, what the system decided to do about it, and how it
 * ended. It is a *summary*, never authority: Evidence, Coverage and Baseline stay
 * where they are, and nothing here can mark a delivery complete. Its only job is
 * that a new session — after a crash, a restart or a model change — can recover
 * the current requirement, what is already done, and what is still owed without
 * the user repeating it.
 *
 * The interface is deliberately tiny: validate, append, reduce, summarize.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ITERATION_LEDGER = join('.agent', 'ITERATIONS.jsonl')
export const EVENT_KINDS = ['opened', 'noted', 'verified', 'blocked', 'closed']
const STATUS_BY_KIND = { opened: 'open', verified: 'open', noted: 'open', blocked: 'blocked', closed: 'closed' }
const ID = /^IT-[0-9]{3,}$/
const text = (value) => typeof value === 'string' && value.trim() !== ''

/** Structural problems of one journal event; never repairs, only reports. */
export function validateEvent(event) {
  const problems = []
  if (!event || typeof event !== 'object' || Array.isArray(event)) return ['event must be an object']
  if (!ID.test(String(event.id || ''))) problems.push('id must match IT-<digits>')
  if (!EVENT_KINDS.includes(event.kind)) problems.push(`kind must be one of ${EVENT_KINDS.join(', ')}`)
  if (!text(event.at) || !Number.isFinite(Date.parse(event.at))) problems.push('at must be a real timestamp')
  if (event.kind === 'opened' && !text(event.requirement)) problems.push('opened events must carry the user requirement')
  if (event.kind === 'noted' && !text(event.detail)) problems.push('noted events must carry a detail')
  if (event.kind === 'blocked' && !text(event.reason)) problems.push('blocked events must carry a reason')
  if (event.kind === 'verified' && !text(event.evidence_ref)) problems.push('verified events must name the evidence actually observed')
  for (const field of Object.keys(event)) if (!['id', 'kind', 'at', 'requirement', 'detail', 'reason', 'evidence_ref', 'iteration_of'].includes(field)) problems.push(`unknown field ${field}`)
  return problems
}

/** Next free iteration ID from the events seen so far. */
export function nextIterationId(events = []) {
  const numbers = events.map((event) => Number((ID.exec(String(event?.id || '')) || [])[0]?.slice(3))).filter((n) => Number.isFinite(n))
  return `IT-${String(numbers.length === 0 ? 1 : Math.max(...numbers) + 1).padStart(3, '0')}`
}

/**
 * Fold the journal into current state. Later events never erase earlier ones, and
 * a malformed line is reported instead of being skipped quietly.
 */
export function reduceIterations(events = []) {
  const problems = []
  const iterations = new Map()
  for (const [index, event] of events.entries()) {
    const issues = validateEvent(event)
    if (issues.length) {
      problems.push({ line: index + 1, problems: issues })
      continue
    }
    if (!iterations.has(event.id)) iterations.set(event.id, { id: event.id, requirement: null, opened_at: null, status: 'open', notes: [], evidence_refs: [], blocked_reason: null, closed_at: null, events: 0 })
    const iteration = iterations.get(event.id)
    iteration.events += 1
    if (event.kind === 'opened') {
      iteration.requirement = event.requirement
      iteration.opened_at = event.at
      if (event.iteration_of) iteration.iteration_of = event.iteration_of
    }
    if (event.kind === 'noted') iteration.notes.push({ at: event.at, detail: event.detail })
    if (event.kind === 'verified') iteration.evidence_refs.push({ at: event.at, ref: event.evidence_ref })
    if (event.kind === 'blocked') iteration.blocked_reason = event.reason
    if (event.kind === 'closed') iteration.closed_at = event.at
    iteration.status = STATUS_BY_KIND[event.kind] ?? iteration.status
  }
  const list = [...iterations.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const current = [...list].reverse().find((iteration) => iteration.status !== 'closed') || null
  return { iterations: list, current, problems, open: list.filter((i) => i.status === 'open'), blocked: list.filter((i) => i.status === 'blocked'), closed: list.filter((i) => i.status === 'closed') }
}

/** Read the journal. A missing file is an empty journal; a malformed line is not. */
export function loadIterations(root) {
  const path = join(root, ITERATION_LEDGER)
  if (!existsSync(path)) return { path, events: [], raw: '' }
  const raw = readFileSync(path, 'utf8')
  const events = []
  const problems = []
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      problems.push({ line: index + 1, problems: [`not valid JSON: ${error.message}`] })
    }
  }
  return { path, events, raw, problems }
}

/**
 * Append one validated event. Appending only — a rewritten journal would destroy
 * exactly the history a recovery depends on.
 */
export function appendIteration(root, event) {
  const problems = validateEvent(event)
  if (problems.length) throw new Error(`invalid iteration event: ${problems.join('; ')}`)
  const path = join(root, ITERATION_LEDGER)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
  return path
}

/**
 * One compact recovery summary: what the user asked for, what is still owed, what
 * blocked. `resume` supplies the authoritative owed/budget facts; this function
 * only joins them to the journal so a new session needs no oral history.
 */
export function summarizeRecovery({ iterations, problems = null, resume = null } = {}) {
  const reduced = iterations || { iterations: [], current: null, problems: [] }
  const unreadable = problems || reduced.problems || []
  const lines = []
  if (reduced.current) {
    lines.push(`iteration ${reduced.current.id} (${reduced.current.status}): ${reduced.current.requirement || '(no requirement recorded)'}`)
    if (reduced.current.blocked_reason) lines.push(`blocked: ${reduced.current.blocked_reason}`)
    if (reduced.current.notes.length) lines.push(`last note: ${reduced.current.notes.at(-1).detail}`)
  } else if (reduced.iterations.length) {
    lines.push(`no open iteration; ${reduced.iterations.length} closed (latest ${reduced.iterations.at(-1).id})`)
  } else {
    lines.push('no iteration has been recorded yet; open one with the user requirement before planning')
  }
  lines.push(`history: ${reduced.iterations.length} iteration(s), ${unreadable.length} unreadable journal line(s)`)
  if (resume) {
    const owed = resume.owed || {}
    lines.push(`owed: blockers ${(resume.blockers || []).length}, unmapped ${(owed.unmapped || []).length}, pending ${(owed.pending_implementation || []).length}, failing ${(owed.current_failure || []).length}, stale ${(owed.stale_evidence || []).length}`)
    const budget = resume.budget || {}
    lines.push(`budget: attempts ${budget.counted ?? 0}/${budget.limits?.total_attempt_limit ?? '?'}, replans ${budget.replans ?? 0}/${budget.limits?.replan_limit ?? '?'}`)
    for (const action of (resume.next_actions || []).slice(0, 3)) lines.push(`next: ${action}`)
  }
  return lines
}

/** Convenience writer used by tests and one-off recovery drills. */
export function writeIterations(root, events) {
  const path = join(root, ITERATION_LEDGER)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), 'utf8')
  return path
}
