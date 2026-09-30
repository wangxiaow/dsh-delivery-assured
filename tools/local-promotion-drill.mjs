#!/usr/bin/env node
/**
 * Local end-to-end exercise of the CI chain: verify 鈫?evidence 鈫?promote.
 *
 * It exists because the real remote is not reachable from this machine. It proves
 * the promotion *logic* and the evidence binding rules on a local bare repository.
 *
 * What this can prove: the gates run, evidence is written with matching bindings,
 * the promotion preconditions are enforced, and the protected ref moves only when
 * every condition holds.
 *
 * What this cannot prove: platform-level branch protection, approval rules, the
 * separation of machine identities, or the real trusted-issuer boundary. A local
 * bare repository is not a protected remote. Report the difference; never present a
 * green local run as a promoted Baseline.
 *
 * Run: node tools/local-promotion-drill.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const projectSrc = join(repoRoot, 'project')
const packRoot = join(repoRoot, 'packages', 'delivery-assured')
/** CI tooling lives at the repository root, beside the project it verifies. */
const ciTools = join(repoRoot, 'ci', 'tools')
const promoteTool = join(ciTools, 'ci-promote.mjs')

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

function git(cwd, args, { allowFailure = false, env = {} } = {}) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim() }
  } catch (error) {
    if (!allowFailure) throw error
    return { ok: false, out: (error.stdout || '').trim(), err: (error.stderr || '').trim() || error.message }
  }
}

function runNode(cwd, script, args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    })
    return { ok: true, code: 0, out }
  } catch (error) {
    return { ok: false, code: typeof error.status === 'number' ? error.status : 1, out: String(error.stdout || ''), err: String(error.stderr || '') }
  }
}

const work = mkdtempSync(join(tmpdir(), 'dapse-drill-'))
const bare = join(work, 'protected-remote.git')
const clone = join(work, 'project')

