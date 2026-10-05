#!/usr/bin/env node
/**
 * capture-run — the sandbox-safe child capture contract.
 *
 * Windows-ACL-restricted shells may deny piped grandchild stdio: `spawnSync`
 * fails with EPERM before the child starts, while `ignore`/`inherit`/file-fd
 * redirection works and the per-session temp directory stays writable.
 * `runCaptured` therefore keeps the pipe path for unconfined callers and retries
 * a failed pipe capture through temporary files it removes afterwards. The
 * mechanics are pinned here so the CI and local suites both refute a regression.
 *
 * Exit codes: 0 all checks passed, 1 check failed, 2 input/tool error.
 */

import { closeSync, existsSync, readdirSync, rmSync, mkdirSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

let checks = 0
let failures = 0
function check(condition, message) {
  checks += 1
  if (!condition) {
    failures += 1
    process.stderr.write(`FAIL ${message}\n`)
  }
}

const { runCaptured, git, gitAvailable } = await import('../scripts/lib/common.mjs')
const { defaultGit } = await import('../scripts/lib/durable-state.mjs')

/** A fresh private temp directory for one case, removed when the check ends. */
function caseTempDir() {
  const dir = join(tmpdir(), `dsh-capture-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---- 1. No EPERM: exactly one pipe spawn, result passed through unchanged.
{
  const attempts = []
  const spawn = (file, args, options) => {
    attempts.push(options)
    return { status: 0, stdout: 'git version 2.55.0\n', stderr: '', error: null }
  }
  const result = runCaptured('git', ['--version'], { spawn })
  check(result.ok === true && result.status === 0, 'runCaptured passes through a clean pipe result')
  check(result.stdout.trim() === 'git version 2.55.0', 'runCaptured returns the captured stdout')
  check(attempts.length === 1, 'runCaptured spawns exactly once when no EPERM occurs')
  check(
    Array.isArray(attempts[0].stdio) && attempts[0].stdio[1] === 'pipe',
    'the first attempt captures through pipes (no capture files without a denial)',
  )
}

// ---- 2. EPERM: one retry that captures through file descriptors.
{
  const attempts = []
  const dir = caseTempDir()
  const spawn = (file, args, options) => {
    attempts.push(options)
    if (attempts.length === 1) {
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn git EPERM'), { code: 'EPERM' }) }
    }
    writeSync(options.stdio[1], 'captured-out\n')
    writeSync(options.stdio[2], 'captured-err\n')
    return { status: 0, stdout: null, stderr: null, error: null }
  }
  const result = runCaptured('git', ['--version'], { spawn, tempDir: dir })
  check(result.ok === true && result.status === 0, 'the EPERM retry succeeds')
  check(result.stdout === 'captured-out\n', 'the retry reads the captured stdout from the capture file')
  check(result.stderr === 'captured-err\n', 'the retry reads the captured stderr from the capture file')
  check(attempts.length === 2, 'runCaptured retries exactly once after EPERM')
  check(
    attempts[1].stdio.length === 3 && Number.isInteger(attempts[1].stdio[1]) && Number.isInteger(attempts[1].stdio[2]),
    'the retry redirects stdout/stderr to file descriptors, not pipes',
  )
  check(readdirSync(dir).length === 0, `both capture files were removed afterwards (left: ${readdirSync(dir).join(', ')})`)
  rmSync(dir, { recursive: true, force: true })
}

// ---- 3. The retry itself fails: the failure stays honest and no content survives.
{
  let first = true
  const dir = caseTempDir()
  const result = runCaptured('git', ['--version'], {
    tempDir: dir,
    spawn: () => {
      if (first) {
        first = false
        return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn git EPERM'), { code: 'EPERM' }) }
      }
      return { status: 7, stdout: null, stderr: null, error: null }
    },
  })
  check(result.ok === false && result.status === 7, 'a failing child stays a failing result (no fake pass)')
  check(result.error === null && result.stdout === '' && result.stderr === '', 'no invented output on a failed run')
  rmSync(dir, { recursive: true, force: true })
}

// ---- 4. Capture-file cleanup happens even when the retry writes then fails.
{
  const dir = caseTempDir()
  let wrote = false
  const result = runCaptured('git', ['--version'], {
    tempDir: dir,
    spawn: (_file, _args, options) => {
      if (Number.isInteger(options.stdio?.[1])) {
        writeSync(options.stdio[1], 'half-written\n')
        wrote = true
      }
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn git EPERM'), { code: 'EPERM' }) }
    },
  })
  check(wrote === true, 'the injected child wrote into the capture descriptor')
  check(result.error?.code === 'EPERM', 'the failed retry reports the EPERM error')
  check(result.ok === false && result.stdout === 'half-written\n', 'content written before failure is read back faithfully')
  check(readdirSync(dir).length === 0, `capture files are removed even on a failing retry (left: ${readdirSync(dir).join(', ')})`)
  rmSync(dir, { recursive: true, force: true })
}

// ---- 5. Real child end-to-end: a real git runs and the capture is read back.
{
  check(gitAvailable(process.cwd()), 'git answers through runCaptured on this machine')
}

// ---- 6. durable-state's defaultGit keeps the same contract end-to-end.
{
  const root = join(import.meta.dirname, '..')
  const r = defaultGit(root, ['rev-parse', '--is-inside-work-tree'])
  check(r.ok === true && r.stdout.trim() === 'true', 'defaultGit runs real git without a shell')
  const bad = defaultGit(root, ['show', 'definitely-not-a-ref'])
  check(bad.ok === false && bad.reason.length > 0, 'defaultGit reports a git failure as a reason string')
}

// ---- 7. The allowFailure contract of common.git is unchanged.
{
  const root = join(import.meta.dirname, '..')
  revisionCase: {
    const ok = git(root, ['rev-parse', 'HEAD'])
    if (ok.ok !== true || !/^[0-9a-f]{40}$/.test(ok.out)) {
      check(false, `common.git revision query failed: ${JSON.stringify(ok)}`)
      break revisionCase
    }
    const fail = git(root, ['show', 'definitely-not-a-ref'])
    check(fail.ok === false && fail.err.length > 0 && fail.out === '', 'common.git failure keeps err and drops out')
  }
}

process.stdout.write(`${checks - failures}/${checks} checks passed\n`)
process.exit(failures > 0 ? 1 : 0)
