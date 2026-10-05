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
import { appendIteration, loadIterations, openIteration, reduceIterations, summarizeRecovery } from './iterations.js'
import { observeRun, requestForWorkflow, requestRun } from './ci-request.js'
import { buildGuard } from './guard.js'
import { BOOTSTRAP_PHASE, bootstrapNextActions, bootstrapSummary } from './bootstrap.js'
import { createKernel } from './kernel.js'
import { SKILL_DESCRIPTION, SKILL_MARKDOWN, SKILL_NAME, SKILL_WHEN_TO_USE } from './skill.js'

export const name = 'delivery-assured'

/**
 * `tools` and `shell` run the scripts; `skills` publishes the runtime skill when the
 * composition has a skill registry mounted.
 */
export const inject = ['tools', 'shell', 'skills']

const AUTHORITY_NOTE =
  'Read-only entries are local diagnostics. Completion is decided by an independent execution of the frozen Required set on ' +
  'the exact candidate: by default the DSH host runs it itself (delivery_verify_independent) and retains the record, the ' +
  'gate log and the frozen-standard digests. The protected CI workflow, the authority refs and the Baseline remain the ' +
  'optional high-assurance backend. A session ending or a model answering DONE is never a completion.'

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function renderResult(result) {
  return text(result)
}

/**
 * What a Contract-dependent tool answers while a new project is still bootstrapping.
 *
 * It is a successful query, not a failure: the project is real, the lifecycle step is
 * known, and the next artifact is named. What it must never do is let a session read
 * "there is no Contract" as "there is nothing to deliver" — or, worse, let a session
 * start planning before its requirement is on the record.
 */
function bootstrapAnswer(ctxInfo, tool) {
  const bootstrap = ctxInfo.bootstrap
  if (!bootstrap || bootstrap.phase !== BOOTSTRAP_PHASE.BOOTSTRAPPING) return null
  return {
    ok: true,
    phase: 'bootstrap',
    project: ctxInfo.project.root,
    bootstrap: bootstrapSummary(bootstrap),
    next_actions: [
      '先用 delivery_iteration action=open 记录用户需求原文（首个需求不需要已有 iteration），再开始规划',
      ...bootstrapNextActions(bootstrap),
    ],
    authority: 'local_diagnostic',
    note:
      `delivery_${tool} reports delivery state, and this project has no frozen Contract yet: ` +
      `bootstrap ${bootstrap.step_index}/${bootstrap.step_count} (${bootstrap.step}) is open. ` +
      'Recompute after the Contract exists. Local output is never completion evidence.',
  }
}

