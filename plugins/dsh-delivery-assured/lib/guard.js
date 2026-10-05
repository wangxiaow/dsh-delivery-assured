/**
 * Protected-path and authority guard for a delivery session.
 *
 * v0.5 §12 puts the verifier, the protected standards, the Evidence and the Baseline
 * refs outside the Candidate's reach. The trusted CI job enforces that at the end,
 * but a session can still be *steered* away from the boundary while it works. The
 * locked host runtime (DSH 0.2.0-rc.2) exposes `ctx.tools.guard()`: a synchronous
 * check whose returned string denies the call, after which `guardReason()` is
 * monotonic — no later listener can turn a denial back into permission. This module
 * is that check.
 *
 * What it does and does not do:
 *   - It denies writes and edits that target protected files or directories.
 *   - It denies shell commands that move a protected ref or rewrite a protected file.
 *   - It is a *steering* control, not a security boundary: a session can still run
 *     arbitrary code that is not a registered tool call. Trust still comes from CI,
 *     which is why this guard never grants anything — it only refuses.
 *
 * Read-only tools are never blocked. The acceptance `driver/` is deliberately NOT
 * protected: it is the Candidate's own adaptation surface (v0.5 §5.2), while
 * `spec/` is the protected standard.
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { bootstrapSummary, deriveBootstrap, isBootstrapWritable, readProjectPaths } from './bootstrap.js'

/** Tools that write files, and the argument that names the target. */
export const WRITE_TOOL_PATHS = Object.freeze({
  write: ['file_path'],
  edit: ['file_path'],
  str_replace_editor: ['path', 'file_path'],
})

/** Shell tools whose command text is inspected for protected targets and refs. */
export const SHELL_TOOLS = Object.freeze(['pwsh', 'bash', 'terminal', 'shell', 'node'])

/** Paths that are always protected inside a delivery project. */
export const PROTECTED_RELATIVE = Object.freeze([
  '.agent/CONTRACT.yaml',
  '.agent/project.yaml',
  '.agent/evidence',
  '.agent/attempts.jsonl',
  // The frozen-standard anchor the host-executed verifier checks. A Candidate that could
  // re-freeze the acceptance it is judged by would make the anchor decorative.
  '.agent/standards',
  'ci/verifier.yaml',
  'ci/evidence',
  'ci/baseline',
  'ci/recording',
])

/** Repository-level material a Candidate must not rewrite (v0.5 §12). */
export const PROTECTED_REPO_RELATIVE = Object.freeze([
  '.github/workflows',
  '.github/CODEOWNERS',
  'ci/tools',
  'ci/protection',
  'packages/delivery-assured',
])

/** Refs whose movement is the Promotion job's alone. */
const AUTHORITY_REF = /refs\/heads\/(baseline|delivery-state|standards)\b/

/** Commands that write, in the shell dialects this harness uses. */
const WRITE_COMMAND = /(>>?|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|sed\s+-i|tee\b|\brm\b|\bdel\b|\bmv\b|\bcp\b|git\s+(?:checkout|restore|reset|update-ref|push))/

const norm = (path) => resolve(path).replace(/[\\/]+$/, '').toLowerCase()

/**
 * Absolute path prefixes a session must not write, derived from the project config
 * so a project that overrides `paths.*` is still protected.
 *
 * `protectRepoMaterial` covers the repository-level material v0.5 §12 keeps away
 * from a Candidate: workflows, CI tools, protection config and the operation pack.
 * A repository that is *itself* the operation pack under development must set it to
 * false, otherwise improving the pack would be refused as a Candidate edit.
 */
export function protectedRoots(projectRoot, { repoRoot = null, protectRepoMaterial = true } = {}) {
  const root = resolve(projectRoot)
  const roots = PROTECTED_RELATIVE.map((p) => join(root, p))
  // The frozen acceptance standard and the spine manifest are protected standards whether
  // or not the project's own paths block names them: the kernel says so, CI compares them
  // byte for byte, and a project that never declared them must not be the loophole.
  roots.push(join(root, 'tests', 'acceptance', 'spec'))
  roots.push(join(root, 'tests', 'spine'))
  // The frozen acceptance standard and the spine manifest come from the project's
  // own configuration; a wrong path here would silently unprotect the standard.
  const cfgPaths = readProjectPaths(root)
  for (const key of ['acceptanceSpec', 'acceptanceManifest', 'spineManifest', 'verifier', 'evidenceDir', 'attemptsLog', 'contract', 'state', 'slices']) {
    if (cfgPaths[key]) roots.push(resolve(root, cfgPaths[key]))
  }
  if (protectRepoMaterial) {
    const parent = repoRoot ? resolve(repoRoot) : resolve(root, '..')
    for (const p of PROTECTED_REPO_RELATIVE) roots.push(join(parent, p))
  }
  return [...new Set(roots.map(norm))]
}

/** Minimal reader: only the `paths:` block is needed, and only to protect it. */

