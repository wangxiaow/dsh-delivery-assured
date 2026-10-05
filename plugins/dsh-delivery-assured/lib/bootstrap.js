/**
 * New-project bootstrap lifecycle.
 *
 * A delivery project does not start with a Contract: the project metadata, the verifier
 * configuration and the frozen acceptance have to exist before the Contract can reference
 * them. The protected-path guard therefore needs one explicit, ordered lifecycle instead of
 * "the Contract is missing, so switch protection off":
 *
 *   1. `project_metadata`      `.agent/project.yaml`  (paths, refs, environment, budget)
 *   2. `verifier_environment`  `ci/verifier.yaml`     (+ the repo material CI needs)
 *   3. `acceptance_spec`       `tests/acceptance/spec`
 *   4. `contract`              `.agent/CONTRACT.yaml`  ← writing it freezes the standard
 *
 * Rules this module defines and nothing else may restate:
 *
 *   - The lifecycle is derived from what exists on disk, never from a self-declared flag,
 *     so a session cannot "declare" itself unbootstrapped.
 *   - A project that already carries a Contract is `protected`, full stop. Its bootstrap
 *     window is closed permanently, even if an earlier artifact is missing — otherwise
 *     "re-create the project metadata" would be a rewrite of the standard that decides
 *     which paths are protected in the first place.
 *   - While `bootstrapping`, only the steps up to and including the current one are
 *     writable, and only inside their own targets. Evidence, the attempt ledger, the
 *     recordings, the baseline metadata and the authority refs are never writable.
 *   - Creating the next artifact closes the previous step: the order is the point, because
 *     the verifier is interpreted through the project config and the frozen acceptance is
 *     what the Contract is allowed to reference.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Paths the lifecycle revolves around. Overridable by the project's own `paths:` block. */
export const BOOTSTRAP_PATHS = Object.freeze({
  project: '.agent/project.yaml',
  verifier: 'ci/verifier.yaml',
  acceptanceSpec: 'tests/acceptance/spec',
  acceptanceManifest: 'tests/acceptance/spec/manifest.yaml',
  spine: 'tests/spine',
  slices: '.agent/slices',
  contract: '.agent/CONTRACT.yaml',
})

/**
 * The ordered lifecycle. `targets` are project-relative; `repoTargets` are relative to the
 * repository root and only apply while repository material is protected at all.
 */
export const BOOTSTRAP_STEPS = Object.freeze([
  Object.freeze({
    id: 'project_metadata',
    label: '项目元数据',
    requirement:
      '创建 .agent/project.yaml：路径、baseline 引用、环境声明（slice/bootstrap/mvp）与尝试预算。' +
      'verifier 与冻结验收都通过它解释，所以它必须最先存在。',
    targets: Object.freeze([BOOTSTRAP_PATHS.project]),
    companions: Object.freeze([]),
    repoTargets: Object.freeze([]),
  }),
  Object.freeze({
    id: 'verifier_environment',
    label: 'verifier 与环境',
    requirement:
      '创建 ci/verifier.yaml：六道门的实际命令与它所声明的环境。CI 需要的仓库材料' +
      '（.github/workflows、ci/tools）同样在这一步补齐。',
    targets: Object.freeze([BOOTSTRAP_PATHS.verifier]),
    companions: Object.freeze([]),
    repoTargets: Object.freeze(['.github/workflows', 'ci/tools']),
  }),
  Object.freeze({
    id: 'acceptance_spec',
    label: '冻结验收',
    requirement:
      '创建 tests/acceptance/spec（含 manifest）与 tests/spine/manifest.yaml：行为断言与累积 Spine 的起点。' +
      'Contract 只能引用已经冻结的 case id，所以验收必须先于 Contract。',
    targets: Object.freeze([BOOTSTRAP_PATHS.acceptanceSpec]),
    companions: Object.freeze([BOOTSTRAP_PATHS.spine]),
    repoTargets: Object.freeze([]),
  }),
  Object.freeze({
    id: 'slice_declarations',
    label: '首个 Slice 声明',
    requirement:
      '创建首个 Slice 声明（.agent/slices/<id>.yaml）：它的义务、验收、依赖与尝试预算。' +
      '它必须早于 Contract：一旦 Contract 冻结，Slice 声明也进入保护，本轮的 Slice 就再也写不出来，' +
      '而 verify 与 precheck 都以一个已声明的 Slice 为输入。',
    targets: Object.freeze([BOOTSTRAP_PATHS.slices]),
    companions: Object.freeze([]),
    repoTargets: Object.freeze([]),
  }),
  Object.freeze({
    id: 'contract',
    label: 'Contract 冻结',
    requirement:
      '创建 .agent/CONTRACT.yaml：义务、Critical 规则、验收映射与完成规则。写成即冻结，' +
      '此后所有受保护标准（包括本步骤之前创建的那四个）重新对会话关闭；' +
      '写之前先让 delivery_gaps --phase contract 没有阻塞项，因为冻结后本会话不能再改它。',
    targets: Object.freeze([BOOTSTRAP_PATHS.contract]),
    companions: Object.freeze([]),
    repoTargets: Object.freeze([]),
  }),
])

