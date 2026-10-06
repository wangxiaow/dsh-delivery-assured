/**
 * Explicit environment construction for verification and test subprocesses.
 *
 * The rule this module exists to enforce: a verifier run and a test fixture must
 * not inherit whatever the host process happens to carry. `{ ...process.env, ... }`
 * looks harmless and is not — under a GitHub Actions job the ambient environment
 * contains `DSH_CI_ISSUER`, `DSH_STANDARD_REVISION`, `DSH_IMAGE_DIGEST` and the
 * deployment identity variables, so a Host-backend fixture could silently acquire
 * the authority of the trusted-CI job it merely happened to run inside, and the
 * security meaning of a test would depend on where it was launched.
 *
 * The model is an allowlist, never a blacklist: a blacklist of "the variables that
 * bit us" has to be maintained forever and fails open on the next variable somebody
 * adds. Everything a subprocess needs is either in `SAFE_BASE_ENV_KEYS` (the
 * minimum a Node process and the platform's own shell need to start at all) or is
 * injected explicitly by the caller — the frozen verifier configuration for gates,
 * the fixture for a test scenario.
 *
 * Nothing here reads or grants authority. There is no base-environment key in the
 * `DSH_` namespace: every DSH_* variable is a verification input and must be
 * declared by whoever is entitled to declare it.
 */

/**
 * The minimum environment a subprocess of this pack needs to start.
 *
 * Deliberately excludes everything that carries meaning for this product: no
 * `DSH_*`, no `GITHUB_*`, no `CI`, no `GH_TOKEN`, no `NODE_OPTIONS`. A key that is
 * absent here is not "blocked" — it simply is not inherited, and a caller that
 * needs it must say so by name.
 */
export const SAFE_BASE_ENV_KEYS = Object.freeze([
  // Process launch, command resolution and the platform's own shell.
  'PATH',
  'PATHEXT',
  'ComSpec',
  'SHELL',
  'PSModulePath',
  // Windows runtime roots the OS and Node require to resolve system paths.
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ProgramData',
  // Home and temporary directories: Git needs a home for its config, every runtime
  // needs a writable temp.
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  // Locale, identity and clock: changing these changes how output is encoded and
  // timestamped, which a byte-comparing verifier must see consistently.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'TZ',
])

/**
 * Non-authority signals that a runner may pass through to a verification command.
 *
 * These do not decide anything about a delivery; they only change how a suite
 * reports that it could not run (see `project/scripts/verify-build.mjs`, which
 * turns a skip into a GitHub annotation). They are propagated only where that
 * reporting matters, and they are named here so "which ambient variables reach a
 * gate" stays a one-line answer.
 */
export const RUNNER_SIGNAL_KEYS = Object.freeze(['GITHUB_ACTIONS', 'CI'])

/** The allowlisted base environment, read from `ambient` (default `process.env`). */
export function buildBaseEnv(ambient = process.env, { keys = SAFE_BASE_ENV_KEYS } = {}) {
  const out = {}
  for (const key of keys) {
    const value = ambient?.[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** The runner signals, when the runner set them. */
export function runnerSignals(ambient = process.env) {
  return buildBaseEnv(ambient, { keys: RUNNER_SIGNAL_KEYS })
}

/**
 * An explicit environment for a verifier gate.
 *
 * `declared` is the gate's own `env` block from the *frozen* verifier
 * configuration. A value written as `$NAME` is a forwarded reference to the
 * verifier process's own environment — an opt-in that is part of the frozen
 * standard, so the set of ambient variables a gate may see is frozen too and a
 * Candidate cannot widen it. Every other value is a literal.
 */
export function gateEnv(declared = {}, { ambient = process.env, extra = {} } = {}) {
  const env = { ...buildBaseEnv(ambient), ...runnerSignals(ambient) }
  for (const [key, value] of Object.entries(declared || {})) {
    if (value === null || value === undefined) continue
    const text = String(value)
    const forwarded = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text)
    if (forwarded) {
      const source = ambient?.[forwarded[1]]
      if (typeof source === 'string') env[key] = source
      continue
    }
    env[key] = text
  }
  return { ...env, ...extra }
}

/**
 * An explicit environment for a test fixture.
 *
 * `scenario` names what the fixture is proving; only the variables that scenario
 * declares are present. A Host fixture therefore cannot observe a CI authority
 * variable that the parent process happened to export.
 */
export function fixtureEnv(scenario = {}, { ambient = process.env, base = {} } = {}) {
  return { ...buildBaseEnv(ambient), ...base, ...scenario }
}

/** Whether a variable would be inherited by default (used by tests and docs). */
export function isInheritedByDefault(name) {
  return SAFE_BASE_ENV_KEYS.includes(name) || RUNNER_SIGNAL_KEYS.includes(name)
}
