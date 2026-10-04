#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const script of ['tests/harness/run.mjs', 'scripts/verify-acceptance-accounting.mjs']) {
  const result = spawnSync(process.execPath, [join(root, script)], { cwd: root, env: process.env, stdio: 'inherit' })
  if (result.error || result.signal || result.status !== 0) {
    if (result.error) process.stderr.write(`${result.error.message}\n`)
    process.exit(result.status || 1)
  }
}
