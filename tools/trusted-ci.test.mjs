#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../packages/delivery-assured/scripts/lib/yaml.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const verify = parseYaml(readFileSync(join(repo, '.github/workflows/verify.yml'), 'utf8'))
const promote = parseYaml(readFileSync(join(repo, '.github/workflows/promote.yml'), 'utf8'))
const verifySteps = verify.jobs.verify.steps
const promotionSteps = promote.jobs['promote-baseline'].steps
let checks = 0
function check(condition, message) { assert.ok(condition, message); checks += 1 }
const artifactStep = verifySteps.findIndex(step => step.name === 'Produce artifact before deployment gate')
const gatesStep = verifySteps.findIndex(step => step.name === 'Run protected verifier without promotion credentials')
const immutableStep = verifySteps.findIndex(step => step.name === 'Check artifact bytes unchanged after evidence generation')
check(artifactStep >= 0 && artifactStep < gatesStep && immutableStep > gatesStep, 'artifact creation precedes gates and read-only check follows evidence')
check(verifySteps.filter(step => step.uses?.startsWith('actions/checkout')).every(step => step.with['persist-credentials'] === false), 'candidate execution has no persisted checkout credentials')
check(!JSON.stringify(verify).includes('BASELINE_PUSH_TOKEN'), 'verification never receives baseline credentials')
check(verifySteps[gatesStep].run.includes('canonical/packages/delivery-assured/scripts/verify.mjs') && verifySteps[gatesStep].run.includes('--project staged/project'), 'canonical verifier uses real project layout')
const download = promotionSteps.find(step => step.uses?.startsWith('actions/download-artifact'))
check(Boolean(download.with['run-id']) && Boolean(download.with['github-token']) && Boolean(download.with.repository) && download.with.name.includes('verify_run_attempt'), 'cross-run download fixes run, attempt and repository')
const provenance = promotionSteps.find(step => step.uses?.startsWith('actions/github-script'))
for (const text of ['getWorkflowRunAttempt', 'run.repository.full_name', 'run.path', 'run.event', 'run.head_branch', 'run.status', 'run.conclusion', 'run.run_attempt', 'run.head_sha']) check(provenance.with.script.includes(text), `provenance verifies ${text}`)
check(promotionSteps.every(step => !step.run?.includes('candidate/')), 'promotion never runs Candidate files')
check(verify.jobs.verify.environment !== promote.jobs['promote-baseline'].environment && promote.jobs['promote-baseline'].permissions.contents === 'read', 'machine roles use separate protected environments and baseline secret')

const work = mkdtempSync(join(tmpdir(), 'trusted-ci-fixture-'))
function git(dir, args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function run(tool, args) { const result = spawnSync(process.execPath, [join(repo, 'ci/tools', tool), ...args], { encoding: 'utf8' }); return { code: result.status, text: `${result.stdout || ''}${result.stderr || ''}` } }
try {
  const canonical = join(work, 'canonical')
  mkdirSync(canonical)
  for (const name of ['project', 'packages', 'plugins', 'tools', 'ci', '.github']) cpSync(join(repo, name), join(canonical, name), { recursive: true })
  git(canonical, ['init', '--quiet'])
  git(canonical, ['config', 'user.name', 'Fixture'])
  git(canonical, ['config', 'user.email', 'fixture@example.invalid'])
  git(canonical, ['add', '.'])
  git(canonical, ['commit', '--quiet', '-m', 'protected fixture'])
  const standardSha = git(canonical, ['rev-parse', 'HEAD'])
  const candidate = join(work, 'candidate')
  git(canonical, ['worktree', 'add', '--detach', candidate, standardSha])
  writeFileSync(join(candidate, 'project/tests/harness/run.mjs'), 'throw new Error("Candidate runner must not execute")\n')
  writeFileSync(join(candidate, 'project/scripts/verify-build.mjs'), 'throw new Error("Candidate build must not execute")\n')
  writeFileSync(join(candidate, 'project/src/fixture.mjs'), 'export const candidate = true\n')
  git(candidate, ['add', '.'])
  git(candidate, ['commit', '--quiet', '-m', 'hostile candidate surfaces'])
  const staged = join(work, 'staged')
  const stage = run('ci-stage.mjs', [canonical, candidate, canonical, staged])
  check(stage.code === 0, stage.text)
  for (const name of ['tests/harness/run.mjs', 'scripts/verify-build.mjs', 'ci/verifier.yaml', 'tests/acceptance/driver/index.mjs']) check(readFileSync(join(staged, 'project', name), 'utf8') === readFileSync(join(canonical, 'project', name), 'utf8'), `protected ${name}`)
  check(readFileSync(join(staged, 'project/src/fixture.mjs'), 'utf8').includes('candidate = true'), 'Candidate product source is staged')
  check(run('ci-stage.mjs', [canonical, candidate, canonical, staged]).code !== 0, 'staging refuses destination overwrite')
  const manifestPath = join(candidate, 'project/tests/acceptance/spec/manifest.yaml')
  writeFileSync(manifestPath, 'cases: []\n')
  git(candidate, ['add', '.'])
  git(candidate, ['commit', '--quiet', '-m', 'empty manifest'])
  const emptySha = git(candidate, ['rev-parse', 'HEAD'])
  check(run('ci-spec-diff.mjs', ['--repo', canonical, '--candidate-ref', emptySha, '--protected-ref', emptySha]).code === 1, 'equal empty acceptance manifests fail closed')
  check(run('ci-standards-diff.mjs', ['--repo', canonical, '--old-ref', 'refs/heads/missing', '--new-ref', standardSha]).code === 1, 'automatic standards bootstrap fails closed')
  check(run('ci-standards-diff.mjs', ['--repo', canonical, '--old-ref', standardSha, '--new-ref', emptySha]).code === 1, 'Required case deletion fails closed')
  const originalManifest = readFileSync(join(canonical, 'project/tests/acceptance/spec/manifest.yaml'), 'utf8')
  const append = '\n  - id: A-FIXTURE-APPEND\n    obligation_ids: [J-DELIVERY-STATUS]\n    required: true\n    method: automated\n    environments: [production_like_container]\n    assertions: [fixture_result]\n    spec_ref: tests/acceptance/spec/fixture.spec.mjs\n'
  writeFileSync(manifestPath, originalManifest + append)
  writeFileSync(join(candidate, 'project/tests/acceptance/spec/fixture.spec.mjs'), 'export function declareCases() { return [] }\n')
  git(candidate, ['add', '.'])
  git(candidate, ['commit', '--quiet', '-m', 'pure append'])
  const appendedSha = git(candidate, ['rev-parse', 'HEAD'])
  check(run('ci-standards-diff.mjs', ['--repo', canonical, '--old-ref', standardSha, '--new-ref', appendedSha]).code === 0, 'independent required case append is structurally allowed')
  writeFileSync(manifestPath, (originalManifest + append).replace('revision: 1', 'revision: 2'))
  git(candidate, ['add', '.'])
  git(candidate, ['commit', '--quiet', '-m', 'manifest metadata rewrite'])
  check(run('ci-standards-diff.mjs', ['--repo', canonical, '--old-ref', standardSha, '--new-ref', git(candidate, ['rev-parse', 'HEAD'])]).code === 1, 'manifest metadata rewrite exits automatic append')
} finally { rmSync(work, { recursive: true, force: true }) }
console.log(`trusted-ci.test ok: ${checks} offline fixture and workflow checks`)
