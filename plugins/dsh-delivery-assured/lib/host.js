/**
 * dsh-delivery-assured 闁?the host half.
 *
 * Registers five read-only tools that expose the operation pack to a DSH session,
 * plus one runtime skill that tells the session how to work with the pack.
 *
 * Hard rule enforced by this module's shape: it registers no tool that writes
 * Evidence, advances a Baseline, records an attempt, or approves a standard.
 * Those actions live in the external CI jobs, and a session cannot perform them.
 */

import { defineTool, defineToolIsPassThrough, defineToolSource } from './define-tool.js'
import { buildContext, resolvePackRoot, resolveProjectRoot, runScript, summarize } from './bridge.js'
import { SKILL_DESCRIPTION, SKILL_MARKDOWN, SKILL_NAME, SKILL_WHEN_TO_USE } from './skill.js'

export const name = 'delivery-assured'

/**
 * `tools` and `shell` run the scripts; `skills` publishes the runtime skill when the
 * composition has a skill registry mounted.
 */
export const inject = ['tools', 'shell', 'skills']

const AUTHORITY_NOTE =
  'This is a read-only local diagnostic. Only the trusted CI verification job produces evidence, ' +
  'and only its Promotion job may advance refs/heads/baseline/*. A session ending or a model ' +
  'answering DONE is never a promotion.'

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function renderResult(result) {
  return text(result)
}

