// Record validation is shared by diagnostics and CI. Transport provenance is
// checked by the CI consumer; an issuer string alone is not authentication.
export const EVIDENCE_GATES = ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment']

/**
 * Gates a host-executed run must really execute. The acceptance gates are here on
 * purpose: a project cannot declare its way out of running the frozen Required cases,
 * and a runtime that never booted cannot produce a passing record.
 */
export const HOST_REQUIRED_EXECUTED_GATES = Object.freeze(['build', 'clean_boot', 'slice_acceptance', 'regression_spine'])

/** The environment kind a host-executed record carries (see lib/verification.mjs). */
export const HOST_ENVIRONMENT_KIND = 'host_independent'

const DIGEST = /^[0-9a-f]{64}$/
const REVISION = /^[0-9a-f]{40}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
const text = value => typeof value === 'string' && value.trim() !== '' && !/^(unknown|draft|none|local-)|<[^>]+>/i.test(value)

export function preferProof(previous, next) {
  if (!previous) return next
  if (Boolean(previous.current) !== Boolean(next.current)) return next.current ? next : previous
  if (next.at !== previous.at) return next.at > previous.at ? next : previous
  // Ambiguous order is fail-closed: even passing cases in an ERROR run do not
  // erase the failed build, deployment or incomplete record at the same time.
  if (Boolean(previous.fresh) !== Boolean(next.fresh)) return next.fresh ? previous : next
  if (next.outcome !== 'passed' && previous.outcome === 'passed') return next
  return previous
}

/**
 * Which execution path produced a record. Dispatch is by the record's own declared
 * environment, and each kind has its own validator: a record claiming the
 * host-independent environment can never be judged by the CI rules (which would let a
 * hand-written file borrow the deployment bindings it does not have), and the CI
 * rules themselves are unchanged.
 */
export function evidenceBackendOf(record) {
  return record?.environment?.kind === HOST_ENVIRONMENT_KIND ? 'host_executed' : 'trusted_ci'
}

/** Validate one record with the rules of the backend that claims it. */
export function validateEvidenceRecordFor(record) {
  return evidenceBackendOf(record) === 'host_executed' ? validateHostEvidenceRecord(record) : validateEvidenceRecord(record)
}

/**
 * Validate a host-executed record.
 *
 * This is not the CI validator with fields removed. The CI-only observations are
 * replaced by explicit statements that they were NOT observed, and the fields that
 * prove the acceptance really ran in this invocation are required in their place:
 *
 *   - the four executable gates (build, clean boot, Slice acceptance, regression
 *     Spine) must have really exited 0; only a gate the *frozen* verifier config
 *     declared CI-only may be `not_applicable`, with its reason;
 *   - the record must carry the run token, the retained run log digest and the
 *     harness result-file digest of this exact execution;
 *   - the frozen standard must have been verified byte-for-byte against its
 *     committed revision;
 *   - and the record must state, positively, that it did not observe a deployment or
 *     runtime isolation. A host run may never claim what it cannot see.
 */
