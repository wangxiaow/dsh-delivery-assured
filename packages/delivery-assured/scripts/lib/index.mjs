/**
 * Public core surface of the Delivery-Assured operation pack.
 *
 * The `delivery` CLI and the five scripts both import from here, so the facts a
 * human sees on the command line and the facts CI verifies can never drift into
 * two implementations.
 */

export { parseYaml, YamlError } from './yaml.mjs'
export {
  EXIT,
  InputError,
  abs,
  exists,
  fileDigest,
  findProjectRoot,
  git,
  gitAvailable,
  gitDirty,
  gitRemoteUrl,
  gitRevision,
  listFiles,
  loadAcceptance,
  loadAttempts,
  loadBaselines,
  loadChecklists,
  loadContract,
  loadEvidence,
  loadProjectConfig,
  loadReviews,
  loadSlices,
  loadSpine,
  loadState,
  obligationIndex,
  readJson,
  readText,
  readYaml,
  rel,
  requiredObligations,
  criticalRules,
  sha256,
  standardBindings,
  treeDigest,
  remoteRef,
  worktreeRevision,
  DISPOSITIONS,
} from './common.mjs'
export { commonGitDir, findGitDir, localRevision, parseGitConfig, readPackedRefs, remoteUrl as configuredRemoteUrl, resolveGitDir, resolveRef } from './worktree-git.mjs'
export { createGhClient, parseGitHubRemote, resolveGhBin, whichCommand } from './gh-api.mjs'
export {
  CASE_PASS,
  STALE_REASONS,
  SLOTS_ALLOWED_EMPTY,
  caseOutcomeFromEvidence,
  checkAcceptanceManifest,
  checkChecklistDispositions,
  checkContractStructure,
  checkCriticalDerivation,
  checkDeploymentDecisions,
  checkDuplicateIds,
  checkSliceIntegrity,
  checkUnknowns,
  classifyEvidence,
  describePlaceholder,
  isPlaceholder,
  loadModel,
  scanDriverForAssertions,
  specDiffAgainstProtected,
} from './model.mjs'
export { STATUS, BLOCKING_STATUSES, blockingForView, collectCriticalViolations, coverageRows, proveCase, classifyManualReview } from './coverage-core.mjs'
export { assessDelivery, assessAutomatedReviews, independentVerification, resolveCompletionPolicy } from './completion.mjs'
export {
  BACKEND_VALUES,
  DEFAULT_FREEZE_PATH,
  HOST_ENVIRONMENT_KIND,
  HOST_VERIFIER_ISSUER,
  VERIFICATION_BACKEND,
  backendLabel,
  issuerAssurance,
  resolveVerification,
} from './verification.mjs'
export { createFreeze, currentFileDigests, freezeFiles, freezePath, readFreeze, verifyFreeze } from './standard-freeze.mjs'
export {
  BACKEND_CAPABILITY_INSUFFICIENT,
  BACKEND_OBSERVABLE_CAPABILITIES,
  OBSERVABLE,
  OBSERVABLE_VALUES,
  assessBackendCapability,
  assessPlannedCapability,
  capabilityMessage,
  contractRequiresDeploymentObservation,
  observedCapabilities,
  requiredObservables,
} from './capability.mjs'
export { SAFE_BASE_ENV_KEYS, RUNNER_SIGNAL_KEYS, buildBaseEnv, fixtureEnv, gateEnv, isInheritedByDefault, runnerSignals } from './env.mjs'
export {
  TCB_FILES,
  TCB_VERSION,
  currentTcbDigests,
  tcbChangeAuthorization,
  tcbDigest,
  tcbFiles,
  tcbRecord,
  tcbRepoRoot,
  verifyTcb,
} from './tcb.mjs'
export { STATE_REF, STATE_SCOPES, STATE_TRANSPORT, fetchDurableState, inStateScope, readRemoteRef, resolveStateRepo } from './durable-state.mjs'
export { STATE_AUTHORITY, STATE_SOURCE, budgetSignature, openStateView, stateAuthority } from './state-view.mjs'
