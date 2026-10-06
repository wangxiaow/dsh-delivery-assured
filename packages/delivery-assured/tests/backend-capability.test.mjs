#!/usr/bin/env node
/**
 * Backend capability completeness — `required_observables ⊆ observed_capabilities`.
 *
 * A backend can only observe some facts. That limitation is fine. The defect this
 * suite closes is turning it into a pass: reporting `Delivered = true` for a
 * Contract whose required observability the backend that produced the record cannot
 * actually see. `not_observed`, `unsupported`, `unknown` and `warning` are never a
 * pass for a Required observable.
 *
 * The other half matters just as much: a Contract that only asks for build, boot,
 * acceptance and regression must stay completable by the host backend, so a
 * `deployment` gate alone never makes the deployment observable required.
 *
 * Run: node packages/delivery-assured/tests/backend-capability.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  BACKEND_CAPABILITY_INSUFFICIENT,
  OBSERVABLE,
  assessBackendCapability,
  assessPlannedCapability,
  capabilityMessage,
  observedCapabilities,
  requiredObservables,
} from '../scripts/lib/capability.mjs'
import { EVIDENCE_GATES } from '../scripts/lib/evidence.mjs'
import {
  CONTRACT_REQUIRING_DEPLOYMENT,
  assessDelivery,
  cleanup,
  deliveredIn,
  git,
  hostVerify,
  loadModel,
  loadProjectConfig,
  makeProject,
  resolveVerification,
} from './helpers/host-project.mjs'

/** The five gate observables, in the order `requiredObservables` returns them. */
const CORE = ['build', 'clean_boot', 'persistence_migration', 'regression_spine', 'slice_acceptance']

/** A model is only read for its Contract, its declared backend and its record's gates. */
const modelRequiringDeployment = { contract: { deployment: { required_observables: ['production_deployment'] } } }
const modelNoDeployment = { contract: {} }
const modelRequiringIsolation = { contract: { deployment: { required_observables: ['runtime_isolation'] } } }
const trustedCiModel = (contract) => ({ contract, cfg: { verification: { backend: 'trusted_ci' } } })

function gateResults(overrides = {}) {
  return EVIDENCE_GATES.map((gate) => ({ gate, outcome: 'passed', exit_code: 0, reason: '', undeclared: false, exclusion: null, ...(overrides[gate] || {}) }))
}

function hostRecord({ observed = false } = {}) {
  return {
    evidence_id: 'host:independent-verifier:unit',
    issuer: { identity: 'host:independent-verifier' },
    environment: {
      kind: 'host_independent',
      backend: 'host_executed',
      observed: { deployment: observed, runtime_isolation: false, container: false },
      not_observed: ['a packaged deployment'],
      config_fingerprint: 'host:unit',
    },
    execution: { result: 'PASS', gate_results: gateResults() },
    scope: { slice_id: 'S1', required_case_ids: ['A-1'] },
  }
}

function ciRecord({ bound = true, trust = {} } = {}) {
  return {
    evidence_id: 'ci:verify:1-1',
    issuer: { identity: 'ci:verify' },
    trust,
    environment: {
      kind: 'production_like_ci',
      image_digest: `sha256:${'b'.repeat(64)}`,
      deployed_image_digest: bound ? `sha256:${'b'.repeat(64)}` : null,
      deployed_code_revision: bound ? 'a'.repeat(40) : null,
      deployment_id: bound ? 'deployment-1' : null,
      config_fingerprint: 'ci-fingerprint',
      fixture_revision: 'a'.repeat(40),
    },
    execution: { result: 'PASS', gate_results: gateResults() },
    scope: { slice_id: 'S1', required_case_ids: ['A-1'] },
  }
}

/* ------------------------------------------------------------- the data model */

test('the required set comes from the Contract, so a Host-only Contract stays Host-completable', () => {
  assert.deepEqual(requiredObservables(modelNoDeployment, { gates: [{ gate: 'build' }, { gate: 'slice_acceptance' }] }), ['build', 'slice_acceptance'])
  // A deployment gate alone is not a requirement: the Contract decides.
  const withDeploymentGate = requiredObservables(modelNoDeployment, { gates: [{ gate: 'deployment', local: 'skip' }] })
  assert.deepEqual(withDeploymentGate, [])
  const planned = assessPlannedCapability(modelNoDeployment, { backend: 'host_executed', gates: [{ gate: 'build' }, { gate: 'deployment' }] })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  assert.deepEqual(planned.missing_observables, [])
  // The core five the frozen verifier really claims are required and host-observable.
  const full = assessPlannedCapability(modelNoDeployment, { backend: 'host_executed', gates: EVIDENCE_GATES.map((gate) => ({ gate })) })
  assert.deepEqual(full.required_observables, CORE)
  assert.equal(full.ok, true)
})

