/**
 * Backend capability completeness — the missing half of "Evidence covers the
 * Contract's required observability".
 *
 * The problem this module exists to make impossible:
 *
 *   A verification backend can only observe some facts. `host_executed` really
 *   builds, boots, migrates, runs the frozen acceptance and re-runs the accumulated
 *   Spine — it cannot see a packaged production deployment, runtime isolation, a
 *   container namespace or a real external provider. That limitation is not the
 *   defect. The defect is producing `Delivered = true` for a Contract that requires
 *   one of those facts, because "this backend never looked" silently became "this
 *   passed".
 *
 * So the verdict is now derived from two explicit sets:
 *
 *   required_observables          what this Contract demands be *observed*
 *   backend_observable_capabilities   what the backend that produced the record can
 *                                     actually observe
 *
 * and `Delivered` requires `required_observables ⊆ backend_observable_capabilities`
 * with a valid record behind it. Otherwise the verdict is NOT_DELIVERED with the
 * stable machine-readable reason `BACKEND_CAPABILITY_INSUFFICIENT`, naming the
 * backend and the `missing_observables`.
 *
 * Two rules keep this from becoming "everyone must use the strongest backend":
 *
 *   1. The required set comes from the Contract (and the gates the frozen verifier
 *      actually declared), never from the backend. A Contract that only asks for
 *      build / boot / acceptance / regression is completable by the host backend.
 *   2. `not_observed`, `unsupported`, `unknown` and `warning` are never a pass for a
 *      Required observable. A Required observable with no capability is a block, not
 *      a limitation.
 */

import { evidenceBackendOf } from './evidence.mjs'

/** The facts a verification backend can be asked to observe. */
export const OBSERVABLE = Object.freeze({
  BUILD: 'build',
  CLEAN_BOOT: 'clean_boot',
  PERSISTENCE_MIGRATION: 'persistence_migration',
  SLICE_ACCEPTANCE: 'slice_acceptance',
  REGRESSION_SPINE: 'regression_spine',
  PRODUCTION_DEPLOYMENT: 'production_deployment',
  RUNTIME_ISOLATION: 'runtime_isolation',
  CONTAINER_ISOLATION: 'container_isolation',
  EXTERNAL_PROVIDER: 'external_provider',
})

export const OBSERVABLE_VALUES = Object.freeze(Object.values(OBSERVABLE))

/** The gate that produces each observable the frozen verifier can declare. */
export const OBSERVABLE_FOR_GATE = Object.freeze({
  build: OBSERVABLE.BUILD,
  clean_boot: OBSERVABLE.CLEAN_BOOT,
  persistence_migration: OBSERVABLE.PERSISTENCE_MIGRATION,
  slice_acceptance: OBSERVABLE.SLICE_ACCEPTANCE,
  regression_spine: OBSERVABLE.REGRESSION_SPINE,
})

/**
 * What each backend can observe, before any per-record statement.
 *
 * `production_deployment` is deliberately absent from the host row: a host run
 * executes the candidate in place, so it has no packaged artifact installed
 * anywhere to observe. `runtime_isolation`, `container_isolation` and
 * `external_provider` are absent from both rows: neither backend has a real
 * executor for them today, and claiming otherwise is exactly the false positive
 * this model removes.
 */
export const BACKEND_OBSERVABLE_CAPABILITIES = Object.freeze({
  host_executed: Object.freeze([
    OBSERVABLE.BUILD,
    OBSERVABLE.CLEAN_BOOT,
    OBSERVABLE.PERSISTENCE_MIGRATION,
    OBSERVABLE.SLICE_ACCEPTANCE,
    OBSERVABLE.REGRESSION_SPINE,
  ]),
  trusted_ci: Object.freeze([
    OBSERVABLE.BUILD,
    OBSERVABLE.CLEAN_BOOT,
    OBSERVABLE.PERSISTENCE_MIGRATION,
    OBSERVABLE.SLICE_ACCEPTANCE,
    OBSERVABLE.REGRESSION_SPINE,
    OBSERVABLE.PRODUCTION_DEPLOYMENT,
  ]),
})

/** The stable machine-readable blocking reason. */
export const BACKEND_CAPABILITY_INSUFFICIENT = 'BACKEND_CAPABILITY_INSUFFICIENT'

