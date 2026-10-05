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

import { defineTool, defineToolIsPassThrough, defineToolSource, defineToolVerdict, defineToolVerdictReason, schemaIsProviderSafe } from './define-tool.js'
import { buildContext, resolvePackRoot, resolveProjectRoot, runGh, runScript, summarize } from './bridge.js'
import { appendIteration, loadIterations, nextIterationId, reduceIterations, summarizeRecovery } from './iterations.js'
import { observeRun, requestRun } from './ci-request.js'
import { buildGuard } from './guard.js'
import { createKernel } from './kernel.js'
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

  // A definition the host cannot project is not a cosmetic problem: the provider
  // receives `tool.parameters` verbatim, rejects the function schema, and the whole
  // session dies with `Invalid schema for function ... got 'type: null'`. Two
  // independent checks therefore stand in front of registration, and either one
  // withholds every tool (the skill, guard and kernel still load):
  //   1. the helper must be the hosting runtime's own (a pass-through or a foreign
  //      line is refused — the pass-through is the case that broke a live session);
  //   2. each compiled definition must be an object-rooted schema with no null node.
  const refused = defineToolVerdict === 'refuse'
  if (refused) {
    ctx.logger?.error?.(
      `delivery-assured: NOT registering tools — ${defineToolVerdictReason} (defineTool=${defineToolSource}). ` +
        'An uncompiled or foreign definition is forwarded to the model provider as-is and fails the session with an invalid function schema. ' +
        'The skill, the protected-path guard and the kernel still load. Install the plugin into the runtime that hosts it (or set DSH_DELIVERY_DSH_TOOLS_DIR) to enable the tools.',
    )
  }
  const safeDefinitions = new Set()
  const register = (definition) => {
    if (refused) return
    if (!schemaIsProviderSafe(definition)) {
      ctx.logger?.error?.(
        `delivery-assured: NOT registering ${definition?.name} — its parameter schema is not an object-rooted JSON Schema, which the model provider rejects.`,
      )
      return
    }
    safeDefinitions.add(definition.name)
    ctx.tools.register(definition)
  }

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

  register(
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

  register(
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

  register(
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

  register(
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

  register(
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

  // ----------------------------------------------------------------- delivery loop
  // Two write-capable tools close the automatic loop in a DSH session: one records
  // the durable iteration journal, one asks the platform to run a frozen workflow and
  // reports what happened. Neither can produce Evidence or move a Baseline — a
  // Baseline moves only inside the promotion job, which this plugin holds no
  // credential for. Both are deliberate narrow interfaces, not a general shell.
  register(
    defineTool({
      name: 'delivery_iteration',
      description:
        'Open, record or read the durable iteration journal (.agent/ITERATIONS.jsonl). This is how a new session recovers the current requirement, what was already done and what blocked, without the user repeating it: action=open with the user requirement verbatim, note for a decision or progress fact, verified only with an evidence reference actually observed, blocked with the concrete reason, close when the delivery is finished. action=status joins the journal with the recomputed resume summary. Append-only and non-authoritative: it never writes Evidence, never advances a Baseline and never marks a delivery complete.',
      parameters: {
        action: {
          type: 'string',
          description: 'open: start an iteration from the user requirement. note/verified/blocked/close: append a fact to the current one. status: read the journal plus the recomputed recovery summary.',
          enum: ['open', 'note', 'verified', 'blocked', 'close', 'status'],
          required: true,
        },
        requirement: { type: 'string', description: 'The user requirement, verbatim and complete, for action=open.' },
        detail: { type: 'string', description: 'Short factual note for action=note (decision, observed result, next step).' },
        evidence_ref: { type: 'string', description: 'The CI run, evidence id or command output actually observed, for action=verified.' },
        reason: { type: 'string', description: 'The concrete blocking condition, for action=blocked.' },
        iteration: { type: 'string', description: 'Iteration id such as IT-002; defaults to the current open iteration.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const root = ready.ctx.project.root
        const loaded = loadIterations(root)
        const reduced = reduceIterations(loaded.events)
        const current = reduced.current
        try {
          if (args.action !== 'status') {
            const id = args.iteration || current?.id
            if (!id) return { ok: false, problems: ['no iteration is open; call action=open with the user requirement first'], authority: 'local_diagnostic' }
            const at = new Date().toISOString()
            const base = { id, at }
            if (args.action === 'open') {
              const opened = { ...base, id: nextIterationId(loaded.events), kind: 'opened', requirement: args.requirement, ...(current ? { iteration_of: current.id } : {}) }
              appendIteration(root, opened)
            } else if (args.action === 'note') appendIteration(root, { ...base, kind: 'noted', detail: args.detail })
            else if (args.action === 'verified') appendIteration(root, { ...base, kind: 'verified', evidence_ref: args.evidence_ref })
            else if (args.action === 'blocked') appendIteration(root, { ...base, kind: 'blocked', reason: args.reason })
            else if (args.action === 'close') appendIteration(root, { ...base, kind: 'closed' })
          }
        } catch (error) {
          return { ok: false, problems: [String(error?.message || error)], authority: 'local_diagnostic' }
        }
        const after = loadIterations(root)
        const nextReduced = reduceIterations(after.events)
        let resume = null
        if (args.action === 'status') {
          const result = await runScript(ready.ctx, ctx.shell, 'resume.mjs', ['--offline'])
          resume = result.json || null
        }
        return {
          ok: true,
          action: args.action,
          project: root,
          iteration: nextReduced.current,
          iterations: nextReduced.iterations.length,
          unreadable_lines: after.problems.length,
          recovery: summarizeRecovery({ iterations: nextReduced, problems: after.problems, resume }),
          authority: 'local_diagnostic',
          note: 'the journal is a resumable summary, not a completion record: only CI evidence and a promoted Baseline count',
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'delivery_ci',
      description:
        'Ask the platform to run one frozen workflow and report what it observed. action=request dispatches verify (with an exact frozen candidate SHA, parent baseline, Slice and falsifiable hypothesis) or promote (consuming one exact completed verify run). action=observe reads one exact run and its jobs. Never retried blindly on an ambiguous dispatch, never given baseline credentials, and a requested or completed run is never reported as a promotion: only the durable collector and the promotion job make a result real.',
      parameters: {
        action: { type: 'string', description: 'request: dispatch a workflow. observe: read one exact run.', enum: ['request', 'observe'], required: true },
        workflow: { type: 'string', description: 'Which frozen workflow to ask for.', enum: ['verify', 'promote'] },
        candidate: { type: 'string', description: 'Full 40-character commit SHA that was actually frozen, for workflow=verify.' },
        parent_baseline: { type: 'string', description: 'Expected parent baseline id (BL-003) or none, for workflow=verify.' },
        slice: { type: 'string', description: 'Approved Slice id from the frozen standards, for workflow=verify.' },
        hypothesis: { type: 'string', description: 'The falsifiable hypothesis this attempt tests, for workflow=verify.' },
        comparison_approval_ref: { type: 'string', description: 'Approved standard-comparison record, only when the frozen standard legitimately changed.' },
        mode: { type: 'string', description: 'Promotion entry, for workflow=promote.', enum: ['promote-baseline', 'MVP_READY'] },
        expected_parent: { type: 'string', description: 'Expected parent baseline id or none, for workflow=promote.' },
        verify_run_id: { type: 'string', description: 'Exact completed verify run id the promotion consumes.' },
        verify_run_attempt: { type: 'string', description: 'Exact verify attempt number the promotion consumes.' },
        owner_approval_ref: { type: 'string', description: 'Owner confirmation reference, only for a project whose frozen policy is human_review.' },
        run_id: { type: 'string', description: 'Exact run id to read, for action=observe.' },
        repository: { type: 'string', description: 'owner/name; defaults to the configured repository or the project remote.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const configured = config.ciRepo || process.env.DSH_DELIVERY_CI_REPO || null
        let repository = args.repository || configured
        const runner = (ghArgs) => runGh({ ...ready.ctx, config }, ctx.shell, ghArgs, { workdir: ready.ctx.project.root })
        if (!repository) {
          const discovered = await runner(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
          repository = discovered.exit_code === 0 ? discovered.stdout.trim() : null
        }
        if (!repository) {
          return { ok: false, problems: ['no CI repository could be resolved; set ciRepo in the plugin config or DSH_DELIVERY_CI_REPO, or run inside a GitHub checkout'], authority: 'local_diagnostic' }
        }
        try {
          if (args.action === 'observe') return { ok: true, authority: 'local_diagnostic', ...(await observeRun(runner, { repository, runId: args.run_id })) }
          const result = await requestRun(runner, {
            action: args.workflow,
            repository,
            candidate: args.candidate,
            parent_baseline: args.parent_baseline,
            slice: args.slice,
            hypothesis: args.hypothesis,
            comparison_approval_ref: args.comparison_approval_ref,
            mode: args.mode,
            expected_parent: args.expected_parent,
            verify_run_id: args.verify_run_id,
            verify_run_attempt: args.verify_run_attempt,
            owner_approval_ref: args.owner_approval_ref,
          })
          return { ok: result.status !== 'refused', authority: 'local_diagnostic', ...result }
        } catch (error) {
          return { ok: false, problems: [String(error?.message || error)], authority: 'local_diagnostic' }
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

  // ------------------------------------------------------------------ steering
  // Two controls that keep a working session from drifting off the boundary:
  // a protected-path guard (refuses, never grants) and an always-on kernel section
  // rendered from the pack's own resume output. Both are optional services: a host
  // without them still gets the read-only tools, and nothing here fails the load.
  const resolveContext = (cwd) => buildContext(config, cwd)
  const guardInstalled = installGuard(ctx, { config, workspace })
  const kernelInstalled = installKernel(ctx, { config, workspace, resolveContext })

  // A session must be able to see what it resolved, because a wrong pack or project
  // path otherwise looks like a Contract full of gaps. Resolution is per call, so
  // this only reports the launch-time defaults.
  ctx.logger?.info?.(
    `delivery-assured ready: pack=${resolvePackRoot(config) || '(not found)'} project=${resolveProjectRoot(config, workspace).root} ` +
      `defineTool=${defineToolSource} verdict=${defineToolVerdict} tools=${safeDefinitions.size} guard=${guardInstalled} kernel=${kernelInstalled}`,
  )
  if (defineToolIsPassThrough) {
    ctx.logger?.error?.(
      'delivery-assured: the runtime defineTool was NOT found, so no tool schema could be projected by DSH and no tool was registered. ' +
        'Point DSH_DELIVERY_DSH_TOOLS_DIR at the hosting runtime, or install the plugin into the profile that hosts it.',
    )
  }
}

/**
 * Register the protected-path guard. `ctx.tools.guard()` is a synchronous denial
 * check whose verdict cannot be overturned by a later listener, so a wrong verdict
 * here would be permanent; every branch therefore fails closed only for writes whose
 * target is inside the protected standard, and allows everything else.
 */
function installGuard(ctx, { config, workspace }) {
  if (!ctx.tools || typeof ctx.tools.guard !== 'function') return 'unavailable'
  try {
    const repoRoot = config.repoRoot || null
    const guard = buildGuard({
      workspace,
      repoRoot,
      // A repository that is itself the operation pack under development sets this
      // to false: otherwise the guard refuses the very edits that improve the pack.
      protectRepoMaterial: config.protectRepoMaterial !== false,
      resolveProject: (cwd) => {
        const found = resolveProjectRoot(config, cwd)
        // Only a project that really carries a Contract is worth protecting; a
        // session in an unrelated directory must not inherit another repository's
        // protected paths.
        return found.source.endsWith('missing_contract') ? null : found.root
      },
    })
    ctx.tools.guard(guard)
    return 'installed'
  } catch (error) {
    ctx.logger?.warn?.(`delivery-assured: could not install the protected-path guard: ${error?.message || error}`)
    return 'failed'
  }
}

/**
 * Publish the Global Kernel as a system-prompt variable plus the section that
 * references it. The provider is synchronous by contract, so the text is served from
 * a cache that a background refresh fills from `resume.mjs`.
 */
function installKernel(ctx, { config, workspace, resolveContext }) {
  // `ctx.get` is the service lookup on a composed host; a host that exposes the
  // service directly (or a test double) must work too, so try both instead of
  // letting an absent lookup shadow a present service.
  const looked = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
  const systemPrompt = looked || ctx.systemPrompt
  if (!systemPrompt || typeof systemPrompt.variable !== 'function' || typeof systemPrompt.section !== 'function') {
    return 'unavailable'
  }
  try {
    const kernel = createKernel({ resolveContext, logger: ctx.logger })
    systemPrompt.variable(kernel.variable, () => kernel.text())
    systemPrompt.section({ name: kernel.section, order: kernel.order, text: `{{${kernel.variable}}}` })
    // Fill the cache now so the first request after a session starts already carries
    // the kernel; the call is deliberately not awaited, and the provider says "not
    // ready" rather than inventing a summary if it has not finished.
    const shell = ctx.shell
    const session = typeof ctx.get === 'function' ? ctx.get('session') : undefined
    const cwd = session?.header?.cwd || workspace
    Promise.resolve()
      .then(() => kernel.refresh(shell, cwd))
      .catch(() => {})
    return 'installed'
  } catch (error) {
    ctx.logger?.warn?.(`delivery-assured: could not publish the delivery kernel: ${error?.message || error}`)
    return 'failed'
  }
}