test('naming a real environment is not a requirement to observe one', () => {
  // This is the compatibility rule, and it is load-bearing: the shipped Contract
  // template names `staging`/`production_like_container` while its own completion
  // policy states that the host backend is the default. If environment names created
  // the requirement, no template-derived project could ever use the default path.
  const environmentOnly = { contract: { deployment: { slice_environment: 'production_like_container', bootstrap_environment: 'staging', mvp_ready_environment: 'staging' } } }
  assert.deepEqual(requiredObservables(environmentOnly, { gates: [{ gate: 'build' }] }), ['build'])
  const planned = assessPlannedCapability(environmentOnly, { backend: 'host_executed', gates: [{ gate: 'build' }, { gate: 'slice_acceptance' }] })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  assert.deepEqual(planned.required_observables, ['build', 'slice_acceptance'])

  // A platform-observable release prerequisite is a Contract statement that the
  // platform must observe something — but it can only be required of a project that
  // actually declares the platform-observed backend. The declared policy, not the
  // environment names, decides.
  const prereq = { contract: { deployment: { slice_environment: 'staging', release_prerequisites: [{ id: 'p', verification: 'required_check_runs_on_candidate' }] } } }
  assert.equal(assessPlannedCapability(prereq, { backend: 'host_executed', gates: [] }).ok, true)
  assert.equal(assessPlannedCapability(trustedCiModel(prereq.contract), { backend: 'host_executed', gates: [] }).ok, false)
  assert.equal(assessPlannedCapability(trustedCiModel(prereq.contract), { backend: 'trusted_ci', gates: [] }).ok, true)
})

test('a Contract that demands a deployment observation is not completable by the host backend', () => {
  const planned = assessPlannedCapability(modelRequiringDeployment, { backend: 'host_executed', gates: [{ gate: 'build' }] })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, BACKEND_CAPABILITY_INSUFFICIENT)
  assert.deepEqual(planned.missing_observables, [OBSERVABLE.PRODUCTION_DEPLOYMENT])
  assert.equal(planned.backend, 'host_executed')
  // The same Contract on the capable backend is fine.
  assert.equal(assessPlannedCapability(modelRequiringDeployment, { backend: 'trusted_ci', gates: [{ gate: 'build' }] }).ok, true)
})

test('a record only keeps a capability its backend has and its own statements support', () => {
  const bound = assessBackendCapability(modelRequiringDeployment, ciRecord({ bound: true }))
  assert.equal(bound.ok, true, JSON.stringify(bound))
  assert.ok(bound.backend_capabilities.includes(OBSERVABLE.PRODUCTION_DEPLOYMENT))

  const unbound = assessBackendCapability(modelRequiringDeployment, ciRecord({ bound: false }))
  assert.equal(unbound.ok, false)
  assert.deepEqual(unbound.missing_observables, [OBSERVABLE.PRODUCTION_DEPLOYMENT])
  assert.equal(unbound.backend, 'trusted_ci')

  // A Host record cannot claim its way into a capability the backend does not have.
  const claiming = assessBackendCapability(modelRequiringDeployment, hostRecord({ observed: true }))
  assert.equal(claiming.ok, false)
  assert.deepEqual(claiming.missing_observables, [OBSERVABLE.PRODUCTION_DEPLOYMENT])
  assert.equal(observedCapabilities(hostRecord({ observed: true })).has(OBSERVABLE.PRODUCTION_DEPLOYMENT), false)

  // A Required observable neither backend can observe blocks on both, whatever the
  // record claims about itself.
  for (const record of [hostRecord(), ciRecord({ trust: { runtime_isolation_verified: true } })]) {
    const verdict = assessBackendCapability(modelRequiringIsolation, record)
    assert.equal(verdict.ok, false, JSON.stringify(verdict))
    assert.deepEqual(verdict.missing_observables, [OBSERVABLE.RUNTIME_ISOLATION])
  }
})