/** Order as plain project-relative paths, for documentation and assertions. */
export const BOOTSTRAP_ORDER = Object.freeze(
  BOOTSTRAP_STEPS.flatMap((step) => step.targets),
)

/** Every path any bootstrap step may create, in lifecycle order. */
export const BOOTSTRAP_SCOPE = Object.freeze([
  ...new Set(BOOTSTRAP_STEPS.flatMap((step) => [...step.targets, ...step.companions])),
])

export const BOOTSTRAP_PHASE = Object.freeze({
  /** The project carries a frozen Contract (or its bootstrap never needed to run). */
  PROTECTED: 'protected',
  /** A new project is being initialized; the ordered window is open. */
  BOOTSTRAPPING: 'bootstrapping',
})

const norm = (path) => resolve(path).replace(/[\\/]+$/, '').toLowerCase()

/**
 * Minimal reader for the project's own `paths:` block — only the keys the lifecycle needs.
 * A wrong path here would silently unprotect a standard, so an unreadable file falls back
 * to the defaults rather than to "no path".
 */
export function readProjectPaths(projectRoot) {
  const file = join(projectRoot, '.agent', 'project.yaml')
  if (!existsSync(file)) return {}
  const out = {}
  let inPaths = false
  try {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.replace(/\t/g, '  ')
      if (/^paths:\s*$/.test(line)) {
        inPaths = true
        continue
      }
      if (inPaths && /^\S/.test(line)) break
      const match = inPaths ? /^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/.exec(line) : null
      if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    return {}
  }
  return out
}

function exists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** A directory counts as present only when it actually carries a file. */
function directoryHasFiles(path) {
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile() || entry.isSymbolicLink()) return true
    if (entry.isDirectory() && directoryHasFiles(join(path, entry.name))) return true
  }
  return false
}

/** Which lifecycle artifacts already exist, honouring the project's own `paths:` overrides. */
export function bootstrapPresence(projectRoot) {
  const root = resolve(projectRoot)
  const configured = readProjectPaths(root)
  const paths = {
    project: configured.project || BOOTSTRAP_PATHS.project,
    verifier: configured.verifier || BOOTSTRAP_PATHS.verifier,
    acceptanceSpec: configured.acceptanceSpec || BOOTSTRAP_PATHS.acceptanceSpec,
    acceptanceManifest: configured.acceptanceManifest || BOOTSTRAP_PATHS.acceptanceManifest,
    slices: configured.slices || BOOTSTRAP_PATHS.slices,
    contract: configured.contract || BOOTSTRAP_PATHS.contract,
  }
  const contractPresent = exists(join(root, paths.contract)) || exists(join(root, BOOTSTRAP_PATHS.contract))
  return {
    paths,
    done: {
      project_metadata: exists(join(root, paths.project)),
      verifier_environment: exists(join(root, paths.verifier)),
      acceptance_spec:
        exists(join(root, paths.acceptanceManifest)) || directoryHasFiles(join(root, paths.acceptanceSpec)),
      slice_declarations: directoryHasFiles(join(root, paths.slices)),
      // The canonical Contract path also ends the window: a project that points `paths.contract`
      // elsewhere cannot use that indirection to reopen a frozen standard.
      contract: contractPresent,
    },
  }
}

/**
 * Derive the lifecycle for one project.
 *
 * @returns `{ phase, protected, step, steps, writable, next_artifact, summary }` where
 *   `writable` is an absolute-path list the guard may allow even though those paths are
 *   protected standards (`writable = []` once the Contract is frozen).
 */
