#!/usr/bin/env node
/**
 * verify —run the 5+1 Gates for one frozen Candidate.
 *
 * Local mode (`--local`) produces a diagnostic only: exit code 0 means "these
 * commands passed on this machine", nothing more.
 *
 * Evidence mode (`--write-evidence`, intended for the trusted CI job) additionally
 * writes `evidence.json` and requires that every required case really executed,
 * that spec/ matches the protected acceptance revision, and that the driver
 * carries no assertions. Zero tests, missing cases, skips, unexpected filters and
 * timeouts can never be reported as PASS (v0.5 §5.4, §10).
 *
 * Exit codes: 0 all required gates passed, 1 a required gate failed, 2 input/tool error.
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, unlinkSync, copyFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import {
  EXIT,
  InputError,
  abs,
  fileDigest,
  findProjectRoot,
  finish,
  git,
  gitRevision,
  listFiles,
  loadAcceptance,
  loadProjectConfig,
  loadSpine,
  parseArgs,
  readYaml,
  rel,
  sha256,
  standardBindings,
} from './lib/common.mjs'
import { loadModel, scanDriverForAssertions, specDiffAgainstProtected } from './lib/model.mjs'
import {
  EVIDENCE_GATES,
  HOST_ENVIRONMENT_KIND,
  evidenceBackendOf,
  validateEvidenceRecord,
  validateHostEvidenceRecord,
} from './lib/evidence.mjs'
import { requiredCaseIds } from './lib/selection.mjs'
import { attemptFromCI } from './lib/convergence.mjs'
import { assessMvpReady } from './lib/mvp.mjs'
import { VERIFICATION_BACKEND, resolveVerification } from './lib/verification.mjs'
import { createFreeze, freezePath, verifyFreeze } from './lib/standard-freeze.mjs'

const GATES = EVIDENCE_GATES
const GATE_ALIASES = { migration: 'persistence_migration', persistence: 'persistence_migration', acceptance: 'slice_acceptance', spine: 'regression_spine' }

/**
 * Progress text that must not corrupt `--json` output: in JSON mode stdout is the report
 * and nothing else, so a human-facing line goes to stderr instead.
 */
function noteStdout(opts, text) {
  const stream = opts?.json === true ? process.stderr : process.stdout
  stream.write(text)
}