/** Whether a resolved target sits inside one of the protected prefixes. */
export function isProtectedTarget(target, roots) {
  const resolved = norm(target)
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}\\`) || resolved.startsWith(`${root}/`))
}

function resolveTarget(value, cwd) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

function deny(message) {
  return `${message} [delivery-assured guard: protected by v0.5 §12; only the CI verification job produces evidence and only its Promotion job advances a Baseline]`
}

/** The denial text, plus the open bootstrap step when one is open (steering, not authority). */
function protectedMessage(what, projectRoot, target, bootstrap) {
  const base = `${what} on ${relative(projectRoot, target) || target} was denied: this path is a protected standard, not a Candidate artifact`
  if (!bootstrap || bootstrap.phase !== 'bootstrapping') return deny(base)
  return deny(
    `${base}; this new project is still in bootstrap ${bootstrap.step_index}/${bootstrap.step_count} — create ${bootstrap.next_artifact} next ` +
      `(order: ${bootstrap.steps.map((step) => step.targets[0]).join(' → ')}); the window closes for good once the Contract is frozen`,
  )
}

/** A bootstrap artifact whose step has not opened yet: the order is the point. */
function outOfOrderMessage(what, projectRoot, target, bootstrap) {
  return deny(
    `${what} on ${relative(projectRoot, target) || target} was denied: bootstrap ${bootstrap.step_index}/${bootstrap.step_count} is open and ` +
      `nothing beyond it may be created yet — create ${bootstrap.next_artifact} first ` +
      `(order: ${bootstrap.steps.map((step) => step.targets[0]).join(' → ')})`,
  )
}

/**
 * Build the guard.
 *
 * @param options.workspace     fallback working directory for a session without a cwd
 * @param options.resolveProject `(cwd) => projectRoot` — resolved per call, like the tools
 * @param options.repoRoot      optional repository root holding the CI material
 */
export function buildGuard({ workspace = process.cwd(), resolveProject = null, repoRoot = null, protectRepoMaterial = true } = {}) {
  const cache = new Map()

  /**
   * Protected roots for one project, re-derived when the project's own `paths:` block
   * changes. A bootstrap session writes `.agent/project.yaml` mid-session, and a cached
   * set would then protect the defaults while ignoring the paths that file just declared.
   */
  const rootsFor = (projectRoot) => {
    const key = norm(projectRoot)
    const signature = projectPathsSignature(projectRoot)
    const cached = cache.get(key)
    if (cached && cached.signature === signature) return cached.roots
    const roots = protectedRoots(projectRoot, { repoRoot, protectRepoMaterial })
    cache.set(key, { signature, roots })
    return roots
  }

  /** The lifecycle is never cached: every artifact a session creates changes it. */
  const lifecycleFor = (projectRoot) => deriveBootstrap(projectRoot, { repoRoot, protectRepoMaterial })

  return function guard(exec) {
    if (!exec || typeof exec.name !== 'string') return undefined
    const cwd = exec.agent?.session?.header?.cwd || workspace
    const projectRoot = typeof resolveProject === 'function' ? resolveProject(cwd) : cwd
    if (!projectRoot) return undefined
    const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
    const bootstrap = lifecycleFor(projectRoot)

    if (Object.hasOwn(WRITE_TOOL_PATHS, exec.name)) {
      const roots = rootsFor(projectRoot)
      const targets = WRITE_TOOL_PATHS[exec.name]
        .map((key) => resolveTarget(args[key], cwd))
        .filter(Boolean)
      if (targets.length === 0) {
        // Fail closed: a write whose target cannot be resolved cannot be shown to be
        // outside the protected standard. The message names the tool and its keys so
        // the caller can fix the shape rather than guess.
        return deny(`${exec.name} was denied because no target path could be resolved from ${JSON.stringify(Object.keys(args))}`)
      }
      for (const target of targets) {
        // The explicit bootstrap window: the ordered, still-uncreated artifacts of a new
        // project. Everything else protected stays denied even while it is open.
        if (isBootstrapWritable(target, bootstrap.writable)) continue
        if (bootstrap.phase === 'bootstrapping' && isBootstrapWritable(target, bootstrap.scope)) {
          return outOfOrderMessage(exec.name, projectRoot, target, bootstrap)
        }
        if (isProtectedTarget(target, roots)) {
          return protectedMessage(exec.name, projectRoot, target, bootstrap)
        }
      }
      return undefined
    }

    if (SHELL_TOOLS.includes(exec.name)) {
      const command = typeof args.command === 'string' ? args.command : ''
      if (command === '') return undefined
      if (AUTHORITY_REF.test(command)) {
        return deny(`shell command touching ${command.match(AUTHORITY_REF)[0]} was denied: authority refs move only inside the trusted Promotion job`)
      }
      if (WRITE_COMMAND.test(command)) {
        const roots = rootsFor(projectRoot)
        for (const token of command.split(/[\s"';|()]+/)) {
          if (!token || token.startsWith('-')) continue
          const target = resolveTarget(token, cwd)
          if (target && existsSync(target) === false && !isProtectedTarget(target, roots)) continue
          if (target && isBootstrapWritable(target, bootstrap.writable)) continue
          if (target && bootstrap.phase === 'bootstrapping' && isBootstrapWritable(target, bootstrap.scope)) {
            return outOfOrderMessage('shell command writing', projectRoot, target, bootstrap)
          }
          if (target && isProtectedTarget(target, roots)) {
            return protectedMessage('shell command writing', projectRoot, target, bootstrap)
          }
        }
      }
      return undefined
    }

    return undefined
  }
}

/** Cheap change detector for `.agent/project.yaml` (the file that redefines the roots). */
function projectPathsSignature(projectRoot) {
  try {
    const stats = statSync(join(projectRoot, '.agent', 'project.yaml'))
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'absent'
  }
}

export { bootstrapSummary }
