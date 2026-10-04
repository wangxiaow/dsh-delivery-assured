#!/usr/bin/env node
/**
 * The Deployment gate must be fed by an observation, not by an echo.
 *
 * This test builds a real artifact into a temporary directory, runs the producer
 * against it, and checks that the reported revision and digest come from the
 * packaged bytes while the installed CLI is actually executed. It also checks the
 * two failure paths the gate depends on: no artifact, and an artifact whose entry
 * cannot start.
 *
 * Run: node tools/deploy-probe.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (args, options = {}) => spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: 300000, ...options })
const head = run(['-e', 'process.stdout.write(require("child_process").execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim())']).stdout.trim()

let checks = 0
function check(condition, message) {
  assert.ok(condition, message)
  checks += 1
}

const work = mkdtempSync(join(tmpdir(), 'deploy-probe-'))
try {
  const artifact = join(work, 'artifact')
  const built = run(['ci/tools/verify-artifact.mjs', '--project', 'project', '--out', artifact])
  check(built.status === 0, `artifact build failed: ${built.stderr}`)
  const manifest = JSON.parse(readFileSync(join(artifact, 'ARTIFACT.json'), 'utf8'))
  check(manifest.code_revision === head, 'packaged revision is the repository HEAD')
  check(/^[0-9a-f]{64}$/.test(manifest.digest), 'packaged digest is a sha256 over the shipped bytes')

  const probed = run(['ci/tools/ci-deploy-probe.mjs', '--project', 'project', '--artifact', artifact])
  check(probed.status === 0, `deploy probe failed: ${probed.stderr}`)
  const lines = Object.fromEntries(probed.stdout.trim().split('\n').map((line) => line.split('=')))
  check(lines.DSH_DEPLOYMENT_ID?.startsWith('artifact-install-'), 'probe names the deployment it observed')
  check(lines.DSH_DEPLOYED_CODE_REVISION === manifest.code_revision, 'observed revision comes from the packaged artifact, not from DSH_CANDIDATE')
  check(lines.DSH_DEPLOYED_IMAGE_DIGEST === `sha256:${manifest.digest}`, 'observed image digest is the packaged digest')
  const report = JSON.parse(readFileSync(join(repo, 'project', '.agent', 'artifact', 'deploy-probe.json'), 'utf8'))
  check(report.started === true && report.entry.endsWith('cli.mjs'), 'the installed CLI was executed from the clean install')
  check(/not a staging deployment/.test(report.limitation), 'the probe states what it does not prove')

  // No artifact, no observation.
  const missing = run(['ci/tools/ci-deploy-probe.mjs', '--project', 'project', '--artifact', join(work, 'absent')])
  check(missing.status === 2 && /no packaged artifact/.test(missing.stderr), 'missing artifact is an input error, never a pass')

  // A packaged entry that cannot run must fail the gate rather than pass silently.
  const broken = join(work, 'broken')
  const rebuilt = run(['ci/tools/verify-artifact.mjs', '--project', 'project', '--out', broken])
  check(rebuilt.status === 0, 'second artifact build failed')
  const entry = resolve(broken, 'project/src/cli.mjs')
  check(existsSync(entry), 'packaged entry exists')
  truncateSync(entry, 0)
  const failed = run(['ci/tools/ci-deploy-probe.mjs', '--project', 'project', '--artifact', broken])
  check(failed.status === 1, 'an artifact that cannot start fails the probe')
  check(!/DSH_DEPLOYED_CODE_REVISION=/.test(failed.stdout), 'a failed install emits no deployment identity')
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`deploy-probe.test ok: ${checks} checks passed`)