export function deriveBootstrap(projectRoot, { repoRoot = null, protectRepoMaterial = true } = {}) {
  const root = resolve(projectRoot)
  let presence
  try {
    presence = bootstrapPresence(root)
  } catch {
    return protectedLifecycle(root, [])
  }
  const { done, paths } = presence

  // The window closes when both freeze artifacts exist: the Contract *and* the first Slice
  // declaration. Slices are the input `verify` and `precheck` are given, and they become a
  // protected standard with the Contract — so bootstrap cannot be called finished while the
  // round it will verify has not been declared. A project that has both is `protected`,
  // full stop: any other missing artifact is a real defect for the standards channel, never
  // a reason to reopen a frozen standard.
  if (done.contract && done.slice_declarations) return protectedLifecycle(root, [])

  const steps = BOOTSTRAP_STEPS.map((step) => ({ ...step, status: done[step.id] ? 'done' : 'pending' }))
  const currentIndex = steps.findIndex((step) => step.status === 'pending')
  if (currentIndex === -1) return protectedLifecycle(root, [])
  steps[currentIndex].status = 'current'

  const parent = repoRoot ? resolve(repoRoot) : resolve(root, '..')
  const writable = []
  for (const step of steps.slice(0, currentIndex + 1)) {
    for (const target of [...step.targets, ...step.companions]) writable.push(join(root, target))
    if (protectRepoMaterial) for (const target of step.repoTargets) writable.push(join(parent, target))
  }
  const scope = []
  for (const step of steps) {
    for (const target of [...step.targets, ...step.companions]) scope.push(join(root, target))
    if (protectRepoMaterial) for (const target of step.repoTargets) scope.push(join(parent, target))
  }
  const relative = steps[currentIndex].targets[0]
  return {
    phase: BOOTSTRAP_PHASE.BOOTSTRAPPING,
    protected: false,
    root,
    step: steps[currentIndex].id,
    step_index: currentIndex + 1,
    step_count: steps.length,
    next_artifact: relative,
    paths,
    steps: steps.map((step) => ({
      id: step.id,
      label: step.label,
      requirement: step.requirement,
      status: step.status,
      targets: [...step.targets],
      companions: [...step.companions],
    })),
    writable,
    scope,
    summary:
      `新项目 bootstrap ${currentIndex + 1}/${steps.length}：下一步创建 ${relative}（${steps[currentIndex].label}）。` +
      `按顺序完成 ${BOOTSTRAP_ORDER.join(' → ')}；` +
      'Contract 与首个 Slice 声明都存在后本窗口永久关闭，所有受保护标准重新对会话关闭。',
  }
}

function protectedLifecycle(root, writable) {
  return {
    phase: BOOTSTRAP_PHASE.PROTECTED,
    protected: true,
    root,
    step: null,
    step_index: null,
    step_count: BOOTSTRAP_STEPS.length,
    next_artifact: null,
    paths: { ...BOOTSTRAP_PATHS },
    steps: BOOTSTRAP_STEPS.map((step) => ({
      id: step.id,
      label: step.label,
      requirement: step.requirement,
      status: 'done',
      targets: [...step.targets],
      companions: [...step.companions],
    })),
    writable,
    scope: [],
    summary: '项目已带有冻结的 Contract：bootstrap 窗口已关闭，所有受保护标准对会话只读。',
  }
}

/** Whether one absolute target sits inside any entry of the bootstrap scope. */
export function isBootstrapWritable(target, writable) {
  if (!Array.isArray(writable) || writable.length === 0) return false
  const resolved = norm(target)
  return writable.some((entry) => {
    const base = norm(entry)
    return resolved === base || resolved.startsWith(`${base}\\`) || resolved.startsWith(`${base}/`)
  })
}

/** The model-facing slice of a lifecycle, without the absolute writable list. */
export function bootstrapSummary(bootstrap) {
  if (!bootstrap) return null
  return {
    phase: bootstrap.phase,
    step: bootstrap.step,
    step_index: bootstrap.step_index,
    step_count: bootstrap.step_count,
    next_artifact: bootstrap.next_artifact,
    steps: bootstrap.steps,
    order: [...BOOTSTRAP_ORDER],
    scope: [...BOOTSTRAP_SCOPE],
    summary: bootstrap.summary,
  }
}

/** One actionable line per outstanding bootstrap action. */
export function bootstrapNextActions(bootstrap) {
  if (!bootstrap || bootstrap.phase !== BOOTSTRAP_PHASE.BOOTSTRAPPING) return []
  const current = (bootstrap.steps || []).find((step) => step.status === 'current')
  if (!current) return []
  return [`创建 ${current.targets[0]}：${current.requirement}`]
}