/**
 * Release-prerequisite checks that only the platform can answer.
 *
 * A Contract that lists one of these has stated a platform-observable obligation. Whether
 * that obligation is *Required for Delivered* still depends on the project's declared
 * verification policy: a platform check can only ever be satisfied by the platform, so a
 * project that declares the host backend is telling the system not to demand it (this is
 * exactly the rule `templates/CONTRACT.yaml` states beside its `deployment` block).
 */
export const PLATFORM_OBSERVED_PREREQUISITES = Object.freeze([
  'required_check_runs_on_candidate',
  'baseline_ref_readable',
  'verification_workflow_active',
])

const text = (value) => typeof value === 'string' && value.trim() !== ''

/** The project's declared verification policy, if it declared one. */
function declaredBackendOf(model, explicit) {
  if (explicit) return String(explicit)
  const declared = model?.cfg?.verification?.backend
  return text(declared) ? String(declared) : null
}

/**
 * Whether this Contract demands that a real deployment be *observed*.
 *
 * The requirement has to be **explicit**, in one of two forms the existing schema already
 * supports:
 *
 *   1. `deployment.required_observables` names `production_deployment`; or
 *   2. the Contract lists a platform-observable `release_prerequisites` entry **and** the
 *      project declares `verification.backend: trusted_ci` (or `both`).
 *
 * Environment names alone (`staging`, `production_like_container`, …) deliberately do NOT
 * create the requirement. Two reasons, both load-bearing:
 *
 *   - the shipped Contract template declares a staging environment and platform release
 *     prerequisites while its own `completion_policy` comment states that only
 *     `verification.backend: trusted_ci` moves execution to the platform. Deriving the
 *     requirement from the environment names would make the documented default
 *     (host-executed) path unrunnable for every template-derived project;
 *   - a `deployment` gate in the frozen verifier is a statement about *what the verifier
 *     runs*, never a statement that a deployment must be observed. If it were, no project
 *     could ever be completed by the host backend, which is the opposite of what this
 *     model is for.
 *
 * A Contract that really needs a deployment observed says so — and then a backend that
 * cannot observe one must not report Delivered.
 */
export function contractRequiresDeploymentObservation(contract, { declaredBackend = null, model = null } = {}) {
  const deployment = contract?.deployment
  if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)) return false
  const declared = Array.isArray(deployment.required_observables) ? deployment.required_observables.map((v) => String(v)) : []
  if (declared.includes(OBSERVABLE.PRODUCTION_DEPLOYMENT)) return true
  const prerequisites = Array.isArray(deployment.release_prerequisites) ? deployment.release_prerequisites : []
  const platformObserved = prerequisites.some(
    (item) => item && typeof item === 'object' && PLATFORM_OBSERVED_PREREQUISITES.includes(String(item.verification || '')),
  )
  if (!platformObserved) return false
  const backend = declaredBackendOf(model, declaredBackend)
  return backend === 'trusted_ci' || backend === 'both'
}

/**
 * The observables the *declared verification surface* claims.
 *
 * Accepts either the frozen verifier configuration's `gates` list (`{gate, excluded}`)
 * or an evidence record's `execution.gate_results` (`{gate, outcome, exclusion}`).
 * A gate the frozen configuration excluded is not an observation obligation; a gate
 * this backend could not run is still one if the Contract asks for it (handled by the
 * required-set derivation below).
 */
export function gateObservables(gates = []) {
  const out = new Set()
  for (const entry of Array.isArray(gates) ? gates : []) {
    const name = typeof entry === 'string' ? entry : entry?.gate
    if (!name) continue
    if (typeof entry === 'object' && entry !== null) {
      if (entry.excluded === true) continue
      if (entry.undeclared === true) continue
      if (entry.outcome === 'not_applicable' && entry.exclusion === 'declared') continue
    }
    const observable = OBSERVABLE_FOR_GATE[name]
    if (observable) out.add(observable)
  }
  return out
}

/**
 * `required_observables` for one Contract.
 *
 * Three additive sources, and no way to remove an entry from the first two:
 *   1. the observable behind every gate the frozen verification surface really claims;
 *   2. `production_deployment` when the Contract explicitly demands a deployment
 *      observation (see `contractRequiresDeploymentObservation`);
 *   3. an explicit `deployment.required_observables` list, which may only add.
 */
