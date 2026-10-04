/**
 * Locate the DSH runtime's `defineTool`, or degrade to a documented pass-through.
 *
 * The contract is the runtime's, not this package's: registering tools through the
 * real helper is what makes DSH project the parameter spec and assert the output
 * schema at `tools.register()` time. A local re-implementation would accept schemas
 * the runtime rejects, which is how an unloadable plugin passes its own tests.
 *
 * Resolution is deliberately narrow. A stray `@deepseek-ai/dsh-tools` on the ambient
 * module path — an npx cache, a checkout, a leftover install — can belong to a
 * *different* DSH line than the one hosting this plugin, and picking it would verify
 * the plugin against the wrong contract. So only two sources are trusted:
 *
 *   1. `DSH_DELIVERY_DSH_TOOLS_DIR`: an explicit package directory, used by tests that
 *      must pin the exact runtime under verification;
 *   2. the running harness home, which is where the hosting DSH installs its own row
 *      of packages.
 *
 * `test/compatibility.test.mjs` asserts that the version loaded here equals the
 * version the harness itself provides, so a fall-through to the wrong copy fails
 * loudly rather than silently weakening the contract.
 *
 * When neither resolves, the builder is a pass-through so the plugin stays importable
 * outside DSH. It performs no validation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SPECIFIER = '@deepseek-ai/dsh-tools'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

function normalizeBase(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.endsWith('/') || value.endsWith('\\') ? value : `${value}/`
}

/** Candidate node_modules bases, most specific first. */
function resolutionBases() {
  return [
    // 1. The runtime that is actually hosting this plugin. In the desktop app that
    //    is the copy inside `app.asar`; `$DSH_HOME/profiles/node_modules` is a
    //    DIFFERENT line (the CLI/web palette), and compiling a tool definition with
    //    it produces a definition the host registry cannot project — the model
    //    request then fails with an invalid function schema.
    ...hostLocalBases(),
    normalizeBase(process.env.DSH_DELIVERY_DSH_TOOLS_DIR),
    normalizeBase(process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', 'node_modules') : null),
    normalizeBase(process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules') : null),
  ].filter((base) => base !== null)
}

/** Bases that belong to the process hosting the plugin (Electron app payload). */
function hostLocalBases() {
  const out = []
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources.trim() !== '') {
    out.push(normalizeBase(join(resources, 'app.asar', 'dsh', 'node_modules')))
  }
  const execPath = process.execPath
  if (typeof execPath === 'string' && execPath.trim() !== '') {
    out.push(normalizeBase(join(dirname(execPath), 'resources', 'app.asar', 'dsh', 'node_modules')))
  }
  return out.filter((base) => base !== null)
}

/** Whether this process is the desktop application rather than a CLI profile. */
export function isDesktopHost() {
  const execPath = process.execPath || ''
  return /DeepSeek Harness(\.exe)?$/i.test(execPath) || typeof process.resourcesPath === 'string'
}

/**
 * Whether the plugin may register tools at all.
 *
 * Three independent reasons to refuse, because getting this wrong kills a live
 * session (see REPAIR_NOTES: `Invalid schema for function ... got 'type: null'`):
 *   1. the pass-through returns the author-facing spec unchanged, and the host sends
 *      `tool.parameters` to the provider verbatim;
 *   2. a helper from a different DSH line compiles a definition the host cannot use;
 *   3. prerelease lines do not satisfy each other, so the resolved version must equal
 *      the peer line this plugin declares — a mismatch is an unverified contract.
 * An explicit `DSH_DELIVERY_DSH_TOOLS_DIR` is the tests' pin and is honoured.
 */
export function toolRegistrationVerdict({ passThrough, hostLocal, desktopHost, explicit, peerOk }) {
  if (passThrough) return 'refuse'
  if (explicit) return 'ok'
  if (peerOk === false) return 'refuse'
  if (desktopHost && !hostLocal) return 'refuse'
  return 'ok'
}

/** The exact peer line this package declares, e.g. `0.2.0-rc.2`. */
export function declaredPeerLine() {
  try {
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    const range = String(manifest.peerDependencies?.[SPECIFIER] || '')
    return range.replace(/^[\^~>=<\s]+/, '').trim() || null
  } catch {
    return null
  }
}

/** Whether a resolved version is the same prerelease line the plugin was built for. */
export function peerLineMatches(version) {
  const declared = declaredPeerLine()
  if (!declared || !version) return null
  return String(version) === declared
}

/**
 * Last line of defence, independent of where the helper came from: the schema the
 * provider receives must be an object root with no null-typed node. A definition that
 * fails this is never registered.
 */
export function schemaIsProviderSafe(definition) {
  const parameters = definition?.parameters
  if (!parameters || typeof parameters !== 'object') return false
  if (parameters.type !== 'object') return false
  try {
    return !/"type"\s*:\s*null/.test(JSON.stringify(parameters))
  } catch {
    return false
  }
}

/**
 * Resolve the package directory, and remember *which kind* of base produced it.
 *
 * An explicit `DSH_DELIVERY_DSH_TOOLS_DIR` may name either the package itself or a
 * `node_modules` root that contains it, so both readings are tried before the
 * specifier walk. The host-local bases are tried next, and only then the profile
 * palette — a copy reached through a symlink into an npx cache still counts as the
 * profile line, which is why the source is tracked per base rather than per realpath.
 */
function resolvePackageDir() {
  const explicit = process.env.DSH_DELIVERY_DSH_TOOLS_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    if (existsSync(join(explicit, 'package.json'))) return { dir: explicit, source: 'explicit' }
  }
  const localBases = new Set(hostLocalBases())
  for (const base of resolutionBases()) {
    for (const specifier of [`${SPECIFIER}/package.json`, SPECIFIER]) {
      try {
        const dir = dirname(createRequire(join(base, 'noop.js')).resolve(specifier))
        return { dir, source: localBases.has(base) ? 'host-local' : 'profile' }
      } catch {
        // try the next specifier or base
      }
    }
  }
  return null
}