function main() {
  const opts = parseArgs(process.argv.slice(2), {
    project: 'value',
    candidate: 'value',
    'parent-baseline': 'value',
    slice: 'value',
    'write-evidence': 'boolean',
    backend: 'value',
    'freeze-standard': 'boolean',
    'allow-standard-change': 'boolean',
    'standard-change-reason': 'value',
    'run-id': 'value',
    'log-dir': 'value',
    hypothesis: 'value',
    'no-spine-accumulate': 'boolean',
    'mvp-ready': 'boolean',
    'release-receipt': 'value',
    'out-dir': 'value',
    'ci-run-id': 'value',
    'allow-not-applicable': 'boolean',
    json: 'boolean',
    quiet: 'boolean',
    local: 'boolean',
    'only-gate': 'list',
    'protected-acceptance-dir': 'value',
  })
  if (opts.help) {
    process.stdout.write('verify —run the 5+1 Gates (--local for diagnostics, --write-evidence under trusted CI or --backend host under the DSH host)\n')
    process.stdout.write('  --freeze-standard         record the frozen standard (Contract, acceptance spec, verifier, Slices) before implementing\n')
    process.stdout.write('  --backend host            write host-executed evidence (the default completion path)\n')
    process.stdout.write('  --backend ci              write trusted-CI evidence (unchanged; requires DSH_CI_ISSUER)\n')
    return EXIT.PASS
  }

  const root = findProjectRoot(opts.project)
  const cfg = loadProjectConfig(root)
  const verification = resolveVerification(cfg)

  // ---- freeze the standard -------------------------------------------------
  // This is the anchor the host backend checks. It is a separate action so it can run
  // exactly once, before implementation, which is what makes "frozen acceptance" a fact
  // rather than a label.
  if (opts['freeze-standard']) {
    const created = createFreeze(root, cfg, verification, {
      allowStandardChange: opts['allow-standard-change'] === true,
      reason: opts['standard-change-reason'] || null,
    })
    if (!created.ok) {
      for (const problem of created.problems) process.stderr.write(`verify: ${problem}\n`)
      return EXIT.FAIL
    }
    noteStdout(
      opts,
      `frozen standard ${created.record.standard_id} at ${rel(root, created.path)} ` +
        `(${Object.keys(created.record.files).length} protected file(s), revision ${created.record.frozen_revision || '(not a git repository)'})` +
        `${created.changed ? '; the previous standard is retained in the record history' : ''}\n`,
    )
    return EXIT.PASS
  }

  const BACKEND_ALIASES = { host: VERIFICATION_BACKEND.HOST, host_executed: VERIFICATION_BACKEND.HOST, ci: VERIFICATION_BACKEND.TRUSTED_CI, trusted_ci: VERIFICATION_BACKEND.TRUSTED_CI }
  const requestedBackend = opts.backend ? BACKEND_ALIASES[String(opts.backend).trim().toLowerCase()] : null
  if (opts.backend && !requestedBackend) {
    throw new InputError(`--backend must be host or ci (got ${opts.backend})`)
  }
  const backend = requestedBackend || (opts['write-evidence'] ? VERIFICATION_BACKEND.TRUSTED_CI : null)
  // A project whose frozen policy requires platform provenance may not be completed by
  // the host backend. Refusing here is what keeps the high-assurance path honest.
  if (backend === VERIFICATION_BACKEND.HOST && verification.backend !== VERIFICATION_BACKEND.HOST) {
    throw new InputError(
      `.agent/project.yaml declares verification.backend ${JSON.stringify(verification.declared_value)}; ` +
        'a host-executed record may not stand in for it',
    )
  }
  const hostMode = backend === VERIFICATION_BACKEND.HOST

  const model = loadModel(root)
  const verifierPath = abs(root, cfg.paths.verifier)
  const verifier = readYaml(verifierPath, { required: true })
  if (!verifier || !Array.isArray(verifier.gates)) {
    throw new InputError(`verifier config ${cfg.paths.verifier} must declare a gates list`)
  }

  if (opts['mvp-ready'] && !opts.slice) throw new InputError('--mvp-ready must name the approved final Slice')
  if (opts['mvp-ready'] && !opts['write-evidence']) throw new InputError('--mvp-ready requires the trusted CI evidence run, not a local diagnostic')
  if (opts.local && opts['write-evidence']) throw new InputError('--local cannot be combined with --write-evidence')
  if (opts.local && hostMode) throw new InputError('--backend host writes evidence; it cannot be combined with --local')
  if (opts['write-evidence'] && (opts['only-gate'] || []).length > 0) throw new InputError('evidence mode cannot filter gates')
  if (opts['write-evidence'] && !hostMode && !process.env.DSH_CI_ISSUER) throw new InputError('--write-evidence requires DSH_CI_ISSUER to name the trusted verification job')
  if (hostMode && opts['mvp-ready']) throw new InputError('--mvp-ready is the trusted-CI MVP entry; the host backend completes without it')

  // The frozen standard is checked before a single gate runs: a host record that
  // executed a modified acceptance would be evidence of something nobody froze.
  let freeze = null
  if (hostMode) {
    freeze = verifyFreeze(root, cfg, verification)
    if (!freeze.ok) {
      for (const problem of freeze.problems) process.stderr.write(`verify: ${problem.code}: ${problem.message}\n`)
      return EXIT.FAIL
    }
  }

  const candidate = opts.candidate || gitRevision(root, 'HEAD')
  // `none` is how a workflow spells "this is the first Baseline". Normalise it here so
  // the evidence binding and the promotion precondition cannot disagree about the parent.
  const rawParent = opts['parent-baseline'] || process.env.DSH_PARENT_BASELINE || ''
  const parentBaseline = rawParent === '' || rawParent === 'none' ? null : rawParent
  const sliceId = opts.slice || null
  const acceptance = loadAcceptance(root, cfg)
  const spine = loadSpine(root, cfg)
  const expectedCaseIds = requiredCaseIds(model, sliceId)
  const resultPath = abs(root, verifier.acceptance?.result_file || '.agent/evidence/acceptance-results.json')
  const runToken = randomUUID()
  const runId = opts['run-id'] || (hostMode ? `host-${Date.now().toString(36)}-${runToken.slice(0, 8)}` : (opts['ci-run-id'] || process.env.DSH_CI_RUN_ID))
  const context = {
    root, cfg, model, verifier, candidate, parentBaseline, sliceId, acceptance, spine, opts,
    expectedCaseIds, resultPath, runToken, runId, hostMode, verification, freeze,
    startedAt: new Date().toISOString(),
    gateLogs: [],
    spineBefore: [...spine.caseIds],
    spineBeforeDigest: standardBindings(root, cfg).spine_manifest_digest,
  }
  // A prior green file cannot stand in for this run, even when startup fails.
  if (existsSync(resultPath)) unlinkSync(resultPath)

  // ---- structural checks that own the acceptance evidence (v0.5 §5.2) ----
  const structural = runStructuralChecks(context)

  // Host evidence binds a committed revision, so the bytes about to be tested must be
  // the bytes of that revision. The verification's own output is excluded: it is produced
  // by this run, not by the Candidate.
  let candidateClean = null
  let dirtyPaths = []
  if (hostMode) {
    const status = git(root, ['status', '--porcelain'])
    const head = gitRevision(root, 'HEAD')
    if (!status.ok) {
      structural.push({
        level: 'fail',
        code: 'CANDIDATE_NOT_INSPECTABLE',
        message: `the candidate worktree could not be inspected, so it cannot be shown to be the committed revision: ${status.err}`,
      })
    } else {
      // What the check is for: the *code and the standard* that were tested must be the
      // committed ones. The project's own state artifacts are excluded, because a session
      // legitimately writes them while it works — the iteration journal it just appended to,
      // the editable STATE hint, the attempt ledger, the accumulated Spine, the reviews and
      // standard-change records, and this verification's own output. Excluding them is not
      // a loophole: they are named in the record (`execution.host.state_excluded`) and none
      // of them carries product behaviour.
      const stateExclusions = new Set([
        '.agent/ITERATIONS.jsonl',
        '.agent/reviews.yaml',
        '.agent/STANDARD_CHANGES.yaml',
        'ci/mvp-ready.json',
        cfg.paths.attemptsLog,
        cfg.paths.state,
        cfg.paths.spineManifest,
        cfg.paths.evidenceDir,
      ].filter(Boolean).map((path) => String(path).replace(/\\/g, '/').replace(/\/+$/, '')))
      const statePrefixes = [cfg.paths.evidenceDir, '.agent/standards', 'ci/evidence', 'ci/baseline', 'ci/recording']
        .filter(Boolean)
        .map((path) => `${String(path).replace(/\\/g, '/').replace(/\/+$/, '')}/`)
      context.stateExcluded = [...stateExclusions, ...statePrefixes]
      const isState = (path) => stateExclusions.has(path) || statePrefixes.some((prefix) => path.startsWith(prefix))
      dirtyPaths = porcelainPaths(status.out).filter((path) => !isState(path))
      candidateClean = dirtyPaths.length === 0
      if (!candidateClean) {
        structural.push({
          level: 'fail',
          code: 'CANDIDATE_DIRTY',
          message: `the candidate worktree has uncommitted changes (${dirtyPaths.slice(0, 6).join(', ')}); host evidence must bind the committed revision it tested`,
        })
      }
      if (!candidate || candidate !== head) {
        structural.push({
          level: 'fail',
          code: 'CANDIDATE_NOT_HEAD',
          message: `the host verifier binds the current HEAD (${head || 'unreadable'}); it cannot attest another revision`,
        })
      }
    }
  }
  context.candidateClean = candidateClean
  context.dirtyPaths = dirtyPaths
  if (hostMode) context.attemptsDigestBefore = fileDigest(abs(root, cfg.paths.attemptsLog))

  const only = new Set((opts['only-gate'] || []).map((g) => GATE_ALIASES[g] || g))
  const gateResults = []
  for (const gateName of GATES) {
    if (only.size > 0 && !only.has(gateName)) continue
    const definition = verifier.gates.find((g) => (GATE_ALIASES[g.gate] || g.gate) === gateName)
    gateResults.push(runGate(gateName, definition, context))
  }

  if (verifier.gates.length !== GATES.length || new Set(verifier.gates.map(g => GATE_ALIASES[g.gate] || g.gate)).size !== GATES.length) {
    structural.push({ level: 'fail', code: 'GATE_SET_INVALID', message: 'verifier must declare each of the six gates exactly once' })
  }

  // ---- acceptance case accounting ----
  const caseAccounting = accountCases(context)

  const requiredGates = gateResults
  const failedGates = requiredGates.filter(g => !['passed', 'not_applicable'].includes(g.outcome) || g.undeclared)
  const notApplicable = requiredGates.filter((g) => g.outcome === 'not_applicable')
  const notApplicableWithoutReason = notApplicable.filter((g) => !g.reason || g.reason.trim() === '')
  const structuralFailures = structural.filter((s) => s.level === 'fail')
  const caseFailures = caseAccounting.problems

  const blocking = [
    ...failedGates.map((g) => ({ code: 'GATE_FAILED', message: `${g.gate}: ${g.outcome}` })),
    ...notApplicableWithoutReason.map((g) => ({ code: 'GATE_NOT_APPLICABLE_NO_REASON', message: `${g.gate} has no exclusion reason` })),
    ...structuralFailures,
    ...caseFailures,
  ]
  let code = blocking.length > 0 ? EXIT.FAIL : EXIT.PASS

  // ---- accumulated Spine (host backend) ----
  // A passing host execution is what freezes this candidate, so it is also what grows
  // the regression Spine —exactly the job the Promotion job does on the CI backend. The
  // growth is recorded inside the record it came from, and that record keeps the
  // *previous* Spine digest in its bindings, so nothing already written is rewritten.
  let spineAccretion = null
  if (hostMode && code === EXIT.PASS && blocking.length === 0) {
    spineAccretion = accumulateSpine(context, { caseAccounting })
    if (!spineAccretion.ok) {
      blocking.push({ code: 'SPINE_NOT_ACCUMULATED', message: spineAccretion.problem })
      code = EXIT.FAIL
    }
  }

  // ---- evidence ----
  let evidence = null
  let evidencePath = null
  let hostArtifacts = null
  if (opts['write-evidence']) {
    const outDir = abs(root, opts['out-dir'] || '.agent/evidence')
    mkdirSync(outDir, { recursive: true })
    const issuer = hostMode ? verification.hostIssuer : process.env.DSH_CI_ISSUER
    if (!issuer) {
      throw new InputError('--write-evidence requires DSH_CI_ISSUER to name the trusted verification job')
    }
    if (hostMode) {
      hostArtifacts = writeHostArtifacts(context, { gateResults, caseAccounting, spineAccretion })
    }
    evidence = hostMode
      ? buildHostEvidence(context, { gateResults, caseAccounting, issuer, structural, blocking, artifacts: hostArtifacts, spineAccretion })
      : buildEvidence(context, { gateResults, caseAccounting, issuer, structural, blocking })
    const integrity = evidenceBackendOf(evidence) === 'host_executed'
      ? validateHostEvidenceRecord(evidence)
      : validateEvidenceRecord(evidence)
    if (evidence.execution.result === 'PASS' && integrity.length > 0) {
      blocking.push(...integrity.map(message => ({ code: 'EVIDENCE_INCOMPLETE', message })))
      evidence.execution.result = 'FAIL'
      code = EXIT.FAIL
    }
    if (opts['mvp-ready']) {
      const receipt = opts['release-receipt'] ? JSON.parse(readFileSync(abs(root, opts['release-receipt']), 'utf8')) : null
      const readiness = assessMvpReady(model, evidence, receipt, { candidate, parentBaseline, trustedIssuer: issuer })
      evidence.execution.mvp_ready = readiness.ready
      evidence.release_receipt = receipt
      if (!readiness.ready) {
        blocking.push(...readiness.blocking.map(message => ({ code: 'MVP_NOT_READY', message })))
        evidence.execution.result = 'FAIL'
        code = EXIT.FAIL
      }
    }
    evidence.blocking = [...blocking]
    if (!runId || !/^[A-Za-z0-9_.:-]+$/.test(runId)) throw new InputError('evidence mode needs a valid fixed run id')
    evidencePath = join(outDir, hostMode ? `evidence-${runId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json` : `evidence-${runId}.json`)
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    if (hostArtifacts) {
      // The receipt is rewritten with the final evidence digest so the retained run can
      // be re-checked against the record that was accepted, not against a draft.
      const receipt = {
        ...hostArtifacts.receipt,
        // `evidence_ref`, not `evidence_id`: the receipt is a run artifact inside the
        // evidence directory and must never be loaded as a record of its own.
        evidence_ref: evidence.evidence_id,
        evidence_path: rel(root, evidencePath),
        evidence_digest: fileDigest(evidencePath),
        result: evidence.execution.result,
      }
      writeFileSync(hostArtifacts.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
      // The attempt history is real on this backend too: on the CI path the collector
      // records it, here the verifier does. It is appended, never rewritten — a failing
      // record stays in the ledger exactly as it was written, so the budget and the
      // recovery report describe what actually happened instead of an unknown history.
      appendAttemptRecord(context, evidence, { hostArtifacts })
    }
    noteStdout(opts, `wrote ${rel(root, evidencePath)} with result ${evidence.execution.result}` +
        (evidence.execution.result === 'PASS'
          ? hostMode
            ? `; retained execution log ${evidence.execution.run_log}\n`
            : '; promotion remains the Promotion job\'s decision.\n'
          : '; a non-PASS record is retained as evidence of the failure, never as a pass.\n'))  }

  const human = []
  human.push(`candidate: ${candidate || '(no git revision)'}   parent baseline: ${parentBaseline || '(none)'}`)
  human.push('')
  for (const gate of gateResults) {
    const marker = gate.outcome === 'passed' ? 'PASS' : gate.outcome === 'not_applicable' ? 'N/A ' : gate.undeclared ? 'MISS' : 'FAIL'
    human.push(
      `${marker} ${pad(gate.gate, 22)} ${gate.outcome === 'passed' || gate.outcome === 'failed' ? `${gate.duration_ms}ms` : gate.reason || ''}`,
    )
    if (gate.exit_code !== null && gate.exit_code !== 0 && gate.command) {
      human.push(`     command: ${gate.command}`)
    }
  }
  human.push('')
  human.push(
    `cases: ${caseAccounting.executed}/${caseAccounting.required} required executed, ` +
      `${caseAccounting.passed} passed, ${caseAccounting.failed} failed, ${caseAccounting.skipped} skipped`,
  )
  for (const problem of [...structuralFailures, ...caseFailures]) {
    human.push(`BLOCK ${problem.code}: ${problem.message}`)
  }
  human.push('')
  human.push(
    opts['write-evidence']
      ? hostMode
        ? `host-executed evidence written for ${verification.hostIssuer}; the record, its gate log and the frozen standard ` +
          `(${freeze?.record?.standard_id || '(none)'}) are retained under .agent/evidence.`
        : `evidence written for issuer ${process.env.DSH_CI_ISSUER}; promotion remains the Promotion job's decision.`
      : 'note: local run. This is a diagnostic; it is not evidence and cannot advance a Baseline.',
  )
  if (hostMode) {
    human.push('note: this backend observed no packaged deployment and no runtime isolation; that limitation is recorded, not assumed away.')
  }

  return finish({
    code,
    script: 'verify',
    summary:
      blocking.length === 0
        ? `${gateResults.filter(g => g.outcome === 'passed').length} gates passed, ${notApplicable.length} not applicable, ${caseAccounting.executed} required cases executed`
        : `${blocking.length} blocking problem(s)`,
    human,
    json: {
      project: root,
      candidate,
      parent_baseline: parentBaseline,
      slice_id: sliceId,
      mode: opts['write-evidence'] ? 'evidence' : 'local_diagnostic',
      verification_backend: hostMode ? VERIFICATION_BACKEND.HOST : opts['write-evidence'] ? VERIFICATION_BACKEND.TRUSTED_CI : null,
      run_id: runId || null,
      gates: gateResults,
      cases: caseAccounting,
      structural,
      blocking,
      evidence_path: evidencePath,
      evidence_id: evidence?.evidence_id || null,
      ...(hostMode
        ? {
            freeze_standard_id: freeze?.record?.standard_id || null,
            run_log: hostArtifacts ? rel(root, hostArtifacts.logPath) : null,
            spine_accretion: spineAccretion ? { added: spineAccretion.added || [], after: spineAccretion.after || [] } : null,
          }
        : {}),
    },
    color: !opts.quiet,
    jsonRequested: opts.json === true,
  })
}

function pad(text, width) {
  const s = String(text)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

/* --------------------------------------------------------------- structural */

function runStructuralChecks(context) {
  const { root, opts, acceptance, model, hostMode, freeze } = context
  const out = []

  if (hostMode) {
    // The host backend has no protected `standards/acceptance` ref; the freeze record is
    // the anchor instead, and it was already checked before any gate ran. Reporting it as
    // an informational note keeps the record's structural notes a complete account.
    for (const problem of freeze?.problems || []) {
      out.push({ level: 'fail', code: problem.code, message: problem.message })
    }
    if (freeze?.record) {
      out.push({
        level: 'info',
        code: 'STANDARD_FROZEN',
        message:
          `frozen standard ${freeze.record.standard_id} at revision ${freeze.record.frozen_revision || '(not a git repository)'} ` +
          `(${Object.keys(freeze.record.files || {}).length} protected file(s), manifest revision ${freeze.record.manifest_revision ?? '(none)'})`,
      })
    }
  } else {
    const protectedDir = opts['protected-acceptance-dir'] || process.env.DSH_PROTECTED_ACCEPTANCE_DIR
    if (protectedDir) {
      const diff = specDiffAgainstProtected(root, abs(root, protectedDir))
      if (!diff.available) {
        out.push({ level: 'fail', code: 'PROTECTED_ACCEPTANCE_UNAVAILABLE', message: diff.reason })
      }
      for (const entry of diff.diffs) {
        out.push({
          level: 'fail',
          code: 'SPEC_DIFF',
          message: `tests/acceptance/spec/${entry.path} is ${entry.kind} relative to the protected acceptance revision`,
        })
      }
    } else if (opts['write-evidence']) {
      out.push({
        level: 'fail',
        code: 'PROTECTED_ACCEPTANCE_UNAVAILABLE',
        message: 'evidence mode requires DSH_PROTECTED_ACCEPTANCE_DIR or --protected-acceptance-dir to verify the frozen spec',
      })
    } else {
      out.push({
        level: 'warn',
        code: 'PROTECTED_ACCEPTANCE_NOT_CHECKED',
        message: 'protected acceptance revision not provided; local run cannot prove the spec is frozen',
      })
    }
  }

  const driverFindings = scanDriverForAssertions(root)
  for (const finding of driverFindings) {
    out.push({
      level: 'fail',
      code: 'DRIVER_ASSERTION',
      message: `tests/acceptance/driver/${finding.file.split('/').pop()}:${finding.line} contains ${finding.match}`,
    })
  }

  const manifestRev = process.env.DSH_ACCEPTANCE_REVISION || process.env.DSH_STANDARD_REVISION
  if (opts['write-evidence'] && !hostMode && !/^[0-9a-f]{40}$/.test(manifestRev || '')) {
    out.push({
      level: 'fail',
      code: 'ACCEPTANCE_NOT_FROZEN',
      message: 'tests/acceptance/spec/manifest.yaml has no protected_revision; the standard was not frozen before implementation',
    })
  }

  if (model.spine.caseIds.length === 0) {
    out.push({
      level: 'warn',
      code: 'EMPTY_SPINE',
      message: 'the regression spine is empty; after Baseline #0 the CI accumulates every verified case here',
    })
  }

  // A case may not select only the easy subset: every required case must be planned.
  for (const testCase of acceptance.cases) {
    if (testCase.required === true && testCase.method === 'automated' && !testCase.spec_ref) {
      out.push({ level: 'fail', code: 'CASE_NO_SPEC', message: `required case ${testCase.id} has no spec_ref` })
    }
  }
  return out
}

/* -------------------------------------------------------------------- gates */

function runGate(gateName, definition, context) {
  const { root, opts } = context
  if (!definition) {
    return {
      gate: gateName,
      outcome: 'not_run',
      reason: 'gate not declared in the verifier config',
      command: null,
      exit_code: null,
      duration_ms: 0,
      undeclared: true,
      exclusion: null,
    }
  }
  if (definition.excluded === true) {
    return {
      gate: gateName,
      outcome: 'not_applicable',
      reason: definition.reason || '',
      command: null,
      exit_code: null,
      duration_ms: 0,
      exclusion: 'declared',
    }
  }
  const command = typeof definition.command === 'string' ? definition.command : null
  if (!command) {
    return {
      gate: gateName,
      outcome: 'not_run',
      reason: 'gate declared without a command; an empty execution is not a pass',
      command: null,
      exit_code: null,
      duration_ms: 0,
      exclusion: null,
    }
  }
  // A gate the frozen verifier config marks `local: skip` is one only the protected CI
  // job can observe. The host backend reports it as an explicit exclusion (and records
  // that it observed nothing there) instead of pretending it ran.
  if (definition.local === 'skip' && (!opts['write-evidence'] || context.hostMode)) {
    return {
      gate: gateName,
      outcome: 'not_applicable',
      reason:
        definition.reason ||
        `declared CI-only in the frozen verifier config: ${String(definition.description || '').trim().slice(0, 200) || 'this backend cannot observe it'}`,
      command,
      exit_code: null,
      duration_ms: 0,
      exclusion: 'ci_only',
    }
  }

  const started = Date.now()
  const env = {
    ...process.env,
    DSH_GATE: gateName,
    DSH_CANDIDATE: context.candidate || '',
    ...(definition.env || {}),
    DSH_PARENT_BASELINE: context.parentBaseline || '',
    DSH_VERIFICATION_RUN_TOKEN: context.runToken,
    DSH_REQUIRED_CASE_IDS: JSON.stringify(context.expectedCaseIds),
  }
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh'
  const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command]
  const result = spawnSync(shell, shellArgs, {
    cwd: definition.workdir ? abs(root, definition.workdir) : root,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: definition.timeout_ms || 20 * 60 * 1000,
  })
  const duration = Date.now() - started
  // In `--json` mode stdout must stay parseable JSON — a caller that has to strip gate
  // chatter before parsing is a caller that will eventually parse the wrong thing. The
  // gate output is still shown (on stderr) and still retained in the log, so nothing is
  // lost for a human reading a CI job.
  const emit = opts.json === true ? process.stderr : process.stdout
  if (result.stdout) emit.write(result.stdout)
  if (result.stderr) emit.write(result.stderr)
  recordGateOutput(context, { gate: gateName, command, duration, result })
  if (result.error) {
    return {
      gate: gateName,
      outcome: 'failed',
      reason: `could not execute: ${result.error.message}`,
      command,
      exit_code: null,
      duration_ms: duration,
      exclusion: null,
    }
  }
  if (result.signal) {
    return {
      gate: gateName,
      outcome: 'failed',
      reason: `terminated by ${result.signal} (timeout or cancellation is not a pass)`,
      command,
      exit_code: result.status,
      duration_ms: duration,
      exclusion: null,
    }
  }
  return {
    gate: gateName,
    outcome: result.status === 0 ? 'passed' : 'failed',
    reason: result.status === 0 ? '' : `exit code ${result.status}`,
    command,
    exit_code: result.status,
    duration_ms: duration,
    exclusion: null,
  }
}

/**
 * Keep the raw output of every gate that really ran. The retained log is what makes
 * "the verifier executed this" checkable after the fact instead of being a summary.
 */
function recordGateOutput(context, { gate, command, duration, result }) {
  const lines = []
  lines.push(`===== gate ${gate} =====`)
  lines.push(`command : ${command}`)
  lines.push(`exit    : ${result.error ? `could not execute: ${result.error.message}` : result.status}`)
  lines.push(`signal  : ${result.signal || 'none'}`)
  lines.push(`duration: ${duration}ms`)
  lines.push('--- stdout ---')
  lines.push(String(result.stdout ?? ''))
  lines.push('--- stderr ---')
  lines.push(String(result.stderr ?? ''))
  lines.push('')
  context.gateLogs.push(lines.join('\n'))
}

/* ------------------------------------------------------------- case results */

/**
 * Read the harness result file and compare it against the required set, the
 * frozen manifest and the parent Baseline's Spine. Missing, skipped, extra or
 * unknown cases are blocking.
 */
export function accountCases(context) {
  const { root, verifier, acceptance, spine, model, sliceId } = context
  const reportPath = verifier.acceptance?.result_file
    ? abs(root, verifier.acceptance.result_file)
    : abs(root, '.agent/evidence/acceptance-results.json')
  const problems = []
  const expectedIds = context.expectedCaseIds || requiredCaseIds(model, sliceId)
  const expected = new Set(expectedIds)
  const empty = {
    required: expected.size, expected_ids: expectedIds, executed: 0, passed: 0, failed: 0, skipped: 0, results: [], report: rel(root, reportPath),
    problems: [{ code: 'NO_RESULT_FILE', message: `acceptance result file not found: ${rel(root, reportPath)}` }],
  }
  if (!existsSync(reportPath)) return empty
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (error) {
    return { ...empty, problems: [{ code: 'RESULT_FILE_INVALID', message: `${rel(root, reportPath)} is not valid JSON: ${error.message}` }] }
  }
  if (!context.runToken || report.run_token !== context.runToken) {
    problems.push({ code: 'STALE_RESULT_FILE', message: 'acceptance results are not bound to this verification invocation' })
  }
  const results = Array.isArray(report.results) ? report.results : []
  const byId = new Map()
  for (const entry of results) {
    if (!entry || typeof entry.case_id !== 'string') {
      problems.push({ code: 'INVALID_CASE_RESULT', message: 'case result has no id' })
      continue
    }
    if (byId.has(entry.case_id)) problems.push({ code: 'DUPLICATE_CASE_RESULT', message: `case ${entry.case_id} has multiple results` })
    byId.set(entry.case_id, entry)
  }
  if (results.length === 0 || expected.size === 0) problems.push({ code: 'ZERO_TESTS', message: 'zero tests are never a pass' })
  const unknown = [...byId.keys()].filter(id => !expected.has(id))
  for (const id of unknown) {
    problems.push({ code: 'UNKNOWN_CASE_EXECUTED', message: `case ${id} ran but is not in the manifest or the spine` })
  }

  if (report.filter) {
    problems.push({
      code: 'UNEXPECTED_FILTER',
      message: `the harness reported an active filter (${JSON.stringify(report.filter)}); a filtered run cannot prove the full set`,
    })
  }
  if (report.timed_out === true) {
    problems.push({ code: 'RUN_TIMED_OUT', message: 'the acceptance run reported a timeout; a partial run is not a pass' })
  }
  if (report.spec_revision && acceptance.manifest?.revision && report.spec_revision !== acceptance.manifest.revision) {
    problems.push({
      code: 'MANIFEST_REVISION_MISMATCH',
      message: `harness ran manifest revision ${report.spec_revision} but the frozen manifest is ${acceptance.manifest.revision}`,
    })
  }
  for (const id of expected) {
    if (!byId.has(id)) {
      problems.push({ code: 'REQUIRED_CASE_NOT_EXECUTED', message: `required case ${id} produced no result` })
    }
  }
  for (const caseId of spine.caseIds) {
    if (!byId.has(caseId)) {
      problems.push({ code: 'SPINE_CASE_NOT_EXECUTED', message: `spine case ${caseId} produced no result` })
    }
  }


  let passed = 0
  let failed = 0
  let skipped = 0
  const caseResults = []
  for (const [id, entry] of byId) {
    const outcome = String(entry.outcome || 'errored')
    if (outcome === 'passed') passed += 1
    else if (outcome === 'skipped' || outcome === 'not_run') skipped += 1
    else failed += 1
    caseResults.push({ case_id: id, outcome, duration_ms: entry.duration_ms ?? null, message: entry.message || '' })
    if (outcome !== 'passed') {
      problems.push({ code: 'CASE_NOT_PASSED', message: `case ${id} recorded ${outcome}` })
    }
  }

  return {
    required: expected.size,
    expected_ids: expectedIds,
    executed: byId.size,
    passed,
    failed,
    skipped,
    results: caseResults,
    report: rel(root, reportPath),
    problems,
  }
}

/* ----------------------------------------------------------------- evidence */

export function buildEvidence(context, { gateResults, caseAccounting, issuer, structural, blocking = [] }) {
  const { root, cfg, model, candidate, parentBaseline, sliceId, acceptance, spine } = context
  const bindings = standardBindings(root, cfg)
  const verifierDigest = bindings.verifier_config_digest
  const imageDigest = process.env.DSH_IMAGE_DIGEST || ''
  const deploymentId = process.env.DSH_DEPLOYMENT_ID || null
  const deployedRevision = process.env.DSH_DEPLOYED_CODE_REVISION || null
  const requiredCaseIds = caseAccounting.expected_ids || context.expectedCaseIds
  const caseResults = requiredCaseIds.map(case_id => {
    const observed = caseAccounting.results.filter(r => r.case_id === case_id)
    if (observed.length === 0) return { case_id, outcome: 'not_run', duration_ms: 0 }
    if (observed.length > 1 || !['passed', 'failed', 'errored', 'skipped', 'not_run'].includes(observed[0].outcome)) return { case_id, outcome: 'errored', message: 'ambiguous or invalid observed result' }
    return observed[0]
  })
  const executed = caseResults.filter(r => !['skipped', 'not_run'].includes(r.outcome)).length
  const started = context.startedAt
  const standardRevision = process.env.DSH_ACCEPTANCE_REVISION || process.env.DSH_STANDARD_REVISION || null
  return {
    evidence_id: `${issuer}:${context.opts['ci-run-id'] || process.env.DSH_CI_RUN_ID || Date.now()}`,
    convergence: {
      hypothesis: context.opts.hypothesis || process.env.DSH_HYPOTHESIS || `Candidate satisfies the frozen acceptance of Slice ${sliceId || 'MVP'}`,
      root_cause_key: process.env.DSH_ROOT_CAUSE_KEY || blocking[0]?.code || structural.find(s => s.level === 'fail')?.code || gateResults.find(g => g.outcome === 'failed')?.gate || 'fixed-candidate-verification',
      slice_key: model.slices.find(s => s.id === sliceId)?.slice_key || sliceId || 'MVP',
      ...(process.env.DSH_COMPARISON_APPROVAL_REF ? { comparison_approval_ref: process.env.DSH_COMPARISON_APPROVAL_REF } : {}),
    },
    scope: {
      slice_id: sliceId || 'MVP',
      slice_key: model.slices.find(s => s.id === sliceId)?.slice_key || sliceId || 'MVP',
      obligation_ids: [
        ...new Set(
          acceptance.cases
            .filter((c) => requiredCaseIds.includes(c.id))
            .flatMap((c) => [...(c.obligation_ids || []), ...(c.outcome_ids || [])]),
        ),
      ],
      required_case_ids: requiredCaseIds,
    },
    bindings: {
      code_revision: candidate,
      contract_revision: process.env.DSH_CONTRACT_REVISION || standardRevision,
      contract_digest: bindings.contract_digest,
      acceptance_revision: standardRevision,
      acceptance_manifest_digest: bindings.acceptance_manifest_digest,
      acceptance_digest: bindings.acceptance_digest,
      verifier_config_revision: process.env.DSH_VERIFIER_REVISION || null,
      verifier_config_digest: verifierDigest,
      dependency_lock_digest: bindings.dependency_lock_digest,
      migration_digest: bindings.migration_digest,
      spine_manifest_digest: bindings.spine_manifest_digest,
      slice_manifest_digest: bindings.slice_manifest_digest,
      parent_baseline: parentBaseline || null,
    },
    environment: {
      kind: process.env.DSH_ENVIRONMENT_KIND || 'production_like_ci',
      image_digest: imageDigest,
      config_fingerprint: process.env.DSH_CONFIG_FINGERPRINT || '',
      fixture_revision: process.env.DSH_FIXTURE_REVISION || '',
      deployment_id: deploymentId,
      deployed_code_revision: deployedRevision,
      deployed_image_digest: process.env.DSH_DEPLOYED_IMAGE_DIGEST || null,
    },
    execution: {
      ci_run_id: context.opts['ci-run-id'] || process.env.DSH_CI_RUN_ID || 'unknown',
      started_at: started,
      finished_at: new Date().toISOString(),
      result: blocking.length === 0 && structural.every(s => s.level !== 'fail') && caseAccounting.problems.length === 0 && caseAccounting.failed === 0 && caseAccounting.skipped === 0 && caseAccounting.required > 0 && caseAccounting.executed === caseAccounting.required && gateResults.length === GATES.length && gateResults.every(g => !g.undeclared && (g.outcome === 'passed' && g.exit_code === 0 || g.outcome === 'not_applicable' && g.reason?.trim()))
        ? 'PASS'
        : 'FAIL',
      required_cases: caseAccounting.required,
      executed_cases: executed,
      skipped_required_cases: caseResults.filter(r => ['skipped', 'not_run'].includes(r.outcome)).length,
      case_results: caseResults,
      gate_results: gateResults.map((g) => ({
        gate: g.gate,
        outcome: g.outcome,
        reason: g.reason || '',
        command: g.command || '',
        exit_code: g.exit_code,
        duration_ms: g.duration_ms,
        undeclared: g.undeclared === true,
        exclusion: g.exclusion || null,
      })),
      artifacts: [caseAccounting.report].filter(Boolean),
    },
    issuer: { identity: issuer },
    structural_notes: structural.map((s) => `${s.level}:${s.code}:${s.message}`),
    spine_manifest_digest: bindings.spine_manifest_digest,
    spine_case_ids: spine.caseIds,
  }
}

/* ---------------------------------------------------------- host backend */

/**
 * Write the retained execution artifacts of a host-executed run.
 *
 * One directory per run holds the complete gate log (the raw stdout/stderr of every
 * gate that executed), an immutable copy of the harness result file, and a receipt
 * naming the run token, the evidence digests and the standard that was frozen. That
 * is what makes the record re-checkable later instead of a summary of a summary.
 */
export function writeHostArtifacts(context, { gateResults, caseAccounting, spineAccretion }) {
  const { root, runId } = context
  const dir = abs(root, join('.agent/evidence/runs', runId))
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'verify.log')
  const header = [
    'host-executed independent verification',
    `run_id     : ${runId}`,
    `run_token  : ${context.runToken}`,
    `candidate  : ${context.candidate}`,
    `slice      : ${context.sliceId || 'MVP'}`,
    `started    : ${context.startedAt}`,
    `finished   : ${new Date().toISOString()}`,
    `runner     : node ${process.version} on ${process.platform} ${process.arch}`,
    `standard   : ${context.freeze?.record?.standard_id || '(unfrozen)'}`,
    `required   : ${caseAccounting.required} case(s), ${caseAccounting.passed} passed`,
    `gates      : ${gateResults.map((gate) => `${gate.gate}=${gate.outcome}${gate.exclusion ? `(${gate.exclusion})` : ''}`).join(' ')}`,
    `spine      : ${spineAccretion && spineAccretion.added?.length ? `+${spineAccretion.added.length}` : 'unchanged'}`,
    '',
  ]
  writeFileSync(logPath, `${[...header, ...context.gateLogs].join('\n')}\n`, 'utf8')
  const resultSource = context.resultPath
  const resultCopyPath = join(dir, 'acceptance-results.json')
  if (existsSync(resultSource)) copyFileSync(resultSource, resultCopyPath)
  const receiptPath = join(dir, 'receipt.json')
  const receipt = {
    runner: 'dsh-host-verifier',
    run_id: runId,
    run_token: context.runToken,
    candidate: context.candidate,
    slice_id: context.sliceId || 'MVP',
    started_at: context.startedAt,
    finished_at: new Date().toISOString(),
    node_version: process.version,
    platform: `${process.platform} ${process.arch}`,
    standard: {
      freeze_standard_id: context.freeze?.record?.standard_id ?? null,
      frozen_revision: context.freeze?.record?.frozen_revision ?? null,
      committed_verified: context.freeze?.committed_verified === true,
    },
    gates: gateResults.map((gate) => ({
      gate: gate.gate,
      outcome: gate.outcome,
      exit_code: gate.exit_code,
      exclusion: gate.exclusion || null,
      duration_ms: gate.duration_ms,
    })),
    required_cases: caseAccounting.required,
    executed_cases: caseAccounting.executed,
    passed_cases: caseAccounting.passed,
    case_results: caseAccounting.results,
    gate_log: rel(root, logPath),
    gate_log_digest: null,
    acceptance_results_copy: rel(root, resultCopyPath),
    spine: spineAccretion ? { added: spineAccretion.added || [], after: spineAccretion.after || [] } : null,
  }
  const logDigest = fileDigest(logPath)
  receipt.gate_log_digest = logDigest
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return {
    dir,
    logPath,
    logDigest,
    receiptPath,
    receipt,
    resultCopyPath,
    resultDigest: existsSync(resultSource) ? fileDigest(resultSource) : null,
  }
}

