#!/usr/bin/env node
/**
 * New-project bootstrap lifecycle: the explicit, ordered window that replaces
 * "no Contract, so the guard is off".
 *
 * The regression this suite exists for is a real one: a greenfield delivery session wrote
 * `.agent/CONTRACT.yaml` first, and from that moment the guard refused `.agent/project.yaml`
 * and `ci/verifier.yaml` — the two files the same project needed to run anything at all,
 * because those paths are protected standards the moment the Contract exists. Protection
 * must not depend on that accident, and it must not be weakened for a project that already
 * has a Contract.
 *
 * The tool executors themselves are exercised under the hosting runtime by
 * `runtime-entry.probe.mjs` (spawned from host-resolution.test.mjs): a bare Node process
 * resolves a different helper line and registers no tool at all.
 *
 * Run: node plugins/dsh-delivery-assured/test/bootstrap-lifecycle.test.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const repoRoot = resolve(pluginRoot, '..', '..')

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

/** Create a file under an arbitrary root, making its parents first. */
function touch(root, relative, content = 'x\n') {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

const bootstrap = await import(new URL('../lib/bootstrap.js', import.meta.url).href)
const guardModule = await import(new URL('../lib/guard.js', import.meta.url).href)
const bridge = await import(new URL('../lib/bridge.js', import.meta.url).href)
const kernelModule = await import(new URL('../lib/kernel.js', import.meta.url).href)

const scratch = mkdtempSync(join(tmpdir(), 'dsh-da-bootstrap-'))
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })

const write = (relative, content = 'x\n') => touch(project, relative, content)
const remove = (relative) => rmSync(join(project, relative), { recursive: true, force: true })

