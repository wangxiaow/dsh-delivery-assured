/**
 * Bridge between the DSH session and the five Delivery-Assured scripts.
 *
 * The scripts stay the single implementation of every fact: this module only
 * resolves paths, builds an argument list, runs the script, and parses the JSON it
 * prints. Nothing here reimplements a check, and nothing here writes state.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Locate the operation pack. Order: explicit config, an environment override, the
 * sibling `packages/delivery-assured` next to the plugin, then the plugin itself
 * when the scripts were vendored into it.
 */
export function resolvePackRoot(config = {}) {
  const candidates = []
  if (config.packRoot) candidates.push(config.packRoot)
  if (process.env.DSH_DELIVERY_PACK) candidates.push(process.env.DSH_DELIVERY_PACK)
  candidates.push(resolve(here, '..', '..', '..', 'packages', 'delivery-assured'))
  candidates.push(resolve(here, '..'))
  for (const candidate of candidates) {
    if (!candidate) continue
    const root = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate)
    if (existsSync(join(root, 'scripts', 'resume.mjs'))) return root
  }
  return null
}

/**
 * Find a Node executable. DSH ships its own runtime, so a bare `node` is not
 * assumed to exist on PATH; the bundled Electron binary runs as Node when
 * ELECTRON_RUN_AS_NODE is set.
 */
export function resolveNodeBin(config = {}) {
  const envCandidates = [
    config.nodeBin,
    process.env.DSH_DELIVERY_NODE,
    process.env.DSH_DESKTOP_NODE_EXECUTABLE,
    process.env.NODE_BIN,
  ].filter(Boolean)
  for (const candidate of envCandidates) {
    if (isAbsolute(candidate) && existsSync(candidate)) return { bin: candidate, electronRunAsNode: false }
    const found = which(candidate)
    if (found) return { bin: found, electronRunAsNode: false }
  }
  const found = which('node')
  if (found) return { bin: found, electronRunAsNode: false }

  // Fall back to the desktop payload that is hosting this plugin.
  const execPath = process.execPath
  if (execPath && /DeepSeek Harness(\.exe)?$/i.test(execPath)) {
    return { bin: execPath, electronRunAsNode: true }
  }
  if (execPath) return { bin: execPath, electronRunAsNode: false }
  return null
}

