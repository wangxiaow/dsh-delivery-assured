import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateFixtureTarget, validatePromotionReceipt, isolationWarnings } from '../ci/tools/ci-trust.mjs'

const sha = 'a'.repeat(40)
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'fixture/repo', DSH_DEFAULT_BRANCH: 'main', DSH_VERIFY_RUN_ID: '1-2', DSH_VERIFIER_REVISION: sha }
const image = `sha256:${'b'.repeat(64)}`
const record = { execution: { ci_run_id: '1-2' }, bindings: { code_revision: sha, verifier_config_revision: sha, acceptance_revision: sha }, environment: { image_digest: image } }
const receipt = {
  repository: 'fixture/repo', path: '.github/workflows/verify.yml', event: 'workflow_dispatch',
  head_branch: 'main', status: 'completed', conclusion: 'success', run_id: 1, run_attempt: 2, head_sha: sha,
  isolation: { verified: true, candidate_can_write_control_plane: false, candidate_has_promotion_credentials: false, verification_surface_readonly: true, execution_id: 'fixture-executor', candidate_revision: sha, verifier_revision: sha, standard_revision: sha, image_digest: image },
}
let checks = 0
assert.deepEqual(validatePromotionReceipt(receipt, record, env), []); checks++
assert.ok(validatePromotionReceipt(receipt, record, {}).length > 0); checks++
assert.ok(validatePromotionReceipt(null, record, env).length > 0); checks++
for (const mutate of [
  r => { r.repository = 'fixture/other' }, r => { r.event = 'pull_request' },
  r => { r.head_branch = 'candidate' }, r => { r.run_attempt = 1 }, r => { r.head_sha = 'b'.repeat(40) },
  r => { r.conclusion = 'failure' },
]) {
  const changed = structuredClone(receipt); mutate(changed)
  assert.ok(validatePromotionReceipt(changed, record, env).length > 0); checks++
}
assert.deepEqual(isolationWarnings(receipt, record), []); checks++
// Runtime isolation has no producer, so it is recorded as a warning rather than
// blocking: every one of these mutations must leave the promotion unblocked and
// still be visible to whoever reads the promotion metadata.
for (const mutate of [
  r => { delete r.isolation }, r => { r.isolation.verified = false }, r => { r.isolation.candidate_can_write_control_plane = true },
  r => { r.isolation.candidate_has_promotion_credentials = true }, r => { r.isolation.verification_surface_readonly = false },
  r => { r.isolation.candidate_revision = 'c'.repeat(40) }, r => { r.isolation.verifier_revision = 'c'.repeat(40) },
  r => { r.isolation.standard_revision = 'c'.repeat(40) }, r => { r.isolation.image_digest = `sha256:${'c'.repeat(64)}` },
]) {
  const changed = structuredClone(receipt); mutate(changed)
  assert.deepEqual(validatePromotionReceipt(changed, record, env), [], 'isolation must not block promotion'); checks++
  assert.ok(isolationWarnings(changed, record).length > 0, 'isolation gap must still be recorded'); checks++
}
const work = mkdtempSync(join(tmpdir(), 'trust-target-fixture-'))
try {
  const repo = join(work, 'repo'), bare = join(work, 'remote.git')
  mkdirSync(repo); mkdirSync(bare); mkdirSync(join(bare, 'objects')); writeFileSync(join(bare, 'HEAD'), 'fixture')
  assert.doesNotThrow(() => validateFixtureTarget(repo, bare, {})); checks++
  assert.throws(() => validateFixtureTarget(repo, 'https://example.invalid/repo.git', {})); checks++
  assert.throws(() => validateFixtureTarget(repo, bare, { GITHUB_ACTIONS: 'true' })); checks++
  assert.throws(() => validateFixtureTarget(process.cwd(), bare, {})); checks++
} finally { rmSync(work, { recursive: true, force: true }) }
console.log(`ci-trust.test ok: ${checks} checks passed`)
