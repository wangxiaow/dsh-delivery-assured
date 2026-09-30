#!/usr/bin/env node
/**
 * Gate 2 — Clean Boot.
 *
 * Start from a declared clean state in a fresh temporary directory: no leftover
 * configuration, no developer-machine residue, no network. Two things must hold:
 *   1. with a valid fixture repository the CLI starts and reports;
 *   2. with the required file removed it fails loudly with exit code 2 instead of
 *      pretending everything is fine.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkspace } from '../tests/acceptance/driver/index.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const cli = join(root, 'src', 'cli.mjs')

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
}

// 1. Valid clean fixture: must start and report.
const good = makeWorkspace()
try {
  const result = run(['status', '--project', good.dir, '--json'], root)
  if (result.status === 2) failures.push(`clean fixture produced a tool error: ${(result.stderr || '').trim().split('\n')[0]}`)
  else if (![0, 1].includes(result.status)) failures.push(`clean fixture exited ${result.status}`)
  try {
    const report = JSON.parse(result.stdout)
    if (!Array.isArray(report.statuses) || report.statuses.length === 0) {
      failures.push('clean fixture produced no obligation statuses')
    }
    if (report.report_kind !== 'local_diagnostic') failures.push('clean fixture did not label the run as a local diagnostic')
  } catch (error) {
    failures.push(`clean fixture stdout was not JSON: ${String(error.message)}`)
  }
} finally {
  rmSync(good.dir, { recursive: true, force: true })
}

// 2. Missing required configuration: must fail loudly.
const bare = mkdtempSync(join(tmpdir(), 'dapse-cleanboot-'))
try {
  const result = run(['status', '--project', bare, '--json'], root)
  if (result.status !== 2) failures.push(`a directory without a Contract exited ${result.status}, expected 2`)
  if (!/CONTRACT/i.test(result.stderr || '')) failures.push('the missing Contract was not named on stderr')
  if ((result.stdout || '').includes('statuses')) failures.push('a report was printed for a directory without a Contract')
} finally {
  rmSync(bare, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`CLEAN BOOT FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write('clean boot ok: starts from a clean state and fails loudly when configuration is missing\n')
process.exit(0)