/**
 * Grow the accumulated Spine with the cases this candidate really passed.
 *
 * The Spine only ever grows: a case that was in it and did not pass blocks the run
 * instead of being dropped. The pre-growth Spine is kept in the record, so the record
 * that caused the growth is not judged stale by its own effect.
 */
export function accumulateSpine(context, { caseAccounting }) {
  const { root, cfg, opts, runId } = context
  const before = [...context.spineBefore]
  if (opts['no-spine-accumulate']) return { ok: true, skipped: true, added: [], before, after: before }
  const verified = caseAccounting.results.filter((entry) => entry.outcome === 'passed').map((entry) => entry.case_id)
  const missing = before.filter((id) => !verified.includes(id))
  if (missing.length > 0) {
    return { ok: false, problem: `the accumulated Spine case(s) ${missing.join(', ')} did not pass; the Spine only grows and this run lost coverage` }
  }
  const after = [...new Set([...before, ...verified])].sort()
  if (after.length === before.length) return { ok: true, added: [], before, after }
  const spinePath = abs(root, cfg.paths.spineManifest)
  mkdirSync(dirname(spinePath), { recursive: true })
  writeFileSync(
    spinePath,
    `last_updated: ${JSON.stringify(new Date().toISOString())}\nupdated_by: ${JSON.stringify(runId)}\ncase_ids: ${JSON.stringify(after)}\n`,
    'utf8',
  )
  return { ok: true, added: after.filter((id) => !before.includes(id)), before, after, path: rel(root, spinePath) }
}

