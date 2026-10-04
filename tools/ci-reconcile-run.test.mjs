import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseYaml } from '../packages/delivery-assured/scripts/lib/yaml.mjs'
import { reconcileVisibleHistory } from '../ci/tools/ci-reconcile-run.mjs'
const repository = 'fixture/repo', posts = []
const run = id => ({ id, run_attempt: 1, path: '.github/workflows/verify.yml', event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: repository }, status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40) })
const request = async (url, options) => {
  if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return { status: 204 } }
  if (url.includes('/workflows/verify.yml/runs?')) return { ok: true, json: async () => ({ total_count: 2, workflow_runs: [run(900), run(300)] }) }
  if (url.endsWith('/runs/900/attempts/1')) return { ok: true, json: async () => run(900) }
  if (url.endsWith('/runs/300/attempts/1')) return { ok: true, json: async () => run(300) }
  throw new Error('unexpected offline request')
}
const report = await reconcileVisibleHistory({ repository, token: 'offline-only', receipts: [], request })
assert.equal(posts.length, 1)
assert.deepEqual(posts[0], { ref: 'main', inputs: { mode: 'record-attempt', verify_run_id: '300', verify_run_attempt: '1' } })
assert.equal(report.missing.length, 2)
assert.equal(report.blockers.length, 2)
assert.deepEqual(report.queued, ['300-1'])
const workflow = parseYaml(readFileSync(new URL('../.github/workflows/reconcile.yml', import.meta.url), 'utf8'))
assert.equal(workflow.permissions.contents, 'read')
assert.equal(workflow.permissions.actions, 'write')
assert.notEqual(workflow.concurrency.group, 'delivery-state-main')
assert.ok(workflow.jobs.plan.if.includes("refs/heads/main"))
const text = JSON.stringify(workflow)
assert.ok(!text.includes('STATE_PUSH_TOKEN') && !text.includes('BASELINE_PUSH_TOKEN'))
assert.ok(text.includes('ci-reconcile-run.mjs'))
console.log('ci-reconcile-run.test ok: 11 offline integration checks; one oldest queued, history remains blocked')
