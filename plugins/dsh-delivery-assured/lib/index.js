/**
 * dsh-delivery-assured — host entry.
 *
 * `apply` / `inject` / `name` mirror the plugin row in `cordis.patch.yml`, and the
 * named helpers are exported so the plugin can be driven programmatically from a
 * smoke test without mounting it.
 *
 * Authority boundary (v0.5 §12, §16.5): every tool this plugin registers is a
 * read-only query or a local diagnostic. None of them writes Evidence, advances a
 * Baseline, records an attempt, or claims completion. The external CI verification
 * job remains the only producer of evidence, and its Promotion job the only holder
 * of the credential that advances `refs/heads/baseline/*`. A DSH session ending,
 * a workflow finishing, or a model answering "DONE" is not a promotion.
 *
 * @module dsh-delivery-assured
 */

import { apply, inject, name } from './host.js'
import { buildContext, resolveNodeBin, resolvePackRoot, resolveProjectRoot, runScript } from './bridge.js'

export { apply, inject, name }
export { buildContext, resolveNodeBin, resolvePackRoot, resolveProjectRoot, runScript }

export default { name, inject, apply }
