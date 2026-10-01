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
    normalizeBase(process.env.DSH_DELIVERY_DSH_TOOLS_DIR),
    normalizeBase(process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', 'node_modules') : null),
    normalizeBase(process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules') : null),
  ].filter((base) => base !== null)
}

/**
 * Resolve the package directory.
 *
 * An explicit `DSH_DELIVERY_DSH_TOOLS_DIR` may name either the package itself or a
 * `node_modules` root that contains it, so both readings are tried before the
 * specifier walk.
 */
function resolvePackageDir() {
  const explicit = process.env.DSH_DELIVERY_DSH_TOOLS_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    if (existsSync(join(explicit, 'package.json'))) return explicit
  }
  for (const base of resolutionBases()) {
    for (const specifier of [`${SPECIFIER}/package.json`, SPECIFIER]) {
      try {
        return dirname(createRequire(join(base, 'noop.js')).resolve(specifier))
      } catch {
        // try the next specifier or base
      }
    }
  }
  return null
}

async function loadReal() {
  const dir = resolvePackageDir()
  if (dir === null) return null
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry =
    typeof manifest.exports === 'string'
      ? manifest.exports
      : manifest.exports?.['.']?.default || manifest.exports?.['.'] || manifest.main || 'index.js'
  const module = await import(pathToFileURL(join(dir, entry)).href)
  if (typeof module.defineTool !== 'function') {
    throw new TypeError(`${SPECIFIER} does not export defineTool`)
  }
  return { defineTool: module.defineTool, dir, version: manifest.version }
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

/** The bases that were considered, so a failure can name them. */
export const defineToolSearchPath = resolutionBases()
void here