try {
  /* ------------------------------------------------------------- lifecycle derivation */

  const empty = bootstrap.deriveBootstrap(project, { protectRepoMaterial: false })
  check('an empty project is in bootstrap, not protected', empty.phase === bootstrap.BOOTSTRAP_PHASE.BOOTSTRAPPING, empty.phase)
  check('the first step is the project metadata', empty.step === 'project_metadata', String(empty.step))
  check('the first step names the artifact to create', empty.next_artifact === '.agent/project.yaml', String(empty.next_artifact))
  check(
    'only the current step is writable',
    empty.writable.length === 1 && empty.writable[0].endsWith(join('.agent', 'project.yaml')),
    JSON.stringify(empty.writable),
  )
  check(
    'the documented order is the derived order',
    JSON.stringify(bootstrap.BOOTSTRAP_ORDER) ===
      JSON.stringify([
        '.agent/project.yaml',
        'ci/verifier.yaml',
        'tests/acceptance/spec',
        '.agent/slices',
        '.agent/CONTRACT.yaml',
      ]),
    JSON.stringify(bootstrap.BOOTSTRAP_ORDER),
  )

  write('.agent/project.yaml', 'project:\n  id: probe\n')
  const afterMetadata = bootstrap.deriveBootstrap(project, { protectRepoMaterial: false })
  check('creating the metadata advances the lifecycle', afterMetadata.step === 'verifier_environment', String(afterMetadata.step))
  check(
    'a completed step stays writable (a typo must not dead-end the session)',
    afterMetadata.writable.some((candidate) => candidate.endsWith(join('.agent', 'project.yaml'))),
    JSON.stringify(afterMetadata.writable),
  )

  write('ci/verifier.yaml', 'gates: []\n')
  const afterVerifier = bootstrap.deriveBootstrap(project, { protectRepoMaterial: false })
  check('creating the verifier advances the lifecycle', afterVerifier.step === 'acceptance_spec', String(afterVerifier.step))
  check(
    'the Contract is not writable before the acceptance exists',
    !afterVerifier.writable.some((candidate) => candidate.endsWith(join('.agent', 'CONTRACT.yaml'))),
    JSON.stringify(afterVerifier.writable),
  )

  write('tests/acceptance/spec/manifest.yaml', 'cases: []\n')
  const afterSpec = bootstrap.deriveBootstrap(project, { protectRepoMaterial: false })
  check('creating the frozen acceptance opens the Slice step', afterSpec.step === 'slice_declarations', String(afterSpec.step))
  check(
    'the Contract is still not writable before the round is declared',
    !afterSpec.writable.some((candidate) => candidate.endsWith(join('.agent', 'CONTRACT.yaml'))),
    JSON.stringify(afterSpec.writable),
  )

  // A Slice declaration is the input `verify` and `precheck` are given, so it is part of
  // bootstrap — and it must not be refused just because the Contract was written first.
  write('.agent/slices/S1.yaml', 'id: S1\n')
  const afterSlice = bootstrap.deriveBootstrap(project, { protectRepoMaterial: false })
  check('creating the first Slice opens the Contract step', afterSlice.step === 'contract', String(afterSlice.step))

  write('.agent/CONTRACT.yaml', 'schema_version: "0.5"\n')
  const frozen = bootstrap.deriveBootstrap(project, { protectRepoMaterial: false })
  check('the Contract freezes the lifecycle', frozen.phase === bootstrap.BOOTSTRAP_PHASE.PROTECTED, frozen.phase)
  check('and closes every bootstrap path', frozen.writable.length === 0, JSON.stringify(frozen.writable))

  // The rule that keeps a pre-existing project safe: a frozen pair (Contract + Slice) ends
  // bootstrap for good, even when an earlier artifact is missing. Otherwise "re-create the
  // project metadata" would rewrite the very file that decides which paths are protected.
  remove('.agent/project.yaml')
  const contractWithoutMetadata = bootstrap.deriveBootstrap(project, { protectRepoMaterial: false })
  check(
    'a frozen Contract is not reopened by a missing project.yaml',
    contractWithoutMetadata.phase === bootstrap.BOOTSTRAP_PHASE.PROTECTED && contractWithoutMetadata.writable.length === 0,
    `${contractWithoutMetadata.phase} ${JSON.stringify(contractWithoutMetadata.writable)}`,
  )
  write('.agent/project.yaml', 'project:\n  id: probe\n')

  // The repair this lifecycle must allow, measured on the real run that exposed it: a
  // session wrote the Contract before declaring its Slice, and the round it was about to
  // verify could no longer be declared at all.
  const contractFirst = join(scratch, 'contract-first')
  touch(contractFirst, '.agent/project.yaml', 'project:\n  id: probe\n')
  touch(contractFirst, 'ci/verifier.yaml', 'gates: []\n')
  touch(contractFirst, 'tests/acceptance/spec/manifest.yaml', 'cases: []\n')
  touch(contractFirst, '.agent/CONTRACT.yaml', 'schema_version: "0.5"\n')
  const repair = bootstrap.deriveBootstrap(contractFirst, { protectRepoMaterial: false })
  check('a Contract written before the Slice leaves the Slice step open', repair.step === 'slice_declarations' && repair.phase === bootstrap.BOOTSTRAP_PHASE.BOOTSTRAPPING, `${repair.phase} ${repair.step}`)
  check(
    'and the frozen Contract itself stays closed in that state',
    !repair.writable.some((candidate) => candidate.endsWith(join('.agent', 'CONTRACT.yaml'))),
    JSON.stringify(repair.writable),
  )
  touch(contractFirst, '.agent/slices/S1.yaml', 'id: S1\n')
  check(
    'declaring the Slice completes the bootstrap',
    bootstrap.deriveBootstrap(contractFirst, { protectRepoMaterial: false }).phase === bootstrap.BOOTSTRAP_PHASE.PROTECTED,
  )

  // A project may declare other paths; the lifecycle must not be fooled into thinking the
  // standard it protects is somewhere else.
  const declaredElsewhere = join(scratch, 'elsewhere')
  touch(declaredElsewhere, '.agent/project.yaml', 'paths:\n  contract: other/CONTRACT.yaml\n')
  const redirect = bootstrap.deriveBootstrap(declaredElsewhere, { protectRepoMaterial: false })
  check('a redirected contract path does not reopen the canonical Contract', redirect.phase === bootstrap.BOOTSTRAP_PHASE.BOOTSTRAPPING)
  touch(declaredElsewhere, '.agent/CONTRACT.yaml', 'schema_version: "0.5"\n')
  check(
    'with only a canonical Contract, the redirected project is still bootstrapping and the frozen file stays closed',
    bootstrap.deriveBootstrap(declaredElsewhere, { protectRepoMaterial: false }).phase === bootstrap.BOOTSTRAP_PHASE.BOOTSTRAPPING &&
      !bootstrap
        .deriveBootstrap(declaredElsewhere, { protectRepoMaterial: false })
        .writable.some((candidate) => candidate.endsWith(join('.agent', 'CONTRACT.yaml'))),
  )
  touch(declaredElsewhere, 'ci/verifier.yaml', 'gates: []\n')
  touch(declaredElsewhere, 'tests/acceptance/spec/manifest.yaml', 'cases: []\n')
  touch(declaredElsewhere, '.agent/slices/S1.yaml', 'id: S1\n')
  check(
    'the canonical Contract path is what ends bootstrap',
    bootstrap.deriveBootstrap(declaredElsewhere, { protectRepoMaterial: false }).phase === bootstrap.BOOTSTRAP_PHASE.PROTECTED,
  )

  /* ------------------------------------------------------------------------- the guard */

  const fresh = join(scratch, 'fresh')
  mkdirSync(fresh, { recursive: true })
  const guard = guardModule.buildGuard({
    workspace: fresh,
    resolveProject: () => fresh,
    protectRepoMaterial: true,
    repoRoot: fresh,
  })
  const deny = (exec) => guard(exec)
  const writeTool = (relative) => ({ name: 'write', arguments: { file_path: join(fresh, relative), content: 'x' } })
  const denied = (exec) => typeof deny(exec) === 'string'

  check(
    'a greenfield project still refuses Evidence and the attempt ledger',
    denied(writeTool(join('.agent', 'evidence', 'e.json'))) && denied(writeTool(join('.agent', 'attempts.jsonl'))),
  )
  check(
    'a greenfield project still refuses the authority refs',
    denied({ name: 'pwsh', arguments: { command: 'git push origin HEAD:refs/heads/baseline/main' } }),
  )
  check(
    'a greenfield project refuses a later bootstrap artifact',
    denied(writeTool(join('ci', 'verifier.yaml'))) &&
      denied(writeTool(join('.agent', 'CONTRACT.yaml'))) &&
      denied(writeTool(join('tests', 'acceptance', 'spec', 'x.spec.mjs'))),
  )
  check(
    'the refusal names the next bootstrap artifact',
    /bootstrap 1\/5/.test(String(deny(writeTool(join('ci', 'verifier.yaml'))))) &&
      /\.agent\/project\.yaml/.test(String(deny(writeTool(join('ci', 'verifier.yaml'))))),
    String(deny(writeTool(join('ci', 'verifier.yaml')))).slice(0, 200),
  )
  check('the first bootstrap artifact may be created', deny(writeTool(join('.agent', 'project.yaml'))) === undefined)
  check(
    'the refusal for an out-of-order artifact names the step that is open',
    /bootstrap 1\/5/.test(String(deny(writeTool(join('tests', 'acceptance', 'spec', 'x.spec.mjs'))))) &&
      /create \.agent\/project\.yaml first/.test(String(deny(writeTool(join('tests', 'acceptance', 'spec', 'x.spec.mjs'))))),
    String(deny(writeTool(join('tests', 'acceptance', 'spec', 'x.spec.mjs')))).slice(0, 200),
  )
  check(
    'repository material CI needs is part of the verifier step, not the metadata step',
    denied(writeTool(join('.github', 'workflows', 'verify.yml'))),
    String(deny(writeTool(join('.github', 'workflows', 'verify.yml')))).slice(0, 160),
  )

  touch(fresh, '.agent/project.yaml', 'project:\n  id: fresh\n')
  check('after the metadata, the verifier may be created', deny(writeTool(join('ci', 'verifier.yaml'))) === undefined)
  check('and the Contract may not', denied(writeTool(join('.agent', 'CONTRACT.yaml'))))
  check('and the CI material may now be created too', deny(writeTool(join('.github', 'workflows', 'verify.yml'))) === undefined)

  touch(fresh, 'ci/verifier.yaml', 'gates: []\n')
  check('after the verifier, the frozen acceptance may be created', deny(writeTool(join('tests', 'acceptance', 'spec', 'x.spec.mjs'))) === undefined)
  check('and the Contract still may not', denied(writeTool(join('.agent', 'CONTRACT.yaml'))))

  touch(fresh, 'tests/acceptance/spec/manifest.yaml', 'cases: []\n')
  check(
    'after the acceptance, the round must be declared before the Contract',
    denied(writeTool(join('.agent', 'CONTRACT.yaml'))) &&
      deny(writeTool(join('.agent', 'slices', 'S1.yaml'))) === undefined,
    String(deny(writeTool(join('.agent', 'CONTRACT.yaml')))).slice(0, 160),
  )

  touch(fresh, '.agent/slices/S1.yaml', 'id: S1\n')
  check('after the Slice, the Contract may be created', deny(writeTool(join('.agent', 'CONTRACT.yaml'))) === undefined)

  touch(fresh, '.agent/CONTRACT.yaml', 'schema_version: "0.5"\n')
  for (const relative of ['.agent/project.yaml', 'ci/verifier.yaml', '.agent/CONTRACT.yaml', 'tests/acceptance/spec/x.spec.mjs', '.github/workflows/verify.yml']) {
    check(
      `once the Contract is frozen, ${relative} is protected again`,
      denied(writeTool(relative)),
      String(deny(writeTool(relative))).slice(0, 120),
    )
  }
  check(
    'the Candidate driver surface stays writable throughout',
    deny(writeTool(join('tests', 'acceptance', 'driver', 'index.mjs'))) === undefined,
  )
  check('read-only tools are never blocked', deny({ name: 'read', arguments: { file_path: join(fresh, '.agent', 'CONTRACT.yaml') } }) === undefined)

  // A session in an unrelated directory must not be handed a protected standard to work in.
  const unrelated = guardModule.buildGuard({ workspace: scratch, resolveProject: () => null })
  check('an unrelated directory has no protected paths', unrelated(writeTool('.agent/project.yaml')) === undefined)

  /* ------------------------------------------------------------------ context + kernel */

  const greenfield = join(scratch, 'greenfield')
  mkdirSync(greenfield, { recursive: true })
  const greenfieldContext = bridge.buildContext(
    { packRoot: join(repoRoot, 'packages', 'delivery-assured'), projectRoot: greenfield },
    greenfield,
  )
  check('a configured new project is not a configuration problem', greenfieldContext.problems.length === 0, greenfieldContext.problems.join('; '))
  check('and its context carries the lifecycle', greenfieldContext.bootstrap?.step === 'project_metadata', JSON.stringify(greenfieldContext.bootstrap?.step))

  const unrelatedContext = bridge.buildContext(
    { packRoot: join(repoRoot, 'packages', 'delivery-assured') },
    join(scratch, 'nothing-here'),
  )
  check(
    'an unrelated workspace is still reported as having no delivery project',
    unrelatedContext.problems.length > 0 && unrelatedContext.bootstrap === null,
    JSON.stringify(unrelatedContext.problems),
  )

  const bootstrapKernel = kernelModule.renderBootstrapKernel(greenfieldContext.bootstrap, greenfield)
  check(
    'the bootstrap kernel says what the project is and what to do first',
    /bootstrap 1\/5/.test(bootstrapKernel) &&
      /delivery_iteration action=open/.test(bootstrapKernel) &&
      /\.agent\/project\.yaml/.test(bootstrapKernel),
    String(bootstrapKernel).slice(0, 200),
  )
  check('the bootstrap kernel keeps the trust boundary line', /不是完成凭证/.test(bootstrapKernel))
  check('an unresolvable project still says so', /未找到可检查的交付项目/.test(kernelModule.renderKernel({})))

  // The refresh rule the previous round was missing: the summary must follow the project
  // across a lifecycle change inside one session, without a restart.
  const readyProject = resolve(repoRoot, 'project')
  const resumePayload = JSON.stringify({
    project: readyProject,
    candidate: 'a'.repeat(40),
    owed: { pending_implementation: ['X'] },
    budget: { counted: 0, limits: { total_attempt_limit: 8, replan_limit: 2 }, history_known: true },
    durable_state: { requested: false, available: false },
    state_authoritative: false,
  })
  let resolvedContext = greenfieldContext
  const shellCalls = []
  const shellStub = {
    resolve: (request) => ({ ...request }),
    execute: async (spec) => {
      shellCalls.push(spec.command)
      return { exitCode: 0, stdout: { text: resumePayload }, stderr: { text: '' } }
    },
  }
  const kernel = kernelModule.createKernel({
    resolveContext: () => resolvedContext,
    stateSource: 'worktree',
  })
  await kernel.refresh(shellStub, greenfield)
  check('a new project renders the bootstrap summary, not "no project"', /bootstrap/.test(kernel.text()), kernel.text().slice(0, 120))
  check('and no recovery script was run for it', shellCalls.length === 0, shellCalls.join(' | '))

  resolvedContext = {
    packRoot: join(repoRoot, 'packages', 'delivery-assured'),
    node: { bin: process.execPath },
    project: { root: readyProject, source: 'configured' },
    bootstrap: bootstrap.deriveBootstrap(readyProject, { protectRepoMaterial: false }),
    problems: [],
  }
  check('once the Contract exists the rendered summary is known to be out of date', kernel.stale() === true)
  const before = kernel.text()
  for (let attempt = 0; attempt < 100 && kernel.text() === before; attempt += 1) {
    // The provider is synchronous by contract: the next request is what carries the update.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  check('the next request recomputes it without a session restart', kernel.text() !== before, kernel.text().slice(0, 120))
  check('and the recomputed summary is the real delivery state', /还欠:/.test(kernel.text()) && /预算:/.test(kernel.text()), kernel.text().slice(0, 200))
  check('the recovery script was run for the Contract project', shellCalls.some((command) => /resume\.mjs/.test(command)), shellCalls.join(' | '))

  kernel.invalidate()
  check('a state-changing tool call marks the summary stale again', kernel.stale() === true)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`bootstrap-lifecycle.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`bootstrap-lifecycle.test ok: ${passed} checks passed\n`)
process.exit(0)