/**
 * Build a host-executed record.
 *
 * Identical case and gate accounting to the CI record —the same Required set, the same
 * exactly-once PASS rule, the same refusal to skip —plus the positive statements about
 * what this backend could not observe, and the digests of the retained execution.
 */
export function buildHostEvidence(context, { gateResults, caseAccounting, issuer, structural, blocking = [], artifacts, spineAccretion = null }) {
  const { root, cfg, model, candidate, parentBaseline, sliceId, acceptance, spine, verification, freeze } = context
  const bindings = { ...standardBindings(root, cfg), spine_manifest_digest: context.spineBeforeDigest }
  const requiredIds = caseAccounting.expected_ids || context.expectedCaseIds
  const caseResults = requiredIds.map((case_id) => {
    const observed = caseAccounting.results.filter((r) => r.case_id === case_id)
    if (observed.length === 0) return { case_id, outcome: 'not_run', duration_ms: 0 }
    if (observed.length > 1 || !['passed', 'failed', 'errored', 'skipped', 'not_run'].includes(observed[0].outcome)) {
      return { case_id, outcome: 'errored', message: 'ambiguous or invalid observed result' }
    }
    return observed[0]
  })
  const executed = caseResults.filter((r) => !['skipped', 'not_run'].includes(r.outcome)).length
  const frozenRevision = freeze?.record?.frozen_revision || null
  const gateOk =
    gateResults.length === GATES.length &&
    gateResults.every(
      (g) =>
        !g.undeclared &&
        ((g.outcome === 'passed' && g.exit_code === 0) ||
          (g.outcome === 'not_applicable' && ['declared', 'ci_only'].includes(g.exclusion) && g.reason?.trim())),
    )
  const result =
    blocking.length === 0 &&
    structural.every((s) => s.level !== 'fail') &&
    caseAccounting.problems.length === 0 &&
    caseAccounting.failed === 0 &&
    caseAccounting.skipped === 0 &&
    caseAccounting.required > 0 &&
    caseAccounting.executed === caseAccounting.required &&
    gateOk
      ? 'PASS'
      : 'FAIL'
  const spineAfter = spineAccretion?.after ?? [...(spine.caseIds || [])]
  return {
    evidence_id: `${issuer}:${context.runId}`,
    convergence: {
      hypothesis: context.opts.hypothesis || process.env.DSH_HYPOTHESIS || `Candidate satisfies the frozen acceptance of Slice ${sliceId || 'MVP'}`,
      root_cause_key:
        process.env.DSH_ROOT_CAUSE_KEY ||
        blocking[0]?.code ||
        structural.find((s) => s.level === 'fail')?.code ||
        gateResults.find((g) => g.outcome === 'failed')?.gate ||
        'fixed-candidate-verification',
      slice_key: model.slices.find((s) => s.id === sliceId)?.slice_key || sliceId || 'MVP',
    },
    scope: {
      slice_id: sliceId || 'MVP',
      slice_key: model.slices.find((s) => s.id === sliceId)?.slice_key || sliceId || 'MVP',
      obligation_ids: [
        ...new Set(
          acceptance.cases
            .filter((c) => requiredIds.includes(c.id))
            .flatMap((c) => [...(c.obligation_ids || []), ...(c.outcome_ids || [])]),
        ),
      ],
      required_case_ids: requiredIds,
    },
    bindings: {
      code_revision: candidate,
      contract_revision: frozenRevision,
      contract_digest: bindings.contract_digest,
      acceptance_revision: frozenRevision,
      acceptance_manifest_digest: bindings.acceptance_manifest_digest,
      acceptance_digest: bindings.acceptance_digest,
      verifier_config_revision: frozenRevision,
      verifier_config_digest: bindings.verifier_config_digest,
      dependency_lock_digest: bindings.dependency_lock_digest,
      migration_digest: bindings.migration_digest,
      spine_manifest_digest: bindings.spine_manifest_digest,
      slice_manifest_digest: bindings.slice_manifest_digest,
      parent_baseline: parentBaseline || null,
    },
    environment: {
      kind: HOST_ENVIRONMENT_KIND,
      backend: 'host_executed',
      // The environment identity must describe the *environment*, never this run. The
      // comparison identity of an attempt is derived from it, so a per-run value would
      // make every host run look like "the standard changed": the no-progress window
      // would fill up with identical passes and eventually demand a Replan that is not
      // needed. Platform, architecture and runtime version are what actually differ.
      config_fingerprint: `host:${process.platform}-${process.arch}-node${process.version}`,
      fixture_revision: null,
      observed: { deployment: false, runtime_isolation: false, container: false },
      not_observed: [
        'a packaged deployment or an installed artifact (the host backend runs the frozen candidate in place)',
        'runtime isolation between the verifier and the candidate (no container or namespace proof exists here)',
        `gate(s) the frozen verifier config declares CI-only: ${gateResults.filter((g) => g.outcome === 'not_applicable').map((g) => g.gate).join(', ') || 'none'}`,
      ],
      host: { platform: process.platform, arch: process.arch, node: process.version },
    },
    execution: {
      ci_run_id: context.runId,
      run_id: context.runId,
      run_log: artifacts ? rel(root, artifacts.logPath) : null,
      started_at: context.startedAt,
      finished_at: new Date().toISOString(),
      result,
      required_cases: caseAccounting.required,
      executed_cases: executed,
      skipped_required_cases: caseResults.filter((r) => ['skipped', 'not_run'].includes(r.outcome)).length,
      case_results: caseResults,
      gate_results: gateResults.map((g) => ({
        gate: g.gate,
        outcome: g.outcome,
        reason: g.reason || '',
        command: g.command || '',
        exit_code: g.exit_code,
        duration_ms: g.duration_ms,
        undeclared: g.undeclared === true,
        exclusion: g.exclusion || null,
      })),
      artifacts: [caseAccounting.report, artifacts ? rel(root, artifacts.logPath) : null].filter(Boolean),
      host: {
        runner: 'dsh-host-verifier',
        run_token: context.runToken,
        log_digest: artifacts?.logDigest || '',
        result_file_digest: artifacts?.resultDigest || '',
        node_version: process.version,
        platform: `${process.platform} ${process.arch}`,
        gate_exit_codes: Object.fromEntries(gateResults.map((g) => [g.gate, g.exit_code])),
        candidate_clean: context.candidateClean === true,
        candidate_clean_note:
          context.candidateClean === true
            ? 'the candidate worktree carried no uncommitted change before this run; the verification output is excluded'
            : `uncommitted changes were present: ${(context.dirtyPaths || []).join(', ')}`,
        dirty_paths: context.dirtyPaths || [],
        // Named so a reader can see exactly which paths were treated as state rather than
        // as candidate material.
        state_excluded: context.stateExcluded || [],
        // The attempt ledger is appended to after this record is built, so the digest
        // before the append is what this run's bindings describe.
        attempts_ledger_before: context.attemptsDigestBefore ?? null,
      },
      spine: {
        before: context.spineBefore,
        before_digest: context.spineBeforeDigest,
        after: spineAfter,
        added: spineAccretion?.added || [],
        manifest: spineAccretion?.path || null,
      },
    },
    standards: {
      freeze_path: rel(root, freezePath(root, verification)),
      freeze_standard_id: freeze?.record?.standard_id ?? null,
      frozen_revision: frozenRevision,
      manifest_revision: freeze?.record?.manifest_revision ?? null,
      committed_verified: freeze?.committed_verified === true,
      drift: freeze?.drift || [],
      protected_files: Object.keys(freeze?.record?.files || {}).length,
    },
    issuer: { identity: issuer },
    structural_notes: structural.map((s) => `${s.level}:${s.code}:${s.message}`),
    spine_manifest_digest: bindings.spine_manifest_digest,
    spine_case_ids: context.spineBefore,
  }
}