export function validateHostEvidenceRecord(record) {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }
  const b = record?.bindings || {}
  const e = record?.environment || {}
  const x = record?.execution || {}
  const host = x.host || {}
  const standards = record?.standards || {}

  need(text(record?.evidence_id), 'missing evidence_id')
  need(text(record?.issuer?.identity), 'missing issuer identity')
  for (const key of ['code_revision', 'contract_revision', 'acceptance_revision', 'verifier_config_revision']) {
    need(REVISION.test(b[key] || ''), `missing or invalid ${key}`)
  }
  for (const key of ['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'spine_manifest_digest', 'slice_manifest_digest']) {
    need(DIGEST.test(b[key] || ''), `missing or invalid ${key}`)
  }
  for (const key of ['dependency_lock_digest', 'migration_digest']) {
    need(own(b, key) && (b[key] === null || DIGEST.test(b[key] || '')), `missing or invalid ${key}`)
  }
  need(own(b, 'parent_baseline') && (b.parent_baseline === null || text(b.parent_baseline)), 'missing parent_baseline binding')

  need(e.kind === HOST_ENVIRONMENT_KIND, `environment is not a host-executed verification (${JSON.stringify(e.kind ?? null)})`)
  need(e.backend === 'host_executed', 'environment does not name the host_executed backend')
  const observed = e.observed
  need(observed && typeof observed === 'object', 'environment.observed is missing; a host run must state what it did not observe')
  if (observed && typeof observed === 'object') {
    need(observed.deployment === false, 'a host-executed run cannot claim an observed deployment')
    need(observed.runtime_isolation === false, 'a host-executed run cannot claim observed runtime isolation')
    need(observed.container === false, 'a host-executed run cannot claim observed container isolation')
  }
  need(Array.isArray(e.not_observed) && e.not_observed.length > 0 && e.not_observed.every(text),
    'environment.not_observed must name every observation this backend could not make')
  need(text(e.config_fingerprint), 'missing config_fingerprint')

  need(host.runner === 'dsh-host-verifier', 'execution.host.runner does not name the host verifier')
  need(text(host.run_token), 'missing execution.host.run_token')
  need(DIGEST.test(host.log_digest || ''), 'missing or invalid execution.host.log_digest')
  need(DIGEST.test(host.result_file_digest || ''), 'missing or invalid execution.host.result_file_digest')
  need(text(host.node_version) && text(host.platform), 'missing execution.host node_version/platform')
  need(host.gate_exit_codes && typeof host.gate_exit_codes === 'object', 'missing execution.host.gate_exit_codes')
  need(host.candidate_clean === true, 'execution.host.candidate_clean must record that the candidate worktree was unmodified')
  need(Array.isArray(host.dirty_paths) && host.dirty_paths.length === 0, 'execution.host.dirty_paths must record that the candidate worktree was unmodified')

  need(DIGEST.test(standards.freeze_standard_id || ''), 'missing standards.freeze_standard_id')
  need(REVISION.test(standards.frozen_revision || ''), 'missing or invalid standards.frozen_revision (the frozen standard must be committed)')
  need(standards.committed_verified === true, 'the frozen standard was not verified against its committed revision')
  need(Array.isArray(standards.drift) && standards.drift.length === 0, 'the standard drifted from the frozen acceptance')

  need(text(x.ci_run_id), 'missing ci_run_id')
  need(x.result === 'PASS', 'recorded result is not PASS')
  const start = Date.parse(x.started_at)
  const finish = Date.parse(x.finished_at)
  need(Number.isFinite(start) && Number.isFinite(finish) && finish >= start, 'missing or invalid execution timestamps')
  need(x.timed_out !== true && !x.filter, 'execution was timed out or filtered')

  const ids = record?.scope?.required_case_ids
  const results = x.case_results
  need(text(record?.scope?.slice_id), 'missing slice scope')
  need(Array.isArray(ids) && ids.length > 0 && ids.every(text) && new Set(ids).size === ids.length, 'required case scope is empty or duplicated')
  need(Array.isArray(results) && results.length > 0, 'case results are missing')
  if (Array.isArray(ids) && Array.isArray(results)) {
    const resultIds = results.map(r => r?.case_id)
    need(new Set(resultIds).size === resultIds.length, 'duplicate case results')
    need(resultIds.length === ids.length && ids.every(id => resultIds.includes(id)), 'executed set differs from required scope')
    need(results.every(r => r?.outcome === 'passed'), 'a case failed, was skipped, was not run, or has an unknown outcome')
    need(Number.isInteger(x.required_cases) && x.required_cases > 0 && x.required_cases === ids.length, 'required case count does not match scope')
    need(Number.isInteger(x.executed_cases) && x.executed_cases === results.length, 'executed case count does not match results')
  }
  need(x.skipped_required_cases === 0, 'missing or nonzero skipped_required_cases')

  const gates = x.gate_results
  need(Array.isArray(gates) && gates.length === EVIDENCE_GATES.length, 'the complete six gates were not recorded')
  if (Array.isArray(gates)) {
    need(new Set(gates.map(g => g?.gate)).size === gates.length, 'duplicate gate results')
    for (const gate of EVIDENCE_GATES) {
      const g = gates.find(r => r?.gate === gate)
      need(g && g.undeclared !== true, `gate ${gate} was not declared`)
      if (!g) continue
      if (g.outcome === 'passed') {
        need(g.exit_code === 0, `gate ${gate} did not exit 0`)
      } else if (g.outcome === 'not_applicable') {
        // Only the frozen verifier config can exclude a gate, and it must say why.
        need(['declared', 'ci_only'].includes(g.exclusion) && text(g.reason),
          `gate ${gate} was skipped without a declared exclusion in the frozen verifier config`)
      } else {
        need(false, `gate ${gate} did not pass or lacks an explicit exclusion`)
      }
      if (HOST_REQUIRED_EXECUTED_GATES.includes(gate)) {
        need(g.outcome === 'passed' && g.exit_code === 0, `gate ${gate} must really execute on the host backend; it recorded ${g.outcome}`)
      }
      if (host.gate_exit_codes && own(host.gate_exit_codes, gate)) {
        need(host.gate_exit_codes[gate] === g.exit_code, `gate ${gate} exit code differs from the retained execution record`)
      }
    }
  }

  need(Array.isArray(record?.structural_notes) && !record.structural_notes.some(s => /^fail:/.test(s)), 'structural checks failed or were not recorded')
  need(Array.isArray(x.artifacts) && x.artifacts.length > 0 && x.artifacts.every(text), 'verification artifacts were not retained')
  need(text(x.run_log) && Array.isArray(x.artifacts) && x.artifacts.includes(x.run_log), 'the retained run log is not named in the artifacts')
  return problems
}
/**
 * Validate a trusted-CI record. Unchanged in substance: the platform-observed
 * deployment identity and the tested-package bindings are what make this record
 * proof on that backend.
 */