test('the failed verdict is machine-readable, not just a sentence', () => {
  const verdict = assessBackendCapability(modelRequiringDeployment, hostRecord())
  const message = capabilityMessage(verdict)
  assert.match(message, /^BACKEND_CAPABILITY_INSUFFICIENT: backend host_executed/)
  assert.match(message, /required observables \[production_deployment\]/)
  assert.match(message, /observable: \[build, clean_boot/)
})

/* ----------------------------------------------------------------- integration */

test('a Host-only Contract is still Delivered by the host backend (no forced backend switch)', () => {
  const { root } = makeProject()
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.capability.required_observables, CORE)
    assert.deepEqual(report.capability.missing_observables, [])
    assert.equal(report.capability.backend, 'host_executed')
    const { verdict } = deliveredIn(root)
    assert.equal(verdict.delivered, true, JSON.stringify(verdict.blocking))
    assert.equal(verdict.capability.ok, true)
  } finally {
    cleanup(root)
  }
})

test('a Host backend facing a Contract that requires a deployment observation is refused before any gate runs', () => {
  const { root } = makeProject({ contract: CONTRACT_REQUIRING_DEPLOYMENT })
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.match(result.stderr, /BACKEND_CAPABILITY_INSUFFICIENT/)
    assert.match(result.stderr, /production_deployment/)
    assert.match(result.stderr, /host_executed/)
    assert.equal(existsSync(join(root, '.agent', 'evidence')), false, 'a refused backend must not leave a record behind')

    const { verdict } = deliveredIn(root)
    assert.equal(verdict.delivered, false)
    // No record exists at all, so the precise reason is the missing execution; the
    // capability verdict is not reported for a run that never happened.
    assert.equal(verdict.capability, null)
    assert.ok(verdict.blocking_entries.some((entry) => entry.code === 'NO_FRESH_INDEPENDENT_EXECUTION'))
    assert.equal(assessPlannedCapability(loadModel(root), { backend: 'host_executed', gates: [] }).missing_observables.includes(OBSERVABLE.PRODUCTION_DEPLOYMENT), true)
  } finally {
    cleanup(root)
  }
})

test('a backend limitation becomes a block on the verdict, never a note that still reads Delivered', () => {
  const { root } = makeProject()
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    const record = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    const model = loadModel(root)
    const verification = resolveVerification(loadProjectConfig(root))
    const candidate = git(root, ['rev-parse', 'HEAD']).trim()
    const assess = (contract) => assessDelivery({ ...model, contract }, { candidate, acceptedIssuers: verification.acceptedIssuers, verification })

    // The same record under the frozen Contract: Delivered.
    const ok = assess(model.contract)
    assert.equal(ok.delivered, true, JSON.stringify(ok.blocking))
    // The same record under a Contract that explicitly requires the deployment to be
    // observed: NOT_DELIVERED, with the observable named, and the host limitations still
    // listed (so a reader can see the difference between a limitation and a block).
    const blocked = assess({ ...model.contract, deployment: { slice_environment: 'staging', release_target: 'x', required_observables: ['production_deployment'] } })
    assert.equal(blocked.delivered, false)
    const entry = blocked.blocking_entries.find((item) => item.code === BACKEND_CAPABILITY_INSUFFICIENT)
    assert.ok(entry, JSON.stringify(blocked.blocking_entries))
    assert.equal(entry.backend, 'host_executed')
    assert.deepEqual(entry.missing_observables, [OBSERVABLE.PRODUCTION_DEPLOYMENT])
    assert.ok(blocked.limitations.some((line) => /no packaged deployment or runtime isolation/.test(line)))
    assert.equal(record.environment.observed.deployment, false)
    // An observable that this Contract does not require must not block Delivered: not by
    // an explicit empty list, and not by merely naming a real environment.
    const optional = assess({ ...model.contract, deployment: { slice_environment: 'staging', required_observables: [] } })
    assert.equal(optional.delivered, true, JSON.stringify(optional.blocking))
    const environmentOnly = assess({ ...model.contract, deployment: { slice_environment: 'production_like_container', mvp_ready_environment: 'staging' } })
    assert.equal(environmentOnly.delivered, true, JSON.stringify(environmentOnly.blocking))
  } finally {
    cleanup(root)
  }
})