try {
  // ---- 1. A bare repository stands in for the protected remote ----------------
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '--bare', '--initial-branch=main'])
  check('bare remote initialised', existsSync(join(bare, 'HEAD')))

  // ---- 2. A fresh clone of the real project is the candidate ------------------
  mkdirSync(clone, { recursive: true })
  // Copy the project working tree (no .git: the drill starts from a clean history).
  cpSync(projectSrc, clone, {
    recursive: true,
    filter: (src) => !src.includes(`${join(projectSrc, '.git')}`) && !src.includes(`${join('.agent', 'evidence')}`),
  })
  // The project imports the shipped operation pack through a relative path, exactly
  // as the real repository layout does; reproduce that layout in the drill. The DSH
  // plugin ships beside the pack, so it is copied too and the build gate runs its
  // suites here as well.
  // The fixture must reproduce the repository's top-level layout, because the build
  // gate resolves its own paths from the repository root. Copying only the pack was a
  // real defect: the gate then reported a missing test file instead of running it.
  for (const dir of ['packages', 'plugins', 'tools', 'ci', '.github']) {
    const source = join(repoRoot, dir)
    if (existsSync(source)) cpSync(source, join(work, dir), { recursive: true })
  }
  git(clone, ['init', '--initial-branch=main'])
  git(clone, ['config', 'user.email', 'drill@example.invalid'])
  git(clone, ['config', 'user.name', 'Promotion Drill'])
  git(clone, ['remote', 'add', 'origin', bare])
  git(clone, ['add', '-A'])
  git(clone, ['commit', '-q', '-m', 'candidate for the promotion drill'])
  const candidate = git(clone, ['rev-parse', 'HEAD']).out
  git(clone, ['push', '-q', 'origin', 'main'])
  check('candidate pushed to the stand-in remote', candidate.length === 40, candidate)

  // ---- 3. Freeze the acceptance standard on its own protected ref -------------
  git(clone, ['push', '-q', 'origin', 'main:refs/heads/standards/acceptance'])
  const protectedSha = git(bare, ['rev-parse', 'refs/heads/standards/acceptance']).out
  check('protected acceptance ref created on the remote', protectedSha === candidate, protectedSha)
  // A workflow checks out the canonical revision, so the ref is local there too.
  git(clone, ['update-ref', 'refs/heads/standards/acceptance', protectedSha])

  // ---- 4. Structural checks before any verification --------------------------
  const specDiff = runNode(clone, join(ciTools, 'ci-spec-diff.mjs'), [
    '--repo', clone,
    '--candidate-ref', candidate,
    '--protected-ref', 'refs/heads/standards/acceptance',
    '--json',
  ])
  check('spec diff passes against the protected standard', specDiff.code === 0, specDiff.err || specDiff.out)
  check('spec diff reports identical', /"status": "identical"/.test(specDiff.out), specDiff.out.slice(0, 200))

  // ---- 5. Evidence mode refuses without a trusted issuer ---------------------
  const noIssuer = runNode(clone, join(packRoot, 'scripts', 'verify.mjs'), [
    '--project', clone, '--candidate', candidate, '--write-evidence', '--out-dir', '.agent/evidence',
  ], { DSH_CI_ISSUER: '' })
  check('evidence mode refuses without a trusted issuer', noIssuer.code === 2, `exit ${noIssuer.code}`)
  check('the refusal explains what is missing', /DSH_CI_ISSUER/.test(noIssuer.err || ''), (noIssuer.err || '').slice(0, 200))

  // ---- 6. Verification with the trusted issuer writes evidence ---------------
  // The protected checkout carries the same path shape the verifier expects, and
  // DSH_PROTECTED_ACCEPTANCE_DIR points at the spec directory itself — the same
  // contract the CI workflow uses.
  const protectedDir = join(work, 'protected')
  mkdirSync(join(protectedDir, 'tests', 'acceptance'), { recursive: true })
  cpSync(join(clone, 'tests', 'acceptance', 'spec'), join(protectedDir, 'tests', 'acceptance', 'spec'), { recursive: true })
  cpSync(join(clone, 'tests', 'spine'), join(protectedDir, 'tests', 'spine'), { recursive: true })
  const protectedSpecDir = join(protectedDir, 'tests', 'acceptance', 'spec')
  void protectedSpecDir

  // The deployment gate needs observed values. Produce them the way the workflow
  // does — by building the artifact and reading back its real revision and digest —
  // instead of handing the gate a value this script invented. A hardcoded identity
  // here would make the gate self-proving and the drill would prove nothing.
  const artifact = runNode(clone, join(ciTools, 'verify-artifact.mjs'), ['--project', clone])
  check('the artifact producer succeeds', artifact.code === 0, (artifact.err || artifact.out).slice(-300))
  const artifactEnv = {}
  for (const line of artifact.out.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) artifactEnv[m[1]] = m[2]
  }
  check(
    'the artifact producer reports a code revision and a digest',
    Boolean(artifactEnv.DSH_DEPLOYED_CODE_REVISION) && /^sha256:[0-9a-f]{64}$/.test(artifactEnv.DSH_IMAGE_DIGEST || ''),
    JSON.stringify({ rev: artifactEnv.DSH_DEPLOYED_CODE_REVISION, digest: artifactEnv.DSH_IMAGE_DIGEST }),
  )
  check(
    'the observed revision is the candidate under test',
    artifactEnv.DSH_DEPLOYED_CODE_REVISION === candidate,
    `${artifactEnv.DSH_DEPLOYED_CODE_REVISION} vs ${candidate}`,
  )

  const verified = runNode(clone, join(work, 'packages', 'delivery-assured', 'scripts', 'verify.mjs'), [
    '--project', clone,
    '--candidate', candidate,
    '--slice', 'S1',
    '--ci-run-id', 'drill-1',
    '--write-evidence',
    '--out-dir', '.agent/evidence',
  ], {
    DSH_CI_ISSUER: 'ci:verify',
    DSH_CI_RUN_ID: 'drill-1',
    DSH_CONFIG_FINGERPRINT: 'drill-config',
    DSH_FIXTURE_REVISION: 'drill-fixtures',
    // Everything the deployment gate reads comes from the artifact producer above.
    ...artifactEnv,
    DSH_PROTECTED_ACCEPTANCE_DIR: protectedSpecDir,
  })
  check('verification passes on the frozen candidate', verified.code === 0, (verified.err || verified.out).slice(-600))

  const evidencePath = join(clone, '.agent', 'evidence', 'evidence-drill-1.json')
  check('evidence file was written', existsSync(evidencePath))
  const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null
  check('evidence records a PASS', evidence?.execution?.result === 'PASS', String(evidence?.execution?.result))
  check('evidence binds the candidate', evidence?.bindings?.code_revision === candidate)
  check('evidence names the trusted issuer', evidence?.issuer?.identity === 'ci:verify', String(evidence?.issuer?.identity))
  check('evidence records every required case', (evidence?.execution?.executed_cases ?? 0) === (evidence?.execution?.required_cases ?? -1),
    `${evidence?.execution?.executed_cases}/${evidence?.execution?.required_cases}`)
  check('evidence records no skipped required case', evidence?.execution?.skipped_required_cases === 0)

  // ---- 7. Promotion refuses a mismatched parent ------------------------------
  const wrongParent = runNode(clone, promoteTool, [
    '--project', clone,
    '--evidence-dir', '.agent/evidence',
    '--expected-parent', 'BL-999',
    '--protected-baseline-ref', 'refs/heads/baseline/main',
    '--dry-run',
  ])
  check('promotion refuses a mismatched parent baseline', wrongParent.code === 1, `exit ${wrongParent.code}`)
  check('the refusal names the parent binding', /parent/i.test(wrongParent.err || ''), (wrongParent.err || '').slice(0, 300))

  // ---- 8. Promotion reports ready for the correct parent ---------------------
  // An empty --expected-parent means "no parent": the same normalisation a workflow
  // performs when it spells the first Baseline as `none`.
  const ready = runNode(clone, promoteTool, [
    '--project', clone,
    '--evidence-dir', '.agent/evidence',
    '--expected-parent', '',
    '--protected-baseline-ref', 'refs/heads/baseline/main',
    '--dry-run',
  ])
  check('promotion reports ready on a matching parent', ready.code === 0, (ready.err || ready.out).slice(0, 400))
  check('a baseline id was assigned', /BL-\d{3}/.test(ready.out), ready.out.slice(0, 200))
  check('no protected ref was moved during the dry run', git(bare, ['rev-parse', '--verify', 'refs/heads/baseline/main'], { allowFailure: true }).ok === false)

  // ---- 9. Promotion applies, then the ref exists -----------------------------
  const applied = runNode(clone, promoteTool, [
    '--project', clone,
    '--evidence-dir', '.agent/evidence',
    '--expected-parent', '',
    '--protected-baseline-ref', 'refs/heads/baseline/main',
    '--apply',
  ], { DSH_CI_RUN_ID: 'drill-promote-1' })
  check('promotion applied', applied.code === 0, (applied.err || applied.out).slice(0, 400))

  const remoteBaseline = git(bare, ['rev-parse', '--verify', 'refs/heads/baseline/main'], { allowFailure: true })
  check('the protected baseline ref now exists on the remote', remoteBaseline.ok, remoteBaseline.err || '')
  check('the protected ref points at the verified candidate', remoteBaseline.out === candidate, `${remoteBaseline.out} vs ${candidate}`)

  const metadataDir = join(clone, 'ci', 'baseline')
  const metadataFiles = existsSync(metadataDir) ? readdirSync(metadataDir).filter((f) => f.endsWith('.json')) : []
  const metadata = metadataFiles.length > 0 ? JSON.parse(readFileSync(join(metadataDir, metadataFiles[0]), 'utf8')) : null
  check('baseline metadata was persisted', metadata !== null, metadataFiles.join(', ') || 'ci/baseline is empty')
  check('metadata binds the same candidate', metadata?.code_revision === candidate)
  check(
  'metadata records the evidence reference',
  (metadata?.evidence_refs || []).some((r) => /^ci:verify:/.test(String(r))),
  JSON.stringify(metadata?.evidence_refs),
)
  check('metadata records the parent baseline', metadata?.parent_baseline === null, String(metadata?.parent_baseline))
  check('metadata states what remains unverified', Array.isArray(metadata?.verification_scope?.remaining_outcomes))
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`local-promotion-drill: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`local-promotion-drill ok: ${passed} checks passed\n`)
process.stdout.write(
  'note: this proves the promotion logic and the evidence binding rules on a local bare\n' +
    '      repository. It does NOT prove platform branch protection, approval rules, machine\n' +
    '      identity separation, or the real trusted-issuer boundary.\n',
)
process.exit(0)

