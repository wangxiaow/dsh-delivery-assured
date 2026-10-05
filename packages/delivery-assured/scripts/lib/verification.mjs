/**
 * Verification backends — who actually executes the frozen acceptance, and how a
 * record from that execution is recognised as proof.
 *
 * Two backends exist and both are real executions. They differ in how much of the
 * surrounding platform they can observe, never in whether the Required cases ran:
 *
 *   - `host_executed` (the default): the DSH host runs the frozen gates and the
 *     frozen Required acceptance on the exact candidate revision, under a run token
 *     it generates itself, and retains the raw logs next to the record. It observes
 *     build, clean boot, persistence/migration, Slice acceptance and the regression
 *     Spine for real; a packaged-deployment/container observation is *not* available
 *     on this backend and is reported as an explicit `not_applicable` limitation
 *     instead of being claimed.
 *   - `trusted_ci`: the protected GitHub workflow with authority refs, a push token
 *     and a promoted Baseline. It adds platform-observed provenance and a deployment
 *     identity, and it stays available as the high-assurance backend. It is no
 *     longer a precondition for an ordinary project to finish.
 *
 * Nothing here weakens the acceptance rule. Whichever backend runs, every Required
 * case must have exactly one real PASS in the record, no case may be skipped, and a
 * record whose bytes were not produced by that backend's execution path is not
 * proof. `acceptedIssuers` says which issuer identities this project treats as
 * proof; the caller never invents one.
 */

/** Local, dependency-free placeholder test: this module must not import model.mjs. */
const text = (value) =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  !/^<.*>$/.test(value.trim()) &&
  !/\b(draft|unknown|TODO|TBD|FIXME)\b/i.test(value)

export const VERIFICATION_BACKEND = Object.freeze({
  /** The DSH host executes the frozen verifier and the frozen acceptance itself. */
  HOST: 'host_executed',
  /** The protected CI workflow executes them with platform-observed provenance. */
  TRUSTED_CI: 'trusted_ci',
})

/** Order of assurance; a higher rank may substitute for a lower one, never the reverse. */
export const BACKEND_ASSURANCE = Object.freeze({
  [VERIFICATION_BACKEND.HOST]: 1,
  [VERIFICATION_BACKEND.TRUSTED_CI]: 2,
})

export const BACKEND_VALUES = Object.freeze([VERIFICATION_BACKEND.HOST, VERIFICATION_BACKEND.TRUSTED_CI])

/** The issuer identity a host-executed run writes. */
export const HOST_VERIFIER_ISSUER = 'host:independent-verifier'

/** The environment kind a host-executed record carries. */
export const HOST_ENVIRONMENT_KIND = 'host_independent'

/** Where the frozen standard's digests are anchored, relative to the project root. */
export const DEFAULT_FREEZE_PATH = '.agent/standards/FREEZE.json'

/**
 * Resolve the project's verification policy.
 *
 * An undeclared policy is the new default: an ordinary project is completed by the
 * host actually executing its frozen verifier. A project that names `trusted_ci`
 * (for example the operation pack's own repository, whose frozen Contract states
 * that only the trusted CI job produces Evidence) keeps exactly the old rule, and an
 * unknown value resolves to `trusted_ci` so a typo can never widen a project into the
 * weaker backend.
 */
export function resolveVerification(cfg = {}) {
  const declaredRaw = cfg.verification && typeof cfg.verification === 'object' ? cfg.verification : {}
  const declaredValue = typeof declaredRaw.backend === 'string' ? declaredRaw.backend.trim() : null
  const problems = []
  const declared = declaredValue !== null && declaredValue !== ''
  const allowed = [...BACKEND_VALUES, 'both']
  // `both` keeps the host as the execution backend (a session cannot dispatch the
  // protected workflows itself) while accepting trusted-CI records for the same
  // candidate, because that evidence is strictly stronger.
  const backend =
    !declared || declaredValue === VERIFICATION_BACKEND.HOST || declaredValue === 'both'
      ? VERIFICATION_BACKEND.HOST
      : VERIFICATION_BACKEND.TRUSTED_CI
  if (declared && !allowed.includes(declaredValue)) {
    problems.push(
      `verification.backend ${JSON.stringify(declaredValue)} is not one of ${allowed.join(', ')}; ` +
        'the stricter trusted_ci rule applies until it is corrected',
    )
  }

  const trustedIssuer = text(cfg.ci?.trusted_issuer) ? cfg.ci.trusted_issuer : null
  const hostIssuer = text(declaredRaw.host_issuer) ? declaredRaw.host_issuer : HOST_VERIFIER_ISSUER
  const freezePath = text(declaredRaw.freeze) ? declaredRaw.freeze : DEFAULT_FREEZE_PATH

  // Which issuer identities count as proof for this project. A host-default project
  // also accepts a trusted-CI record: it is strictly stronger evidence about the same
  // candidate. A trusted_ci project accepts only the trusted issuer, so the very
  // project that needs platform provenance cannot be satisfied by a local run.
  const acceptedIssuers = []
  if (backend === VERIFICATION_BACKEND.TRUSTED_CI) {
    if (trustedIssuer) acceptedIssuers.push(trustedIssuer)
  } else {
    acceptedIssuers.push(hostIssuer)
    if (trustedIssuer && trustedIssuer !== hostIssuer) acceptedIssuers.push(trustedIssuer)
  }

  return {
    backend,
    declared,
    declared_value: declaredValue,
    trustedIssuer,
    hostIssuer,
    acceptedIssuers,
    freezePath,
    /** Reading the durable state ref is a precondition only for the trusted-CI backend. */
    requiresDurableState: backend === VERIFICATION_BACKEND.TRUSTED_CI,
    trustedCiConfigured: trustedIssuer !== null,
    problems,
  }
}

/** The assurance rank of one accepted issuer identity for this project. */
export function issuerAssurance(identity, resolved) {
  if (resolved.trustedIssuer && identity === resolved.trustedIssuer) return BACKEND_ASSURANCE[VERIFICATION_BACKEND.TRUSTED_CI]
  if (identity === resolved.hostIssuer) return BACKEND_ASSURANCE[VERIFICATION_BACKEND.HOST]
  return 0
}

/** Human-readable backend label for a report. */
export function backendLabel(backend) {
  return backend === VERIFICATION_BACKEND.TRUSTED_CI ? 'trusted CI (protected workflow)' : 'host-executed independent verifier'
}
