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
  DISPOSITIONS,
} from './common.mjs'
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
export { STATUS, BLOCKING_STATUSES, blockingForView, collectCriticalViolations, coverageRows, proveCase } from './coverage-core.mjs'
