/**
 * The agent-facing tool surface, as data.
 *
 * Every parameter schema DSH projects to the model provider lives here, and
 * `host.js` registers these exact objects. Keeping the surface in one pure module
 * is not cosmetic: it is what makes "which switches a session can reach" a fact a
 * test can assert without a hosting runtime, and the reason `no-spine-accumulate`
 * had to be deleted rather than merely hidden.
 *
 * The rule this file exists to keep:
 *
 *   A parameter that can weaken the verdict a Candidate is judged by —
 *   the Required set, the regression Spine, evidence validity, backend
 *   authority, the Delivered predicate or the frozen TCB — is not part of
 *   this surface. It belongs to the control plane (the frozen verifier
 *   configuration and the maintenance flow that promotes a new TCB).
 *
 * The `execute` bodies stay in `host.js`; nothing here decides anything. Each
 * tool's description is deliberately explicit about what it cannot do.
 */

/** One tool's parameter schema, exactly as the provider receives it. */
export const TOOL_PARAMETERS = Object.freeze({
  delivery_gaps: {
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

  delivery_coverage: {
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

  delivery_resume: {
    offline: {
      type: 'boolean',
      description: 'Skip reading remote protected references and say so, instead of failing.',
    },
  },

  delivery_attempts: {
    slice: { type: 'string', description: 'Limit the report to one Slice.' },
  },

  delivery_verify_local: {
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

  /**
   * The completion entry point. There is deliberately no switch here that can
   * suppress Spine accumulation, relax the Required set, pick the backend's
   * observed capabilities, or move the frozen TCB: a PASS always grows the
   * regression Spine with every case it really verified, and a standard that
   * drifted is refused instead of re-frozen.
   */
  delivery_verify_independent: {
    slice: { type: 'string', description: 'Slice id whose frozen Required cases must execute.' },
    freeze_standard: {
      type: 'boolean',
      description:
        'Record the frozen standard (Contract, project config, acceptance manifest and specs, verifier config, Slices, and the verifier Trusted Computing Base) before running. Use it once, before implementing; afterwards the standard is immutable unless allow_standard_change is given.',
    },
    allow_standard_change: {
      type: 'boolean',
      description:
        'Re-freeze an already frozen standard, recording the previous standard id in the freeze history. It cannot re-freeze a changed verifier Trusted Computing Base; that is a separate maintenance flow, not a Candidate action.',
    },
    standard_change_reason: { type: 'string', description: 'Why the frozen standard is being changed (recorded verbatim).' },
    parent_baseline: { type: 'string', description: 'Baseline id the record must bind as its parent, when there is one.' },
    hypothesis: { type: 'string', description: 'The falsifiable hypothesis this attempt tests.' },
  },

  delivery_iteration: {
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

  delivery_ci: {
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
})

/** The tool names this plugin registers, in registration order. */
export const AGENT_TOOL_NAMES = Object.freeze(Object.keys(TOOL_PARAMETERS))

/**
 * Parameter names that may never appear on the agent surface.
 *
 * A substring test, not an equality test: `no-spine-accumulate`,
 * `spine_accumulate`, `skip-spine` and any later spelling of "do not grow the
 * Spine" all match. The point is the capability, not the identifier.
 */
export const FORBIDDEN_AGENT_PARAMETER = /spine|tcb|deliver|required.set|no-.*accumulat/i

/**
 * The audited verdict for one tool: which declared parameter, if any, tries to
 * reach a switch a Candidate may not hold. Returns one entry per offending
 * parameter so a test can name it instead of reporting "something matched".
 */
export function forbiddenParameters(parameters = TOOL_PARAMETERS) {
  const findings = []
  for (const [tool, spec] of Object.entries(parameters || {})) {
    for (const [name, definition] of Object.entries(spec || {})) {
      if (FORBIDDEN_AGENT_PARAMETER.test(name)) findings.push({ tool, parameter: name, kind: 'name' })
      const description = typeof definition?.description === 'string' ? definition.description : ''
      if (/no-spine-accumulate|disable .{0,20}spine|do not grow the regression spine|without .{0,20}spine accumulation/i.test(description)) {
        findings.push({ tool, parameter: name, kind: 'description' })
      }
    }
  }
  return findings
}