export function apply(ctx, config = {}) {
  const workspace = config.workspace || process.cwd()

  // Resolve per call: a host-wide cache would reuse the first session's project.
  function requireReady(exec = {}) {
    const session = exec.agent?.session
    const cwd = session?.header?.cwd || workspace
    const ctxInfo = buildContext(config, cwd)
    const policy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : ctx.sandboxPolicy
    ctxInfo.signal = exec.signal
    ctxInfo.sandboxPolicy = policy?.resolve(session ? { session } : {})
    if (ctxInfo.problems.length > 0) {
      return {
        ok: false,
        problems: ctxInfo.problems,
        authority: 'local_diagnostic',
        hint:
          'Set the plugin config keys packRoot / projectRoot / nodeBin, or the environment variables ' +
          'DSH_DELIVERY_PACK / DSH_DELIVERY_PROJECT / DSH_DELIVERY_NODE.',
      }
    }
    return { ok: true, ctx: ctxInfo }
  }

  ctx.tools.register(
    defineTool({
      name: 'delivery_gaps',
      description:
        'Check the delivery Contract for structural gaps at one phase. Reports checklist items without a disposition, unmapped obligations, unresolved unknowns, Critical rules without derived negative acceptance, and placeholder text still left in the Contract. Read-only: it reports "not filled", "not mapped" or "not executed"; it cannot tell whether a requirement was never thought of. ' +
        AUTHORITY_NOTE,
      parameters: {
        phase: {
          type: 'string',
          description:
            'contract: after drafting the Contract, before tests exist. acceptance: after the independent Acceptance session wrote cases. slice: before entering verification for one Slice. mvp: before claiming the whole product is done.',
          enum: ['contract', 'acceptance', 'slice', 'mvp'],
          required: true,
        },
        slice: {
          type: 'string',
          description: 'Slice id, required for the slice phase so future Slices are not reported as current gaps.',
        },
        strict: {
          type: 'boolean',
          description: 'Treat warnings as blocking too.',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const argv = ['--phase', args.phase]
        if (args.slice) argv.push('--slice', args.slice)
        if (args.strict) argv.push('--strict')
        const result = await runScript(ready.ctx, ctx.shell, 'check-gaps.mjs', argv)
        return {
          ...summarize(result, { keep: ['phase', 'counts', 'issues'] }),
          project: ready.ctx.project.root,
          project_source: ready.ctx.project.source,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'delivery_coverage',
      description:
        'Recompute the obligation to Slice to Acceptance to evidence mapping from the Contract, the frozen acceptance manifest and CI records. Never consults a task list or a DONE marker. Use view=mvp to ask whether the whole Contract is closed, or view=slice for what the current Slice plus the accumulated Spine must prove now. ' +
        AUTHORITY_NOTE,
      parameters: {
        view: {
          type: 'string',
          description: 'mvp closes over the whole Contract; slice covers the current Slice and the existing Spine.',
          enum: ['mvp', 'slice'],
          required: true,
        },
        slice: { type: 'string', description: 'Slice id to report on when view is slice.' },
        candidate: {
          type: 'string',
          description: 'Candidate revision to judge evidence against. Defaults to the current HEAD.',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const argv = ['--view', args.view]
        if (args.slice) argv.push('--slice', args.slice)
        if (args.candidate) argv.push('--candidate', args.candidate)
        const result = await runScript(ready.ctx, ctx.shell, 'coverage.mjs', argv)
        return {
          ...summarize(result, {
            keep: ['view', 'candidate', 'buckets', 'gap_classes', 'blocking', 'critical_violations'],
          }),
          project: ready.ctx.project.root,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'delivery_resume',
      description:
        'Rebuild the trustworthy starting point after a session change, a gap or a machine change: protected references, CI evidence and attempts, recomputed Coverage, the untouched local candidate diff, remaining budget, blockers and the next verification step. Run this first when resuming work. ' +
        AUTHORITY_NOTE,
      parameters: {
        offline: {
          type: 'boolean',
          description: 'Skip reading remote protected references and say so, instead of failing.',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const argv = args.offline ? ['--offline'] : []
        const result = await runScript(ready.ctx, ctx.shell, 'resume.mjs', argv)
        return {
          ...summarize(result, {
            keep: ['project', 'candidate', 'dirty', 'baseline_ref', 'remote', 'local_baseline', 'evidence', 'current_slice', 'owed', 'budget', 'blockers', 'notes', 'next_actions'],
          }),
          project: ready.ctx.project.root,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'delivery_attempts',
      description:
        'Report the attempt budget for a Slice: attempts and replans against their limits, progress on the same standard and case set, oscillation detection, and whether a Replan is required or the budget is exhausted. Counting continues across sessions; changing session or renaming a Slice does not reset it. ' +
        AUTHORITY_NOTE,
      parameters: {
        slice: { type: 'string', description: 'Limit the report to one Slice.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const argv = args.slice ? ['--slice', args.slice] : []
        const result = await runScript(ready.ctx, ctx.shell, 'attempts.mjs', argv)
        return {
          ...summarize(result, {
            keep: ['slice', 'limits', 'counted', 'infra_aborted', 'replans', 'per_root_cause', 'progress', 'oscillation', 'critical_open', 'requires_replan', 'budget_blocked'],
          }),
          project: ready.ctx.project.root,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'delivery_verify_local',
      description:
        'Run the 5+1 Gates locally and report the diagnostic result: build, clean boot, persistence/migration, Slice acceptance, regression Spine and deployment. Exit code 0 here means only that these commands passed on this machine. Evidence mode is deliberately not reachable from a session. ' +
        AUTHORITY_NOTE,
      parameters: {
        slice: { type: 'string', description: 'Slice id being verified.' },
        candidate: { type: 'string', description: 'Candidate revision to bind the run to. Defaults to HEAD.' },
        'only-gate': {
          type: 'array',
          description: 'Run only these gates.',
          items: {
            type: 'string',
            enum: ['build', 'clean_boot', 'persistence_migration', 'slice_acceptance', 'regression_spine', 'deployment'],
          },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const argv = ['--local']
        if (args.slice) argv.push('--slice', args.slice)
        if (args.candidate) argv.push('--candidate', args.candidate)
        for (const gate of args['only-gate'] || []) argv.push('--only-gate', gate)
        const result = await runScript(ready.ctx, ctx.shell, 'verify.mjs', argv, { timeoutMs: 30 * 60 * 1000 })
        return {
          ...summarize(result, { keep: ['candidate', 'parent_baseline', 'slice_id', 'mode', 'gates', 'cases', 'structural', 'blocking'] }),
          project: ready.ctx.project.root,
          reminder:
            'Local diagnostics never unlock a Baseline. Push the frozen candidate and read the real CI result to advance it.',
        }
      },
    }),
  )

  // Publish the working procedure as a runtime skill when a registry is mounted.
  if (ctx.skills && typeof ctx.skills.register === 'function') {
    try {
      ctx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        source: 'dsh-delivery-assured',
        // The registry reads the body from content; an unknown key would register an
        // empty skill that loads nothing.
        content: SKILL_MARKDOWN,
      })
    } catch (error) {
      ctx.logger?.warn?.(`delivery-assured: could not register the runtime skill: ${error?.message || error}`)
    }
  }

  // A session must be able to see what it resolved, because a wrong pack or project
  // path otherwise looks like a Contract full of gaps. Resolution is per call, so
  // this only reports the launch-time defaults.
  ctx.logger?.info?.(
    `delivery-assured ready: pack=${resolvePackRoot(config) || '(not found)'} project=${resolveProjectRoot(config, workspace).root} defineTool=${defineToolSource}`,
  )
  if (defineToolIsPassThrough) {
    ctx.logger?.warn?.(
      'delivery-assured: the runtime defineTool was not found, so tool schemas were not projected by DSH. ' +
        'Registering tools this way still works, but it means the runtime contract was not verified at load time.',
    )
  }
}