export function apply(ctx, config = {}) {
  const workspace = config.workspace || process.cwd()
  // Which state every session entry reads. `durable-ref` (the default) reads the
  // authoritative `refs/heads/delivery-state/main`; `worktree` reads the working tree only,
  // for a machine that cannot reach the remote. Both choices are explicit: silently
  // switching sources is what produced two different budgets for one history.
  const stateSource = config.stateSource === 'worktree' ? 'worktree' : 'durable-ref'
  const offlineByConfig = stateSource === 'worktree'
  // Which channel resolves the ref. `auto` prefers the GitHub API through `gh`, which works
  // in the confined session shell where `git fetch` cannot (see the operation pack's
  // lib/durable-state.mjs); `git` is available for a machine without `gh`. A channel that
  // fails is reported by the script, never replaced by a working-tree answer.
  const stateTransport = ['auto', 'gh', 'git'].includes(config.stateTransport) ? config.stateTransport : 'auto'
  const stateRepo = config.stateRepo || process.env.DSH_DELIVERY_CI_REPO || null
  /** The arguments that make a session read the same source and the same channel. */
  const stateArgs = (durable) =>
    durable ? ['--durable-state', '--state-transport', stateTransport, ...(stateRepo ? ['--state-repo', stateRepo] : [])] : ['--offline']

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
        const bootstrap = bootstrapAnswer(ready.ctx, 'gaps')
        if (bootstrap) return bootstrap
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
        const bootstrap = bootstrapAnswer(ready.ctx, 'coverage')
        if (bootstrap) return bootstrap
        const argv = ['--view', args.view, ...stateArgs(offlineByConfig !== true)]
        if (args.slice) argv.push('--slice', args.slice)
        if (args.candidate) argv.push('--candidate', args.candidate)
        const result = await runScript(ready.ctx, ctx.shell, 'coverage.mjs', argv)
        return {
          ...summarize(result, {
            keep: ['view', 'candidate', 'durable_state', 'state_authority', 'state_degraded', 'state_degraded_reason', 'buckets', 'gap_classes', 'blocking', 'critical_violations'],
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
        'Rebuild the trustworthy starting point after a session change, a gap or a machine change: protected references, the durable Baseline and CI evidence, recomputed Coverage, the untouched local candidate diff, remaining budget, blockers and the next verification step. It reads `refs/heads/delivery-state/main` read-only (Baseline metadata, Evidence, the attempt ledger and the accumulated Spine live there, not in the working tree) and writes nothing; `offline: true` skips that read and says so. Run this first when resuming work. ' +
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
        const bootstrap = bootstrapAnswer(ready.ctx, 'resume')
        if (bootstrap) return bootstrap
        // A session has no CI-style state overlay. Without reading the durable state ref
        // this reports a delivered project as blocked: the attempt ledger references a
        // comparison approval, and the Baseline and Evidence, that only exist there.
        const argv = stateArgs(!(args.offline ?? offlineByConfig))
        const result = await runScript(ready.ctx, ctx.shell, 'resume.mjs', argv)
        return {
          ...summarize(result, {
            keep: ['project', 'candidate', 'candidate_source', 'dirty', 'baseline_ref', 'remote', 'local_baseline', 'durable_state', 'state_authority', 'state_authoritative', 'state_degraded', 'state_degraded_reason', 'evidence', 'verification', 'delivered', 'delivery', 'current_slice', 'owed', 'budget', 'blockers', 'notes', 'next_actions'],
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
        const bootstrap = bootstrapAnswer(ready.ctx, 'attempts')
        if (bootstrap) return bootstrap
        const argv = offlineByConfig ? [] : stateArgs(true)
        if (args.slice) argv.push('--slice', args.slice)
        const result = await runScript(ready.ctx, ctx.shell, 'attempts.mjs', argv)
        return {
          ...summarize(result, {
            keep: ['slice', 'durable_state', 'state_authority', 'state_degraded', 'state_degraded_reason', 'limits', 'counted', 'infra_aborted', 'replans', 'per_root_cause', 'progress', 'oscillation', 'critical_open', 'requires_replan', 'budget_blocked'],
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
        'Run the 5+1 Gates locally and report the diagnostic result: build, clean boot, persistence/migration, Slice acceptance, regression Spine and deployment. Exit code 0 here means only that these commands passed on this machine — it is not evidence and cannot complete a delivery. Use delivery_verify_independent for the host-executed run that does produce the record. ' +
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
        const bootstrap = bootstrapAnswer(ready.ctx, 'verify_local')
        if (bootstrap) return bootstrap
        const argv = ['--local']
        if (args.slice) argv.push('--slice', args.slice)
        if (args.candidate) argv.push('--candidate', args.candidate)
        for (const gate of args['only-gate'] || []) argv.push('--only-gate', gate)
        const result = await runScript(ready.ctx, ctx.shell, 'verify.mjs', argv, { timeoutMs: 30 * 60 * 1000 })
        return {
          ...summarize(result, { keep: ['candidate', 'parent_baseline', 'slice_id', 'mode', 'gates', 'cases', 'structural', 'blocking'] }),
          project: ready.ctx.project.root,
          reminder:
            'This is a diagnostic and cannot complete anything. Run delivery_verify_independent to have the host actually execute the frozen acceptance and record the result.',
        }
      },
    }),
  )

  // The default completion path: the host itself executes the frozen verifier and the
  // frozen Required acceptance on the exact candidate, and retains the record plus its raw
  // gate log. The agent can ask for this run and read its result; it cannot write the
  // result, choose the required cases, skip one, or mark the record PASS.
  register(
    defineTool({
      name: 'delivery_verify_independent',
      description:
        'Have the DSH host execute the frozen verifier on the current committed candidate and record the result as Evidence: build, clean boot, persistence/migration, the frozen Slice acceptance and the accumulated regression Spine all really run, with the raw output retained next to the record. This is the default way an ordinary project completes; the protected CI workflow, the authority refs and the Baseline stay available as the optional high-assurance backend. A failing run is a diagnostic that names exactly which gate and which Required case failed, so the implementation can be fixed and the run repeated, and a passing run is what makes the delivery Delivered. The frozen standard must be anchored first (freeze_standard: true records it; it must be committed, and it may only be changed with allow_standard_change). A record bound to another revision, a skipped Required case, a modified spec or a hand-written file is not a pass. ' +
        AUTHORITY_NOTE,
      parameters: {
        slice: { type: 'string', description: 'Slice id whose frozen Required cases must execute.' },
        freeze_standard: {
          type: 'boolean',
          description:
            'Record the frozen standard (Contract, project config, acceptance manifest and specs, verifier config, Slices) before running. Use it once, before implementing; afterwards the standard is immutable unless allow_standard_change is given.',
        },
        allow_standard_change: {
          type: 'boolean',
          description: 'Re-freeze an already frozen standard, recording the previous standard id in the freeze history.',
        },
        standard_change_reason: { type: 'string', description: 'Why the frozen standard is being changed (recorded verbatim).' },
        parent_baseline: { type: 'string', description: 'Baseline id the record must bind as its parent, when there is one.' },
        hypothesis: { type: 'string', description: 'The falsifiable hypothesis this attempt tests.' },
        'no-spine-accumulate': { type: 'boolean', description: 'Do not grow the regression Spine even when the run passes.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const bootstrap = bootstrapAnswer(ready.ctx, 'verify_independent')
        if (bootstrap) return bootstrap
        const shared = []
        if (args.slice) shared.push('--slice', args.slice)
        if (args.parent_baseline) shared.push('--parent-baseline', args.parent_baseline)
        if (args['no-spine-accumulate']) shared.push('--no-spine-accumulate')
        if (args.hypothesis) shared.push('--hypothesis', args.hypothesis)
        try {
          if (args.freeze_standard) {
            const freezeArgs = [...shared.filter((value) => value !== '--no-spine-accumulate')]
            if (args.allow_standard_change) freezeArgs.push('--allow-standard-change')
            if (args.standard_change_reason) freezeArgs.push('--standard-change-reason', args.standard_change_reason)
            const frozen = await runScript(ready.ctx, ctx.shell, 'verify.mjs', ['--freeze-standard', ...freezeArgs])
            if (frozen.exit_code !== 0) {
              return {
                ok: false,
                authority: 'local_diagnostic',
                stage: 'freeze_standard',
                problems: [
                  `the standard could not be frozen (exit ${frozen.exit_code}): ${(frozen.stderr || frozen.stdout || '').trim().slice(0, 400)}`,
                ],
              }
            }
          }
          const result = await runScript(
            ready.ctx,
            ctx.shell,
            'verify.mjs',
            ['--backend', 'host', '--write-evidence', ...shared],
            { timeoutMs: 60 * 60 * 1000 },
          )
          // A dispatched or observed state change must not be summarised from the boot-time render.
          kernel.invalidate()
          const payload = result.json || {}
          const passed = result.exit_code === 0 && payload.evidence_path && !(payload.blocking || []).length
          return {
            ok: passed,
            authority: 'independent_execution',
            project: ready.ctx.project.root,
            backend: 'host_executed',
            candidate: payload.candidate || null,
            run_id: payload.run_id || null,
            evidence_id: payload.evidence_id || null,
            evidence_path: payload.evidence_path || null,
            run_log: payload.run_log || null,
            freeze_standard_id: payload.freeze_standard_id || null,
            gates: payload.gates || null,
            cases: payload.cases
              ? {
                  required: payload.cases.required,
                  executed: payload.cases.executed,
                  passed: payload.cases.passed,
                  failed: payload.cases.failed,
                  skipped: payload.cases.skipped,
                }
              : null,
            structural: payload.structural || null,
            spine_accretion: payload.spine_accretion || null,
            blocking: payload.blocking || [],
            exit_code: result.exit_code,
            summary: payload.summary || null,
            next:
              passed
                ? 'Delivered: the frozen Required set passed on this exact candidate. Record it with delivery_iteration action=verified, then action=close.'
                : 'Fix the failing gate or Required case named in blocking, then run delivery_verify_independent again. Do not ask the user a routine technical question.',
            ...(passed ? {} : { stdout_tail: (result.stdout || '').trim().split('\n').slice(-25).join('\n') }),
          }
        } catch (error) {
          return { ok: false, authority: 'local_diagnostic', problems: [String(error?.message || error)] }
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
        'Open, record or read the durable iteration journal (.agent/ITERATIONS.jsonl). This is how a new session recovers the current requirement, what was already done and what blocked, without the user repeating it: action=open with the user requirement verbatim (it needs no existing iteration, so a first requirement or a next round after a delivery opens the same way), note for a decision or progress fact, verified only with an evidence reference actually observed, blocked with the concrete reason, close only when the recomputed delivery verdict is Delivered (a close attempted before that is refused and writes nothing, because a session may not declare its own completion). action=status joins the journal with the recomputed resume summary read from the same authoritative state as delivery_resume. Append-only and non-authoritative: it never writes Evidence and never advances a Baseline.',
      parameters: {
        action: {
          type: 'string',
          description: 'open: start an iteration from the user requirement. note/verified/blocked: append a fact to the current one. close: append the closed record, only when the recomputed delivery verdict is Delivered. status: read the journal plus the recomputed recovery summary.',
          enum: ['open', 'note', 'verified', 'blocked', 'close', 'status'],
          required: true,
        },
        requirement: { type: 'string', description: 'The user requirement, verbatim and complete, for action=open.' },
        detail: { type: 'string', description: 'Short factual note for action=note (decision, observed result, next step).' },
        evidence_ref: { type: 'string', description: 'The CI run, evidence id or command output actually observed, for action=verified.' },
        reason: { type: 'string', description: 'The concrete blocking condition, for action=blocked.' },
        iteration: { type: 'string', description: 'Iteration id such as IT-002; defaults to the current open iteration.' },
        offline: {
          type: 'boolean',
          description:
            'Skip reading the durable state ref and report the working tree only. The default reads it, so this summary and delivery_resume cannot disagree about the same history.',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => renderResult(value) },
      async execute(args, exec) {
        const ready = requireReady(exec)
        if (!ready.ok) return ready
        const root = ready.ctx.project.root
        if (!['open', 'note', 'verified', 'blocked', 'close', 'status'].includes(args.action)) {
          return { ok: false, problems: [`unknown action ${JSON.stringify(args.action)}; nothing was written`], authority: 'local_diagnostic' }
        }
        // `open` never needs an existing iteration: the first requirement of a project and
        // the next round of a delivered project both start from the recorded ids alone.
        const before = reduceIterations(loadIterations(root).events)
        const at = new Date().toISOString()
        try {
          if (args.action === 'open') {
            if (typeof args.requirement !== 'string' || args.requirement.trim() === '') {
              return { ok: false, problems: ['action=open requires the user requirement verbatim; nothing was written'], authority: 'local_diagnostic' }
            }
            openIteration(root, { requirement: args.requirement, at })
          } else if (args.action !== 'status') {
            const id = args.iteration || before.current?.id
            if (!id) return { ok: false, problems: ['no iteration is open; call action=open with the user requirement first'], authority: 'local_diagnostic' }
            const base = { id, at }
            if (args.action === 'note') appendIteration(root, { ...base, kind: 'noted', detail: args.detail })
            else if (args.action === 'verified') appendIteration(root, { ...base, kind: 'verified', evidence_ref: args.evidence_ref })
            else if (args.action === 'blocked') appendIteration(root, { ...base, kind: 'blocked', reason: args.reason })
            else if (args.action === 'close') {
              // A session may not declare its own delivery finished. Closing recomputes the
              // verdict through the operation pack and appends only when that verdict is
              // Delivered — a declaration, a stale record or a finished-looking summary is
              // refused, and nothing is written on refusal.
              const verdictRun = await runScript(ready.ctx, ctx.shell, 'resume.mjs', stateArgs(!(args.offline ?? offlineByConfig)))
              const verdict = verdictRun.json || null
              if (!verdict) {
                return {
                  ok: false,
                  authority: 'local_diagnostic',
                  action: 'close',
                  refused: true,
                  problems: [`the delivery verdict could not be recomputed (exit ${verdictRun.exit_code}): ${(verdictRun.stderr || verdictRun.stdout || '').trim().slice(0, 300)}; nothing was written`],
                }
              }
              if (verdict.delivered !== true) {
                const blocking = verdict.delivery?.blocking || verdict.blockers || []
                return {
                  ok: false,
                  authority: 'local_diagnostic',
                  action: 'close',
                  refused: true,
                  delivered: false,
                  problems: [`the delivery is not complete, so the iteration was not closed: ${blocking.join('; ') || 'the delivery verdict is not Delivered'}`],
                  delivery: verdict.delivery || null,
                  next:
                    'run delivery_verify_independent to have the host execute the frozen acceptance, fix what it names, and repeat; do not ask the user a routine technical question',
                }
              }
              appendIteration(root, { ...base, kind: 'closed', evidence_ref: verdict.delivery?.verification?.evidence_id || undefined })
            }
          }
        } catch (error) {
          return { ok: false, problems: [String(error?.message || error)], authority: 'local_diagnostic' }
        }
        // The journal is the first thing a session writes and the state every later answer
        // is computed from: a write invalidates the cached supervision summary so the next
        // request carries the new requirement instead of the one rendered at boot.
        if (args.action !== 'status') kernel.invalidate()
        const after = loadIterations(root)
        const nextReduced = reduceIterations(after.events)
        const unreadable = [...after.problems, ...nextReduced.problems]
        const bootstrapping = ready.ctx.bootstrap?.phase === BOOTSTRAP_PHASE.BOOTSTRAPPING
        let resume = null
        let resumeNote = null
        if (args.action === 'status' && bootstrapping) {
          // No Contract yet, so the recovery script has nothing to recompute; the bootstrap
          // step is the honest answer, and it must not look like a failed resume.
          resumeNote = 'the project is still in bootstrap, so there is no Contract-derived recovery summary yet'
        } else if (args.action === 'status') {
          // The same authoritative source `delivery_resume` uses. Reading the working tree
          // here is what made this summary report a delivered project as blocked, with a
          // budget that no other entry agreed with.
          const result = await runScript(ready.ctx, ctx.shell, 'resume.mjs', stateArgs(!(args.offline ?? offlineByConfig)))
          resume = result.json || null
          if (!resume) {
            resumeNote = `the recovery summary could not be read (exit ${result.exit_code}): ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`
          }
        }
        return {
          ok: true,
          action: args.action,
          project: root,
          iteration: nextReduced.current,
          iterations: nextReduced.iterations.length,
          unreadable_lines: unreadable.length,
          recovery: summarizeRecovery({ iterations: nextReduced, problems: unreadable, resume }),          // A new project's next move is a bootstrap step, not a verification step; the
          // entry that records the requirement is exactly where that has to be said.
          ...(ready.ctx.bootstrap
            ? { bootstrap: bootstrapSummary(ready.ctx.bootstrap), ...(bootstrapping ? { next_actions: bootstrapNextActions(ready.ctx.bootstrap) } : {}) }
            : {}),
          // The structured facts the text above is derived from, so a caller (and a test)
          // can compare this entry's numbers with `delivery_resume` instead of parsing
          // prose. `baseline` and `state_authority` are included because "the three session
          // entries agree" is exactly the question this summary must be able to answer.
          ...(args.action === 'status' && resume
            ? {
                durable_state: resume.durable_state || null,
                state_authority: resume.state_authority || null,
                budget: resume.budget || null,
                owed: resume.owed || null,
                baseline: resume.local_baseline || null,
                delivered: resume.delivered === true,
                delivery: resume.delivery || null,
                verification: resume.verification || null,
              }
            : {}),
          ...(resumeNote ? { resume_error: resumeNote } : {}),
          authority: 'local_diagnostic',
          note: 'the journal is a resumable summary, not a completion record: only an independent execution of the frozen Required set makes a delivery Delivered',
        }
      },
    }),
  )

  register(
    defineTool({
      name: 'delivery_ci',
      description:
        'Ask the platform to run one frozen workflow and report what it observed. action=request dispatches verify (with an exact frozen candidate SHA, parent baseline, Slice and falsifiable hypothesis), promote (consuming one exact completed verify run), or the two recovery entries on the same promote workflow: record-attempt (re-run the durable collector for one exact completed verify run) and resolve-diagnostic (append an owner-reviewed retention to one exact retained diagnostic). Each action sends only its own declared inputs. action=observe reads one exact run and its jobs. A request is reported as `requested` only when exactly one new run of that workflow can be attributed to it; otherwise it fails as `ambiguous` rather than naming the newest run, and is never retried blindly. Never given baseline credentials, and a requested or completed run is never reported as a promotion: only the durable collector and the promotion job make a result real.',
      parameters: {
        action: {
          type: 'string',
          description: 'request: dispatch a workflow. observe: read one exact run.',
          enum: ['request', 'observe'],
          required: true,
        },
        workflow: {
          type: 'string',
          description: 'Which frozen workflow to ask for. record-attempt and resolve-diagnostic are the two recovery entries; resolve-diagnostic needs the reviewed state SHA, a real resolution owner and confirmation reference.',
          enum: ['verify', 'promote', 'record-attempt', 'resolve-diagnostic'],
        },
        candidate: { type: 'string', description: 'Full 40-character commit SHA that was actually frozen, for workflow=verify.' },
        parent_baseline: { type: 'string', description: 'Expected parent baseline id (BL-003) or none, for workflow=verify.' },
        slice: { type: 'string', description: 'Approved Slice id from the frozen standards, for workflow=verify.' },
        hypothesis: { type: 'string', description: 'The falsifiable hypothesis this attempt tests, for workflow=verify.' },
        comparison_approval_ref: { type: 'string', description: 'Approved standard-comparison record, only when the frozen standard legitimately changed.' },
        mode: { type: 'string', description: 'Promotion entry, for workflow=promote.', enum: ['promote-baseline', 'MVP_READY'] },
        expected_parent: { type: 'string', description: 'Expected parent baseline id or none, for workflow=promote.' },
        verify_run_id: { type: 'string', description: 'Exact completed verify run id a promotion consumes, for workflow=promote, and the source run a record-attempt or resolve-diagnostic recovery consumes.' },
        verify_run_attempt: { type: 'string', description: 'Exact verify attempt number for the same uses.' },
        expected_state_sha: { type: 'string', description: 'Exact 40-character delivery-state/main SHA reviewed for the resolution, for workflow=resolve-diagnostic.' },
        resolution_owner: { type: 'string', description: 'The real reviewing actor approving the counted-failure retention, for workflow=resolve-diagnostic.' },
        resolution_confirmation: { type: 'string', description: 'The reviewed diagnostic confirmation reference, for workflow=resolve-diagnostic.' },
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
          if (args.action === 'observe') {
            const observed = await observeRun(runner, { repository, runId: args.run_id })
            kernel.invalidate()
            return { ok: true, authority: 'local_diagnostic', ...observed }
          }
          // One request per action, built from that action's own declared inputs. Passing
          // the whole argument bag sent every other action's fields as `undefined`, which
          // the whitelist rejects: `unknown verify input mode`, `unknown promote input
          // verify_run_id`. An absent field is not the same as a declared one.
          const request = requestForWorkflow(args.workflow, args, { repository })
          const result = await requestRun(runner, request)
          // A dispatched or observed run can move the durable state, so the next request's
          // supervision summary must recompute instead of repeating the boot-time reading.
          kernel.invalidate()
          // `requested` is the only status that names one run this request created. An
          // ambiguous dispatch is a failure to attribute, so it is not reported as ok.
          return {
            ok: result.status === 'requested',
            authority: 'local_diagnostic',
            ...result,
            ...(result.status === 'requested' ? {} : { problems: [result.message || 'the dispatch could not be attributed to this request'] }),
          }
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
  const kernel = installKernel(ctx, { config, workspace, resolveContext, stateTransport, stateRepo })
  const kernelInstalled = kernel.status

  // A session must be able to see what it resolved, because a wrong pack or project
  // path otherwise looks like a Contract full of gaps. Resolution is per call, so
  // this only reports the launch-time defaults.
  ctx.logger?.info?.(
    `delivery-assured ready: pack=${resolvePackRoot(config) || '(not found)'} project=${resolveProjectRoot(config, workspace).root} ` +
      `state=${stateSource}${stateSource === 'durable-ref' ? ` via ${stateTransport}${stateRepo ? ` (${stateRepo})` : ''}` : ''} ` +
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
        // A project the configuration names is protected even before it has a Contract:
        // that is exactly the bootstrap window, where the lifecycle — not the absence of a
        // Contract — decides which of the still-uncreated artifacts may be written. A
        // session in an unrelated directory (no configured project, no delivery markers
        // found) must not inherit another repository's protected paths.
        return found.source === 'workspace_default' ? null : found.root
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
function installKernel(ctx, { config, workspace, resolveContext, stateTransport = 'auto', stateRepo = null }) {
  // `ctx.get` is the service lookup on a composed host; a host that exposes the
  // service directly (or a test double) must work too, so try both instead of
  // letting an absent lookup shadow a present service.
  const looked = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : null
  const systemPrompt = looked || ctx.systemPrompt
  if (!systemPrompt || typeof systemPrompt.variable !== 'function' || typeof systemPrompt.section !== 'function') {
    return { status: 'unavailable', invalidate: () => {} }
  }
  try {
    const kernel = createKernel({
      resolveContext,
      logger: ctx.logger,
      stateSource: config.stateSource === 'worktree' ? 'worktree' : 'durable-ref',
      stateTransport,
      stateRepo,
    })
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
    // Every state-changing tool invalidates the cache, so the summary a *later* request
    // carries describes the project as it is then — no session restart, no re-read of a
    // boot-time snapshot.
    return { status: 'installed', kernel, invalidate: () => kernel.invalidate() }
  } catch (error) {
    ctx.logger?.warn?.(`delivery-assured: could not publish the delivery kernel: ${error?.message || error}`)
    return { status: 'failed', invalidate: () => {} }
  }
}