function which(command) {
  const pathValue = process.env.PATH || ''
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve the delivery project.
 *
 * Precedence is deliberate and one-directional: the plugin config wins, then the
 * environment, then discovery upward from the workspace. Mixing the two with `||`
 * would let a configured relative path be silently replaced by an inherited
 * environment value, which is exactly how a session ends up reporting on the wrong
 * repository.
 */
export function resolveProjectRoot(config = {}, workspace = process.cwd()) {
  const fromConfig = config.projectRoot ? String(config.projectRoot) : null
  const fromEnv = process.env.DSH_DELIVERY_PROJECT ? String(process.env.DSH_DELIVERY_PROJECT) : null
  for (const [explicit, source] of [
    [fromConfig, 'configured'],
    [fromEnv, 'environment'],
  ]) {
    if (!explicit) continue
    const root = isAbsolute(explicit) ? resolve(explicit) : resolve(workspace, explicit)
    if (existsSync(join(root, '.agent', 'project.yaml')) || existsSync(join(root, '.agent', 'CONTRACT.yaml'))) {
      return { root, source }
    }
    return { root, source: `${source}_missing_contract` }
  }
  let dir = resolve(workspace)
  for (;;) {
    if (existsSync(join(dir, '.agent', 'project.yaml')) || existsSync(join(dir, '.agent', 'CONTRACT.yaml'))) {
      return { root: dir, source: 'discovered' }
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return { root: resolve(workspace), source: 'workspace_default' }
}

/**
 * Quote one argument for the shell this session actually uses.
 *
 * Windows sessions run through PowerShell, where a quoted first token is a string
 * literal rather than a command path, and single quotes are not delimiters in
 * command position at all. Double quotes are portable across PowerShell and cmd;
 * POSIX shells get the usual single-quote escaping.
 */
export function quote(value) {
  const text = String(value)
  if (process.platform === 'win32') {
    return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
  }
  return `'${text.replace(/'/g, "'\\''")}'`
}

/**
 * Build a complete command line for the session's shell.
 *
 * In PowerShell a quoted executable path must be invoked with the call operator,
 * otherwise the line is parsed as an expression and every argument becomes a syntax
 * error. `cmd` needs `call` for the same purpose, and POSIX shells need nothing.
 */
export function buildCommandLine(bin, args, { shellKind = detectShellKind() } = {}) {
  const parts = [quote(bin), ...args.map(quote)].join(' ')
  if (shellKind === 'powershell') return `& ${parts}`
  if (shellKind === 'cmd') return `call ${parts}`
  return parts
}

/** Which command language the session shell expects. */
export function detectShellKind() {
  if (process.platform !== 'win32') return 'posix'
  const shell = String(process.env.DSH_SHELL_KIND || process.env.ComSpec || '').toLowerCase()
  if (shell.includes('cmd.exe')) {
    // DSH reports a PowerShell shell for its pwsh executor; trust an explicit kind.
    return process.env.DSH_SHELL_KIND === 'cmd' ? 'cmd' : 'powershell'
  }
  return 'powershell'
}

/**
 * Build the context the host plugin needs: where the pack is, which project to
 * inspect, and how to run Node.
 */
export function buildContext(config = {}, workspace = process.cwd()) {
  const packRoot = resolvePackRoot(config)
  const node = resolveNodeBin(config)
  const project = resolveProjectRoot(config, workspace)
  const problems = []
  if (!packRoot) {
    problems.push(
      'the delivery-assured operation pack was not found; set packRoot in the plugin config or DSH_DELIVERY_PACK to the directory that contains scripts/resume.mjs',
    )
  }
  if (!node) problems.push('no Node executable was found; set nodeBin in the plugin config or DSH_DELIVERY_NODE')
  if (!existsSync(join(project.root, '.agent', 'CONTRACT.yaml'))) {
    problems.push(`no .agent/CONTRACT.yaml under ${project.root}; a read-only report needs a Contract to read`)
  }
  return { packRoot, node, project, problems }
}

/**
 * Run one operation-pack script and return its structured result.
 *
 * The scripts exit 0 for "no blocking gap", 1 for "blocking gap found" and 2 for an
 * input error. Exit code 1 is therefore a successful query with a blocking answer,
 * not a tool failure.
 *
 * The shell seam is `resolve(request) -> execute(spec) -> result()`: `execute`
 * returns a process handle and `result()` yields the collected outcome, so a caller
 * must not assume `execute` itself resolves with output.
 */
export async function runScript(ctx, shell, script, args = [], { timeoutMs = 300000, json = true } = {}) {
  if (!ctx.packRoot) throw new Error('the operation pack is not resolvable')
  if (!ctx.node) throw new Error('no Node executable is available')

  const scriptPath = join(ctx.packRoot, 'scripts', script)
  if (!existsSync(scriptPath)) throw new Error(`operation-pack script is missing: ${script}`)

  const argv = [scriptPath, '--project', ctx.project.root, ...(json ? ['--json'] : []), ...args]
  const env = ctx.node.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  const command = buildCommandLine(ctx.node.bin, argv)
  const spec = shell.resolve({
    command,
    workdir: ctx.packRoot,
    timeoutMs,
    env,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.sandboxPolicy ? { sandboxPolicy: ctx.sandboxPolicy } : {}),
  })
  const handle = await shell.execute(spec)
  const result = typeof handle?.result === 'function' ? await handle.result() : handle

  const stdout = String((result.stdout && result.stdout.text) || '')
  const stderr = String((result.stderr && result.stderr.text) || '')
  let parsed = null
  let parseError = null
  if (json) {
    try {
      parsed = JSON.parse(stdout)
    } catch (error) {
      parseError = String(error.message)
    }
  }
  return {
    script,
    exit_code: result.exitCode,
    timed_out: result.timedOut === true,
    stdout,
    stderr,
    json: parsed,
    json_error: parseError,
  }
}

/** Turn a script result into a compact, model-facing object. */
export function summarize(result, { keep = [] } = {}) {
  if (result.json) {
    const summary = {
      script: result.script,
      exit_code: result.exit_code,
      authority: 'local_diagnostic',
      summary: result.json.summary || null,
    }
    for (const key of keep) {
      if (result.json[key] !== undefined) summary[key] = result.json[key]
    }
    return summary
  }
  return {
    script: result.script,
    exit_code: result.exit_code,
    authority: 'local_diagnostic',
    summary: null,
    stdout_tail: result.stdout.trim().split('\n').slice(-25).join('\n'),
    stderr_tail: result.stderr.trim().split('\n').slice(-25).join('\n'),
    json_error: result.json_error,
  }
}

export function readTextIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Locate the GitHub CLI. The CI request interface shells out to it rather than
 * handling a token itself: the session's existing credentials stay where the
 * platform put them, and this plugin never reads or logs a secret.
 */
export function resolveGhBin(config = {}) {
  const candidates = [config.ghBin, process.env.DSH_DELIVERY_GH, 'gh'].filter(Boolean)
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate
    const found = which(candidate)
    if (found) return found
  }
  return null
}

/**
 * Run one command through the session's own shell seam and collect its result.
 * Used for `gh`; the same resolve/execute/result contract as `runScript`.
 */
export async function runCommand(ctx, shell, argv, { workdir = null, timeoutMs = 120000 } = {}) {
  const command = buildCommandLine(argv[0], argv.slice(1))
  const spec = shell.resolve({
    command,
    workdir: workdir || ctx.project?.root || process.cwd(),
    timeoutMs,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.sandboxPolicy ? { sandboxPolicy: ctx.sandboxPolicy } : {}),
  })
  const handle = await shell.execute(spec)
  const result = typeof handle?.result === 'function' ? await handle.result() : handle
  return {
    exit_code: result.exitCode,
    stdout: String((result.stdout && result.stdout.text) || ''),
    stderr: String((result.stderr && result.stderr.text) || ''),
    timed_out: result.timedOut === true,
  }
}

/** Run the GitHub CLI with the resolved executable, never exposing a token. */
export async function runGh(ctx, shell, args, options = {}) {
  const bin = resolveGhBin(ctx.config || {})
  if (!bin) throw new Error('the GitHub CLI (gh) was not found; set ghBin in the plugin config or DSH_DELIVERY_GH')
  return runCommand(ctx, shell, [bin, ...args], options)
}
