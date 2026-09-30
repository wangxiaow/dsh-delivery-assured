#!/usr/bin/env node
/**
 * Negative control for the build gate's optional-companion handling.
 *
 * The plugin ships beside the pack, but a bare copy of the pack must still build.
 * This test reproduces that situation in a temp directory: it copies the project and
 * the pack WITHOUT the plugin, then asserts that the build gate
 *
 *   - still succeeds, and
 *   - says explicitly that the plugin suites were not run.
 *
 * Without this control, "the build passes where the plugin is absent" would only be
 * an inference from reading the code.
 *
 * Run: node tools/build-gate-absent-plugin.test.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

const work = mkdtempSync(join(tmpdir(), 'dapse-absent-'))
const projectCopy = join(work, 'project')

try {
  cpSync(join(repoRoot, 'project'), projectCopy, {
    recursive: true,
    filter: (src) => !src.includes(join('project', '.git')) && !src.includes(join('.agent', 'evidence')),
  })
  cpSync(join(repoRoot, 'packages', 'delivery-assured'), join(work, 'packages', 'delivery-assured'), { recursive: true })
  // Deliberately do NOT copy plugins/.
  check('the fixture has no plugin directory', !existsSync(join(work, 'plugins')))

  let result = { status: 0, stdout: '', stderr: '' }
  try {
    const stdout = execFileSync(process.execPath, [join(projectCopy, 'scripts', 'verify-build.mjs')], {
      cwd: projectCopy,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    result = { status: 0, stdout, stderr: '' }
  } catch (error) {
    result = { status: typeof error.status === 'number' ? error.status : 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }
  }

  check('the build gate passes without the optional plugin', result.status === 0, `exit ${result.status}: ${(result.stderr || result.stdout).slice(-300)}`)
  check(
    'the build gate states that the plugin suites were not run',
    /plugin is not present .*NOT RUN/.test(result.stdout),
    result.stdout.trim().slice(-300) || '(no note printed)',
  )
  check(
    'the note keeps "passed" distinguishable from "could not run here"',
    /NOT RUN in this checkout/.test(result.stdout),
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`build-gate-absent-plugin.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`build-gate-absent-plugin.test ok: ${passed} checks passed\n`)
process.exit(0)
