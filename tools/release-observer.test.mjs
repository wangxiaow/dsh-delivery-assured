#!/usr/bin/env node
import test from 'node:test'
import assert from 'node:assert/strict'
import { observeReleasePrerequisites, PREREQUISITE_OBSERVERS } from '../ci/tools/ci-release-observer.mjs'

const revision = 'a'.repeat(40)
const repository = 'owner/repo'

function model() {
  return {
    currentBindings: { contract_digest: 'b'.repeat(64), acceptance_digest: 'c'.repeat(64) },
    contract: {
      deployment: {
        release_prerequisites: [
          { id: 'verify-required-checks', verification: 'required_check_runs_on_candidate', expects: ['structural checks', 'verify candidate'] },
          { id: 'baseline-ref-readable', verification: 'baseline_ref_readable' },
          { id: 'verification-workflow-active', verification: 'verification_workflow_active' },
        ],
      },
    },
  }
}

const okFetch = async (url) => {
  if (url.includes('/check-runs')) {
    return { ok: true, json: async () => ({ check_runs: [{ name: 'structural checks', status: 'completed', conclusion: 'success' }, { name: 'verify candidate', status: 'completed', conclusion: 'success' }] }) }
  }
  if (url.includes('/git/ref/heads/')) return { ok: true, json: async () => ({ object: { sha: revision } }) }
  if (url.includes('/actions/workflows/')) return { ok: true, json: async () => ({ state: 'active' }) }
  throw new Error(`unexpected url ${url}`)
}

const observe = (patch = {}, fetchImpl = okFetch) => observeReleasePrerequisites(patch.model || model(), {
  repository: patch.repository || repository,
  candidate: patch.candidate || revision,
  token: patch.token ?? 'read-token',
  reference: patch.reference,
  fetchImpl: patch.fetchImpl || fetchImpl,
})

test('every declared prerequisite can be observed from the platform without a human receipt', async () => {
  const receipt = await observe()
  assert.equal(receipt.result, 'PASS')
  assert.equal(receipt.prerequisites.length, 3)
  assert.ok(receipt.prerequisites.every((item) => item.result === 'PASS' && item.observation.observed === true))
  assert.match(receipt.confirmation_ref, /^github:owner\/repo\//)
  assert.equal(receipt.bindings.code_revision, revision)
})

test('a missing permission, absent check or failing check is UNVERIFIED, never PASS', async () => {
  const cases = {
    'http error': async (url) => url.includes('/check-runs') ? { ok: false, status: 403 } : okFetch(url),
    'absent required check': async (url) => url.includes('/check-runs') ? { ok: true, json: async () => ({ check_runs: [{ name: 'structural checks', status: 'completed', conclusion: 'success' }] }) } : okFetch(url),
    'failing required check': async (url) => url.includes('/check-runs') ? { ok: true, json: async () => ({ check_runs: [{ name: 'structural checks', status: 'completed', conclusion: 'success' }, { name: 'verify candidate', status: 'completed', conclusion: 'failure' }] }) } : okFetch(url),
    'missing baseline ref': async (url) => url.includes('/git/ref/heads/') ? { ok: false, status: 404 } : okFetch(url),
    'inactive workflow': async (url) => url.includes('/actions/workflows/') ? { ok: true, json: async () => ({ state: 'disabled_manually' }) } : okFetch(url),
  }
  for (const [label, fetchImpl] of Object.entries(cases)) {
    const receipt = await observe({ fetchImpl })
    assert.equal(receipt.result, 'UNVERIFIED', label)
    assert.ok(receipt.prerequisites.some((item) => item.result === 'UNVERIFIED' && typeof item.error === 'string'), label)
  }
})

test('an unknown verification kind or unresolvable prerequisite blocks instead of passing silently', async () => {
  const unknownKind = model()
  unknownKind.contract.deployment.release_prerequisites = [{ id: 'mystery', verification: 'trust_me' }]
  assert.equal((await observe({ model: unknownKind })).result, 'UNVERIFIED')
  const noId = model()
  noId.contract.deployment.release_prerequisites = [{ verification: 'baseline_ref_readable' }]
  assert.equal((await observe({ model: noId })).result, 'UNVERIFIED')
  assert.equal((await observe({ model: { currentBindings: {}, contract: { deployment: { release_prerequisites: ['plain-string'] } } } })).result, 'UNVERIFIED')
})

test('an observation without an exact repository or token is refused', async () => {
  await assert.rejects(() => observe({ repository: 'not-a-repo' }), /repository/)
  await assert.rejects(() => observe({ token: '' }), /token/)
  await assert.rejects(() => PREREQUISITE_OBSERVERS.required_check_runs_on_candidate({ repository, candidate: 'short', expects: ['x'], token: 't', fetchImpl: okFetch }), /SHA/)
  await assert.rejects(() => PREREQUISITE_OBSERVERS.baseline_ref_readable({ repository, ref: 'refs/heads/main', token: 't', fetchImpl: okFetch }), /baseline/)
})
