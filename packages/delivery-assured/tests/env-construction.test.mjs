#!/usr/bin/env node
/**
 * Explicit environment construction for verification and test subprocesses.
 *
 * The defect this suite closes: a subprocess environment built as
 * `{ ...process.env, ...env }`. Under a GitHub Actions verification job the ambient
 * environment carries `DSH_CI_ISSUER`, `DSH_STANDARD_REVISION`, `DSH_IMAGE_DIGEST`
 * and the deployment identity, so a Host-backend run and a Host-shaped test could
 * silently acquire the authority of the CI job they merely happened to run inside —
 * and the same test would mean something different on a laptop.
 *
 * The fix is an allowlist, not a blacklist: a minimal platform base, plus whatever
 * the frozen verifier configuration or the test scenario declares by name. This
 * suite proves both halves — that ambient authority does not arrive, and that an
 * explicitly declared variable does.
 *
 * Run: node packages/delivery-assured/tests/env-construction.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  RUNNER_SIGNAL_KEYS,
  SAFE_BASE_ENV_KEYS,
  buildBaseEnv,
  fixtureEnv,
  gateEnv,
  isInheritedByDefault,
} from '../scripts/lib/env.mjs'
import {
  hostVerify,
  makeProject,
  cleanup,
  packRoot,
  run,
  verifyScript,
} from './helpers/host-project.mjs'

/**
 * The variables a trusted-verification CI job would hand a subprocess. Names only —
 * nothing here grants anything, which is exactly the point: presence in an ambient
 * environment must not be a capability.
 */
const AMBIENT_AUTHORITY = {
  DSH_CI_ISSUER: 'ci:verify',
  DSH_STANDARD_REVISION: 'f'.repeat(40),
  DSH_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
  DSH_DEPLOYMENT_ID: 'ci-run-deployment',
  DSH_DEPLOYED_CODE_REVISION: 'f'.repeat(40),
  DSH_CONFIG_FINGERPRINT: 'ci-fingerprint',
  DSH_PARENT_BASELINE: 'BL-003',
  GITHUB_TOKEN: 'secret',
  GH_TOKEN: 'secret',
  NODE_OPTIONS: '--require evil.cjs',
}

/** A stand-in ambient map for the pure-function cases (never used to spawn). */
const POLLUTED_AMBIENT = { PATH: '/usr/bin', HOME: '/home/runner', TEMP: '/tmp', ...AMBIENT_AUTHORITY }

/** The only DSH_* names a verifier gate may see: its declared inputs. */
const VERIFIER_GATE_INPUTS = new Set([
  'DSH_GATE',
  'DSH_CANDIDATE',
  'DSH_PARENT_BASELINE',
  'DSH_VERIFICATION_RUN_TOKEN',
  'DSH_REQUIRED_CASE_IDS',
])

test('the base environment is an allowlist: no DSH_*, no CI authority, no token', () => {
  for (const key of SAFE_BASE_ENV_KEYS) {
    assert.ok(
      !/^DSH_/i.test(key) && !/^GITHUB_|^GH_|^CI$/i.test(key) && !/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key),
      `${key} must not carry verification authority`,
    )
  }
  for (const signal of RUNNER_SIGNAL_KEYS) assert.ok(isInheritedByDefault(signal), `${signal} must be a documented passthrough`)
})

test('buildBaseEnv keeps the platform runtime keys and drops every authority variable', () => {
  const env = buildBaseEnv(POLLUTED_AMBIENT)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/runner')
  assert.equal(env.TEMP, '/tmp')
  for (const key of Object.keys(POLLUTED_AMBIENT)) {
    if (SAFE_BASE_ENV_KEYS.includes(key)) continue
    assert.equal(Object.hasOwn(env, key), false, `${key} leaked into the base environment`)
  }
})

test('gateEnv forwards only what the frozen verifier configuration declares', () => {
  const declared = { DSH_ALLOWED: '$DSH_ALLOWED', DSH_LITERAL: 'fixed' }
  const env = gateEnv(declared, { ambient: { ...POLLUTED_AMBIENT, DSH_ALLOWED: 'declared-value' } })
  assert.equal(env.DSH_ALLOWED, 'declared-value')
  assert.equal(env.DSH_LITERAL, 'fixed')
  // Ambient authority is absent unless declared, and an undeclared forward resolves to
  // nothing rather than to whatever the parent happened to hold.
  assert.equal(env.DSH_CI_ISSUER, undefined)
  assert.equal(env.DSH_IMAGE_DIGEST, undefined)
  assert.equal(env.GH_TOKEN, undefined)
  assert.equal(gateEnv({ DSH_MISSING: '$DSH_MISSING' }, { ambient: POLLUTED_AMBIENT }).DSH_MISSING, undefined)
})

test('fixtureEnv is the scenario, not a patch on the ambient environment', () => {
  const env = fixtureEnv({ DSH_CI_ISSUER: 'ci:verify' }, { ambient: POLLUTED_AMBIENT })
  assert.equal(env.DSH_CI_ISSUER, 'ci:verify')
  assert.equal(env.DSH_IMAGE_DIGEST, undefined)
  assert.equal(env.PATH, '/usr/bin')
})

