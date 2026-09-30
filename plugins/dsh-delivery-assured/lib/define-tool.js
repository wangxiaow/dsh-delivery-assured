/**
 * Resolve DSH's `defineTool` without breaking the plugin outside a profile.
 *
 * Inside a DSH profile `@deepseek-ai/dsh-tools` is present and its `defineTool`
 * normalizes the parameter schema and validates the output schema at registration
 * time — that behaviour is the one we want. Outside a profile (a smoke test, a plain
 * Node process, a packaging check) the package legitimately does not resolve, so
 * this module falls back to a shim that passes the definition through unchanged.
 *
 * The shim is a pass-through, not a reimplementation: it never pretends to validate
 * a schema. When the real module resolves it always wins.
 */

let defineToolImpl = null
let loadError = null

try {
  const module = await import('@deepseek-ai/dsh-tools')
  if (typeof module.defineTool !== 'function') {
    throw new TypeError('@deepseek-ai/dsh-tools does not export defineTool')
  }
  defineToolImpl = module.defineTool
} catch (error) {
  loadError = error
  defineToolImpl = (options) => options
}

/** The tool-definition helper: the real one when available, a pass-through otherwise. */
export const defineTool = defineToolImpl

/** True when the real DSH helper is in use rather than the pass-through shim. */
export const defineToolIsShimmed = loadError !== null

/** Why the shim is in use, for a startup log line. */
export const defineToolShimReason = loadError ? String(loadError.message) : null