async function loadReal() {
  const resolved = resolvePackageDir()
  if (resolved === null) return null
  const { dir, source } = resolved
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry =
    typeof manifest.exports === 'string'
      ? manifest.exports
      : manifest.exports?.['.']?.default || manifest.exports?.['.'] || manifest.main || 'index.js'
  const module = await import(pathToFileURL(join(dir, entry)).href)
  if (typeof module.defineTool !== 'function') {
    throw new TypeError(`${SPECIFIER} does not export defineTool`)
  }
  return { defineTool: module.defineTool, dir, version: manifest.version, source }
}

let loaded = null
let loadError = null
try {
  loaded = await loadReal()
} catch (error) {
  loadError = error
}

/** The tool-definition builder: the resolved runtime's, else a pass-through. */
export const defineTool = loaded?.defineTool ?? ((options) => options)

/** Where the builder came from, for a startup log line and for tests. */
export const defineToolSource = loaded ? `${loaded.version} (${loaded.dir})` : loadError ? `unresolved: ${loadError.message}` : 'pass-through'

/** The resolved package version, or null when the runtime helper was not found. */
export const defineToolVersion = loaded?.version ?? null

/** True when the real runtime helper was not found and the pass-through is in use. */
export const defineToolIsPassThrough = loaded === null

/** Which kind of base produced the helper: `explicit`, `host-local`, `profile`, or none. */
export const defineToolSourceKind = loaded?.source ?? (loadError ? 'error' : 'none')

/** Whether the helper came from the process that is hosting this plugin. */
export const defineToolIsHostLocal = loaded?.source === 'host-local' || loaded?.source === 'explicit'

/** Whether the plugin may register tools with this helper (see the verdict function). */
export const defineToolVerdict = toolRegistrationVerdict({
  passThrough: defineToolIsPassThrough,
  hostLocal: defineToolIsHostLocal,
  desktopHost: isDesktopHost(),
  explicit: loaded?.source === 'explicit',
  peerOk: peerLineMatches(loaded?.version),
})

/** The bases that were considered, so a failure can name them. */
export const defineToolSearchPath = resolutionBases()

/** Why the verdict came out the way it did, for the startup log. */
export const defineToolVerdictReason = defineToolIsPassThrough
  ? `the runtime helper was not found (searched: ${defineToolSearchPath.join(', ') || 'nothing'})`
  : loaded?.source === 'explicit'
    ? 'explicit pin'
    : peerLineMatches(loaded?.version) === false
      ? `helper ${loaded?.version} is not the declared peer line ${declaredPeerLine()}`
      : isDesktopHost() && !defineToolIsHostLocal
        ? 'the helper is not from the hosting app'
        : 'hosting runtime helper'

void here