export function validateEvidenceRecord(record) {
  const problems = []
  const need = (ok, message) => { if (!ok) problems.push(message) }
  const b = record?.bindings || {}
  const e = record?.environment || {}
  const x = record?.execution || {}
  need(text(record?.evidence_id), 'missing evidence_id')
  need(text(record?.issuer?.identity), 'missing issuer identity')
  for (const key of ['code_revision', 'contract_revision', 'acceptance_revision', 'verifier_config_revision']) {
    need(REVISION.test(b[key] || ''), `missing or invalid ${key}`)
  }
  for (const key of ['contract_digest', 'acceptance_manifest_digest', 'acceptance_digest', 'verifier_config_digest', 'spine_manifest_digest', 'slice_manifest_digest']) {
    need(DIGEST.test(b[key] || ''), `missing or invalid ${key}`)
  }
  for (const key of ['dependency_lock_digest', 'migration_digest']) {
    need(own(b, key) && (b[key] === null || DIGEST.test(b[key] || '')), `missing or invalid ${key}`)
  }
  need(own(b, 'parent_baseline') && (b.parent_baseline === null || text(b.parent_baseline)), 'missing parent_baseline binding')
  need(['production_like_ci', 'staging'].includes(e.kind), 'environment is not verified CI or staging')
  need(IMAGE.test(e.image_digest || ''), 'missing or invalid image_digest')
  need(IMAGE.test(e.deployed_image_digest || '') && e.deployed_image_digest === e.image_digest, 'deployed image differs from tested image')
  need(REVISION.test(e.deployed_code_revision || '') && e.deployed_code_revision === b.code_revision, 'deployment revision differs from candidate')
  for (const key of ['deployment_id', 'config_fingerprint', 'fixture_revision']) need(text(e[key]), `missing ${key}`)
  need(text(x.ci_run_id), 'missing ci_run_id')
  need(x.result === 'PASS', 'recorded result is not PASS')
  const start = Date.parse(x.started_at)
  const finish = Date.parse(x.finished_at)
  need(Number.isFinite(start) && Number.isFinite(finish) && finish >= start, 'missing or invalid execution timestamps')
  need(x.timed_out !== true && !x.filter, 'execution was timed out or filtered')
  const ids = record?.scope?.required_case_ids
  const results = x.case_results
  need(text(record?.scope?.slice_id), 'missing slice scope')
  need(Array.isArray(ids) && ids.length > 0 && ids.every(text) && new Set(ids).size === ids.length, 'required case scope is empty or duplicated')
  need(Array.isArray(results) && results.length > 0, 'case results are missing')
  if (Array.isArray(ids) && Array.isArray(results)) {
    const resultIds = results.map(r => r?.case_id)
    need(new Set(resultIds).size === resultIds.length, 'duplicate case results')
    need(resultIds.length === ids.length && ids.every(id => resultIds.includes(id)), 'executed set differs from required scope')
    need(results.every(r => r?.outcome === 'passed'), 'a case failed, was skipped, was not run, or has an unknown outcome')
    need(Number.isInteger(x.required_cases) && x.required_cases > 0 && x.required_cases === ids.length, 'required case count does not match scope')
    need(Number.isInteger(x.executed_cases) && x.executed_cases === results.length, 'executed case count does not match results')
  }
  need(x.skipped_required_cases === 0, 'missing or nonzero skipped_required_cases')
  const gates = x.gate_results
  need(Array.isArray(gates) && gates.length === EVIDENCE_GATES.length, 'the complete six gates were not recorded')
  if (Array.isArray(gates)) {
    need(new Set(gates.map(g => g?.gate)).size === gates.length, 'duplicate gate results')
    for (const gate of EVIDENCE_GATES) {
      const g = gates.find(r => r?.gate === gate)
      need(g && g.undeclared !== true && (g.outcome === 'passed' && g.exit_code === 0 || g.outcome === 'not_applicable' && text(g.reason)), `gate ${gate} did not pass or lacks an explicit exclusion`)
    }
  }
  need(Array.isArray(record?.structural_notes) && !record.structural_notes.some(s => /^fail:/.test(s)), 'structural checks failed or were not recorded')
  need(Array.isArray(x.artifacts) && x.artifacts.length > 0 && x.artifacts.every(text), 'verification artifacts were not retained')
  return problems
}
