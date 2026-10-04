import assert from 'node:assert/strict'
import { auditCompletedHistory, applyHistoryAudit } from '../ci/tools/ci-history.mjs'
const repository = 'fixture/repo', sha = 'a'.repeat(40)
const run = (id, run_attempt = 1, status = 'completed') => ({ id, run_attempt, path: '.github/workflows/verify.yml', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: repository }, status, conclusion: status === 'completed' ? 'failure' : null, head_sha: sha })
const receipt = item => ({ repository, run_id: item.id, run_attempt: item.run_attempt, run_key: `${item.id}-${item.run_attempt}`, verifier_revision: item.head_sha, conclusion: item.conclusion, path: item.path, event: item.event, head_branch: item.head_branch })
let checks = 0
const check = condition => { assert.ok(condition); checks++ }
function requestFor(runs, attempts = runs, transform = null) {
  return async url => {
    const parsed = new URL(url)
    let data
    if (parsed.pathname.endsWith('/runs')) {
      const page = Number(parsed.searchParams.get('page'))
      data = { total_count: runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100) }
    } else {
      const [, id, attempt] = /\/runs\/(\d+)\/attempts\/(\d+)$/.exec(parsed.pathname) || []
      data = attempts.find(r => r.id === Number(id) && r.run_attempt === Number(attempt))
    }
    if (transform) data = transform(structuredClone(data), parsed)
    return { ok: Boolean(data), status: data ? 200 : 404, json: async () => structuredClone(data) }
  }
}
const audit = (runs, receipts = [], extra = {}) => auditCompletedHistory({ repository, token: 'offline-test-only', receipts, request: requestFor(runs), ...extra })
check((await audit([run(1)])).missing[0] === '1-1')
check((await audit([run(1)], [receipt(run(1))])).blockers.length === 0)
const current = run(2, 2, 'in_progress'), earlier = run(2, 1)
const backfill = await audit([current], [], { request: requestFor([current], [earlier, current]) })
check(backfill.completed === 1 && backfill.missing[0] === '2-1')
check(backfill.examined === 2)
check((await audit([current], [receipt(earlier)], { request: requestFor([current], [earlier, current]) })).blockers.length === 0)
const many = Array.from({ length: 101 }, (_, i) => run(i + 1))
check((await audit(many)).missing.length === 101)
async function rejects(runs, receipts, extra, re) { await assert.rejects(() => audit(runs, receipts, extra), re); checks++ }
await rejects(many, [], { maxPages: 1 }, /page budget/)
await rejects([current], [], { maxAttempts: 1, request: requestFor([current], [earlier, current]) }, /attempt budget/)
await rejects([run(1)], [], { request: async () => ({ ok: false, status: 403 }) }, /API failed/)
await rejects([run(1)], [receipt(run(1)), receipt(run(1))], {}, /duplicate/)
await rejects([run(1)], [{ ...receipt(run(1)), conclusion: 'success' }], {}, /conflicts/)
await rejects([run(1)], [], { request: requestFor([run(1)], [run(1)], (data, url) => url.pathname.endsWith('/runs') ? { ...data, total_count: 2 } : data) }, /incomplete/)
await rejects([run(1)], [], { request: requestFor([run(1)], [run(1)], (data, url) => url.pathname.endsWith('/runs') ? data : { ...data, run_attempt: 2 }) }, /provenance mismatch/)
await rejects([{ ...run(1), head_branch: 'candidate' }], [], {}, /untrusted/)
await rejects([run(1)], [], { request: requestFor([run(1)], [run(1)], (data, url) => url.pathname.endsWith('/runs') ? data : { ...data, conclusion: null }) }, /invalid completed/)
const report = { blockers: [], budget: { history_known: true, remaining: 8, terminal_passed: true, blocked: false, invalid_entries: [] } }
const lost = applyHistoryAudit(report, await audit([run(1)]))
check(lost.budget.remaining === null && lost.budget.history_known === false)
check(lost.budget.terminal_passed === false && lost.budget.blocked === true)
check(lost.budget.invalid_entries.length === 1 && lost.blockers.length === 1)
check(report.budget.remaining === 8 && report.blockers.length === 0)
const complete = applyHistoryAudit(report, await audit([run(1)], [receipt(run(1))]))
check(complete.budget.history_known && complete.budget.remaining === 8 && complete.blockers.length === 0)
console.log(`ci-history.test ok: ${checks} offline checks; no external API called`)