test('a Host verification run does not inherit the ambient CI authority', () => {
  const { root } = makeProject()
  const probe = join(root, '..', `gate-probe-${process.pid}-${Date.now()}.jsonl`)
  try {
    const result = run(
      [verifyScript, '--project', root, '--backend', 'host', '--write-evidence', '--slice', 'S1', '--json'],
      root,
      {
        // The platform base plus the authority variables: exactly what a CI job's
        // process would carry, without breaking the runtime this test needs.
        ...buildBaseEnv(),
        ...AMBIENT_AUTHORITY,
        NODE_OPTIONS: '',
        DSH_GATE_PROBE_OUT: probe,
        DSH_PROBE_FORWARDED: 'forwarded-on-purpose',
      },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.verification_backend, 'host_executed')
    const evidence = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    assert.equal(evidence.environment.kind, 'host_independent')

    const lines = readFileSync(probe, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(lines.length >= 3, `the fixture gates did not report their environment: ${readFileSync(probe, 'utf8')}`)
    for (const line of lines) {
      assert.equal(line.issuer, null, `DSH_CI_ISSUER reached gate ${line.gate}`)
      assert.equal(line.standard_revision, null, `DSH_STANDARD_REVISION reached gate ${line.gate}`)
      assert.equal(line.image_digest, null, `DSH_IMAGE_DIGEST reached gate ${line.gate}`)
      assert.equal(line.candidate, report.candidate, `gate ${line.gate} lost the candidate it is verifying`)
      for (const key of line.dsh_keys) {
        const allowed = VERIFIER_GATE_INPUTS.has(key) || key === 'DSH_GATE_PROBE_OUT' || key === 'DSH_PROBE_FORWARDED'
        assert.ok(allowed, `gate ${line.gate} saw an undeclared variable ${key}`)
      }
    }
    // The declared forward is the other half of the model: explicit injection works.
    const build = lines.find((line) => line.gate === 'build')
    assert.equal(build.forwarded, 'forwarded-on-purpose')
    const cleanBoot = lines.find((line) => line.gate === 'clean_boot')
    assert.equal(cleanBoot.forwarded, null, 'an undeclared forward must not arrive')
  } finally {
    cleanup(root)
    rmSync(probe, { force: true })
  }
})

test('the trusted-CI fixture still works when it is given its issuer explicitly', () => {
  const { root } = makeProject()
  try {
    // No issuer: the trusted-CI entry point must refuse rather than fall back.
    const bare = run([verifyScript, '--project', root, '--write-evidence', '--slice', 'S1', '--json'], root)
    assert.equal(bare.status, 2, bare.stdout + bare.stderr)
    assert.match(bare.stderr, /DSH_CI_ISSUER/)

    // Issuer injected explicitly by the scenario: the CI path runs and reports itself
    // as such, still without a protected acceptance revision (so it blocks, as designed).
    const withIssuer = run(
      [verifyScript, '--project', root, '--write-evidence', '--slice', 'S1', '--json'],
      root,
      { DSH_CI_ISSUER: 'ci:verify', DSH_CI_RUN_ID: '4242-1' },
    )
    assert.equal(withIssuer.status, 1, withIssuer.stdout + withIssuer.stderr)
    const report = JSON.parse(withIssuer.stdout)
    assert.equal(report.verification_backend, 'trusted_ci')
    assert.ok(report.structural.some((entry) => entry.code === 'PROTECTED_ACCEPTANCE_UNAVAILABLE'))
    const record = JSON.parse(readFileSync(resolve(root, report.evidence_path), 'utf8'))
    assert.equal(record.environment.kind, 'production_like_ci')
    assert.equal(record.issuer.identity, 'ci:verify')
  } finally {
    cleanup(root)
  }
})

test('the minimal base is sufficient to actually execute the gates on this platform', () => {
  const env = buildBaseEnv()
  if (process.platform === 'win32') {
    for (const key of ['PATH', 'SystemRoot', 'TEMP']) {
      assert.ok(env[key], `the Windows base environment must provide ${key}`)
    }
  } else {
    for (const key of ['PATH', 'HOME']) {
      assert.ok(env[key], `the POSIX base environment must provide ${key}`)
    }
  }
  // The behavioural half: the happy-path host run above executes four real gate
  // commands (build, clean boot, persistence, and two acceptance harness runs) with
  // only this base plus the declared inputs. If the allowlist were too small, that
  // run would fail to start `node` and would not report PASS.
  const { root } = makeProject()
  try {
    const result = hostVerify(root)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.gates.filter((gate) => gate.outcome === 'passed').length, 5, JSON.stringify(report.gates))
  } finally {
    cleanup(root)
  }
})

test('the acceptance driver constructs its child environment instead of inheriting it', () => {
  const driverSource = readFileSync(join(packRoot, '..', '..', 'project', 'tests', 'acceptance', 'driver', 'index.mjs'), 'utf8')
  assert.match(driverSource, /buildBaseEnv\(\)/, 'the driver must build its child environment from the allowlist')
  assert.ok(!/env:\s*\{\s*\.\.\.process\.env/.test(driverSource), 'the driver must not spread process.env into the CLI it observes')
  assert.ok(!/\.\.\.process\.env/.test(driverSource), 'no fixture in the driver may inherit the whole ambient environment')
})