export function requiredObservables(model, { gates = [], declaredBackend = null } = {}) {
  const out = gateObservables(gates)
  if (contractRequiresDeploymentObservation(model?.contract, { declaredBackend, model })) out.add(OBSERVABLE.PRODUCTION_DEPLOYMENT)
  const declared = model?.contract?.deployment?.required_observables
  for (const item of Array.isArray(declared) ? declared : []) {
    if (text(item)) out.add(String(item).trim())
  }
  return [...out].sort()
}

/**
 * What the backend behind one record can actually observe.
 *
 * The static per-backend row is narrowed by what the record itself states it
 * observed. A backend's own claim can therefore never *add* a capability its row does
 * not have (the host row never contains `production_deployment`), and a record that
 * admits it observed nothing loses the capability rather than keeping it by default.
 *
 * Which *row* applies is read from the record's declared `environment.kind`. That is the
 * same property the rest of this reader already has: a local reader cannot authenticate
 * where a record came from, and `classifyEvidence` only checks that its issuer identity
 * is one this project accepts (the CI consumer checks the authenticated platform
 * receipt). A hand-written record that claims the CI environment therefore still needs a
 * configured, accepted issuer to be selected at all — and a project that never declared
 * the trusted-CI backend does not accept that issuer. This reader reports what a record
 * *says* it observed and never upgrades a claim into authentication; see
 * docs/AUTO_DELIVERY.md "限制".
 */
export function observedCapabilities(record) {
  const backend = evidenceBackendOf(record)
  const out = new Set(BACKEND_OBSERVABLE_CAPABILITIES[backend] || [])
  const environment = record?.environment || {}
  if (backend === 'host_executed') {
    const observed = environment.observed && typeof environment.observed === 'object' ? environment.observed : {}
    if (observed.deployment !== true) out.delete(OBSERVABLE.PRODUCTION_DEPLOYMENT)
    if (observed.runtime_isolation !== true) out.delete(OBSERVABLE.RUNTIME_ISOLATION)
    if (observed.container !== true) out.delete(OBSERVABLE.CONTAINER_ISOLATION)
  } else {
    // A trusted-CI record observes a deployment only when it actually binds one.
    const bound = text(environment.deployment_id) && text(environment.deployed_code_revision) && text(environment.image_digest)
    if (!bound) out.delete(OBSERVABLE.PRODUCTION_DEPLOYMENT)
    // Self-declared trust flags are claims, not authentication: a record only keeps
    // these capabilities by stating them positively, and the CI consumer is what
    // turns a claim into a fact.
    if (record?.trust?.runtime_isolation_verified !== true) out.delete(OBSERVABLE.RUNTIME_ISOLATION)
    if (record?.trust?.container_isolation_verified !== true) out.delete(OBSERVABLE.CONTAINER_ISOLATION)
  }
  return out
}

function verdict({ backend, required, capabilities }) {
  const missing = required.filter((observable) => !capabilities.includes(observable))
  return {
    ok: missing.length === 0,
    code: missing.length === 0 ? null : BACKEND_CAPABILITY_INSUFFICIENT,
    backend: backend ?? null,
    required_observables: required,
    backend_capabilities: capabilities,
    missing_observables: missing,
  }
}

/**
 * Completeness verdict for the backend that produced one record.
 *
 * This is the check that must hold before `Delivered` can be considered at all.
 */
export function assessBackendCapability(model, record) {
  const required = requiredObservables(model, { gates: record?.execution?.gate_results || [] })
  const capabilities = [...observedCapabilities(record)].sort()
  return verdict({ backend: record ? evidenceBackendOf(record) : null, required, capabilities })
}

/**
 * Completeness verdict for a backend *before* it runs, from the frozen verifier
 * configuration. Used to refuse a run whose backend structurally cannot observe
 * what the Contract requires, instead of burning an attempt to learn that.
 */
export function assessPlannedCapability(model, { backend, gates = [] } = {}) {
  const required = requiredObservables(model, { gates })
  const capabilities = [...(BACKEND_OBSERVABLE_CAPABILITIES[backend] || [])].sort()
  return verdict({ backend: backend ?? null, required, capabilities })
}

/** The one-line, machine-readable statement of a failed completeness verdict. */
export function capabilityMessage(result) {
  return (
    `${BACKEND_CAPABILITY_INSUFFICIENT}: backend ${result.backend || '(none)'} cannot observe ` +
    `required observables [${result.missing_observables.join(', ')}] ` +
    `(required: [${result.required_observables.join(', ')}]; observable: [${result.backend_capabilities.join(', ')}])`
  )
}