/**
 * The paths in `git status --porcelain` output.
 *
 * The format is `XY <path>`, where the two status characters may be spaces (` M` is an
 * unstaged modification). A naive "strip a letter and a space" leaves the status letter
 * on the path, which silently un-matches every exclusion and reported
 * `M tests/spine/manifest.yaml` as a candidate change.
 */
export function porcelainPaths(output) {
  const paths = []
  for (const raw of String(output || '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    let rest = line.length > 2 && line[2] === ' ' ? line.slice(3) : line.replace(/^[A-Z?!]{1,2}\s+/, '')
    const arrow = rest.indexOf(' -> ')
    if (arrow !== -1) rest = rest.slice(arrow + 4)
    rest = rest.trim()
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1)
    if (rest !== '') paths.push(rest.replace(/\\/g, '/'))
  }
  return paths
}

/**
 * Append one attempt line for a host-executed run.
 *
 * The ledger is the project's attempt history: it is what makes the budget, the
 * no-progress window and the same-root-cause count real across sessions. A host run is
 * an attempt like any other, so it is recorded — appended, never rewritten, and a FAIL
 * is recorded as a FAIL. The caller's `--record`/write paths are untouched: this is the
 * verifier's own bookkeeping, not an entry point for a session to declare anything.
 */
export function appendAttemptRecord(context, evidence, { hostArtifacts } = {}) {
  const { root, cfg, model, verification } = context
  const path = abs(root, cfg.paths.attemptsLog)
  let attempt
  try {
    attempt = attemptFromCI(evidence, model, {}, { acceptedIssuers: verification.acceptedIssuers })
  } catch (error) {
    // A record whose accounting is inconsistent must not corrupt the ledger; the run is
    // already FAIL and the reason is reported through the evidence blocking list.
    return { ok: false, problem: String(error?.message || error) }
  }
  const line = `${JSON.stringify(attempt)}\n`
  try {
    if (hostArtifacts) {
      writeFileSync(join(hostArtifacts.dir, 'attempt.json'), `${JSON.stringify(attempt, null, 2)}\n`, 'utf8')
    }
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line, 'utf8')
  } catch (error) {
    return { ok: false, problem: String(error?.message || error) }
  }
  return { ok: true, attempt_id: attempt.attempt_id, result: attempt.result }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    if (error instanceof InputError) {
      process.stderr.write(`verify: ${error.message}\n`)
      process.exitCode = EXIT.ERROR
    } else {
      process.stderr.write(`verify: unexpected error: ${error?.stack || error}\n`)
      process.exitCode = EXIT.ERROR
    }
  }
}
