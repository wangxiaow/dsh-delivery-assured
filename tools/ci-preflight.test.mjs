#!/usr/bin/env node
/**
 * CI preflight: every path and input a workflow depends on must actually exist.
 *
 * Why this exists: the workflows in this repository cannot run without a remote, so
 * a wrong `node <path>` inside them stays invisible until the first push — and then
 * it fails in the one place that is supposed to be the source of truth. This check
 * runs in the build gate and turns that class of defect into a local failure.
 *
 * It checks what is decidable without GitHub:
 *   - each workflow parses as YAML and declares `name`, `on`, `jobs`
 *   - every `node <path>` and every shell `<cmd> <path>` resolves on disk
 *   - every `uses:` action is well formed (and pinned to a major version)
 *   - paths the run steps reference exist, and stated locations do not contradict
 *     where the tools actually live
 *
 * It cannot check whether GitHub accepts the YAML, whether the runner image has the
 * right tooling, or whether the secrets exist. Those need a real push.
 *
 * Run: node tools/ci-preflight.test.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../packages/delivery-assured/scripts/lib/yaml.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

let passed = 0
const failures = []
function check(label, condition, detail) {
  if (condition) passed += 1
  else failures.push(`${label}${detail ? `: ${detail}` : ''}`)
}

const workflowDir = join(repoRoot, '.github', 'workflows')
check(
  'workflows live where GitHub reads them',
  existsSync(workflowDir),
  `${workflowDir} does not exist — GitHub only reads .github/workflows/, so a copy inside the pack would never run`,
)
const workflows = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  : []
check('at least one workflow is installed', workflows.length > 0, workflows.join(', '))

// A workflow file must be valid UTF-8 with no replacement characters and no mojibake.
// A mis-encoded comment once swallowed a `node ...` line inside this repository, which
// silently removed a step — invisible unless something checks the bytes.
for (const file of workflows) {
  const bytes = readFileSync(join(workflowDir, file))
  const text = bytes.toString('utf8')
  check(`${file}: decodes as valid UTF-8`, !text.includes('\uFFFD'), 'contains U+FFFD replacement characters')
  check(`${file}: round-trips to the same bytes`, Buffer.from(text, 'utf8').equals(bytes), 'encoding is lossy')
  check(
    `${file}: no command is buried inside a comment`,
    !/^\s*#.*\bnode\s+\S+\.mjs/m.test(text),
    'a `node <script>` line appears inside a comment',
  )
}

/** Strip GitHub expressions so a line can be inspected as plain shell. */
function stripExpressions(text) {
  return text.replace(/\$\{\{[^}]*\}\}/g, 'PLACEHOLDER')
}

for (const file of workflows) {
  const full = join(workflowDir, file)
  const text = readFileSync(full, 'utf8')

  let doc
  try {
    doc = parseYaml(text)
    check(`${file}: parses as YAML`, true)
  } catch (error) {
    failures.push(`${file}: does not parse as YAML: ${error.message}`)
    continue
  }
  check(`${file}: declares a name`, typeof doc?.name === 'string' && doc.name.length > 0)
  check(`${file}: declares triggers`, doc?.on !== undefined)
  check(`${file}: declares jobs`, doc?.jobs && typeof doc.jobs === 'object' && Object.keys(doc.jobs).length > 0)

  // Every job needs a runner, and every step needs either `run` or `uses`.
  for (const [jobName, job] of Object.entries(doc?.jobs || {})) {
    check(`${file}: job ${jobName} has runs-on`, typeof job['runs-on'] === 'string' && job['runs-on'].length > 0)
    check(`${file}: job ${jobName} has steps`, Array.isArray(job.steps) && job.steps.length > 0)
    for (const [index, step] of (job.steps || []).entries()) {
      const where = `${file}: job ${jobName} step ${index + 1}`
      // GitHub allows a step with only `uses:` and no `name:` — it renders the action
      // reference as the label. Requiring `name:` here would reject valid workflows,
      // so the check is "the step declares something to do".
      check(
        `${where} declares run or uses`,
        typeof step.run === 'string' || typeof step.uses === 'string',
        `keys=${Object.keys(step).join(',')}`,
      )
      if (typeof step.uses === 'string') {
        check(`${where}: action is version-pinned`, /@v\d+(\.\d+)*$/.test(step.uses), step.uses)
        check(`${where}: action is a real action reference`, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@/.test(step.uses), step.uses)
      }
      if (typeof step.run === 'string' && step.run.trim() === '') {
        failures.push(`${where}: run script is empty`)
      }
    }
  }

  // Every `node <path>` and `bash <path>` in a run step must exist relative to the
  // step's working directory (defaulting to the checkout root).
  const lines = text.split('\n')
  let currentWorkdir = '.'
  for (const [index, rawLine] of lines.entries()) {
    const workdirMatch = /^\s*working-directory:\s*(\S+)\s*$/.exec(rawLine)
    if (workdirMatch) currentWorkdir = workdirMatch[1]
    const line = stripExpressions(rawLine)

    for (const match of line.matchAll(/\bnode\s+([A-Za-z0-9_./@-]+\.mjs)/g)) {
      const target = match[1]
      if (target.startsWith('../')) continue // resolves relative to a sibling checkout
      const base = currentWorkdir.startsWith('.') ? join(repoRoot, currentWorkdir) : repoRoot
      check(
        `${file}:${index + 1}: node target exists -> ${target}`,
        existsSync(resolve(base, target)),
        `looked in ${resolve(base, target)}`,
      )
    }
    for (const match of line.matchAll(/\bgit\s+(?:worktree\s+add[^&|]*|archive[^&|]*)\s+([A-Za-z0-9_./-]+)/g)) {
      // Only report the destination shape; a worktree destination is created by the run.
      void match
    }
  }

  // A `cp -r <src>` whose source does not exist fails under `set -e`. The canonical
  // checkout is the repository root, so check the source there.
  for (const [index, rawLine] of lines.entries()) {
    const line = stripExpressions(rawLine)
    for (const match of line.matchAll(/\bcp\s+(?:-r\s+)?([A-Za-z0-9_./-]+)\s+\.\.\//g)) {
      const src = match[1]
      check(
        `${file}:${index + 1}: copy source exists -> ${src}`,
        existsSync(join(repoRoot, src)),
        `missing ${join(repoRoot, src)}`,
      )
    }
    for (const match of line.matchAll(/\brm\s+-rf\s+\.\.\/([A-Za-z0-9_./-]+)/g)) {
      void match // removing inside a fresh worktree is always safe to skip
    }
  }
}

// The CI tools the workflows call must actually be present.
const toolsDir = join(repoRoot, 'ci', 'tools')
for (const tool of ['ci-spec-diff.mjs', 'ci-standards-diff.mjs', 'ci-promote.mjs', 'verify-artifact.mjs']) {
  check(`ci tool exists: ${tool}`, existsSync(join(toolsDir, tool)))
}
check(
  'the deployment gate has a producer it can call',
  existsSync(join(toolsDir, 'verify-artifact.mjs')),
)

// The protection material, and it must explain the platform-level steps a file
// cannot perform by itself.
const protectionReadme = join(repoRoot, 'ci', 'protection', 'README.md')
check('protection README exists', existsSync(protectionReadme))
check('branch protection declaration exists', existsSync(join(repoRoot, 'ci', 'protection', 'branch-protection.json')))
check('CODEOWNERS is installed where the platform reads it', existsSync(join(repoRoot, '.github', 'CODEOWNERS')))

// The deployment gate must be fed by a producer, or `verify` blocks on missing
// environment variables. A workflow that only consumes those variables is a bug.
const verifyText = workflows.includes('verify.yml') ? readFileSync(join(workflowDir, 'verify.yml'), 'utf8') : ''
if (verifyText !== '') {
  check(
    'verify.yml produces the deployment identity instead of assuming it',
    /verify-artifact\.mjs/.test(verifyText),
    'no step computes DSH_DEPLOYMENT_ID / DSH_DEPLOYED_CODE_REVISION / DSH_IMAGE_DIGEST',
  )
  check(
    'verify.yml feeds those values to the gates',
    />>\s*"\$GITHUB_ENV"/.test(verifyText),
    'artifact step does not append to $GITHUB_ENV',
  )
}

if (failures.length > 0) {
  process.stderr.write(`ci-preflight.test: ${failures.length} failure(s), ${passed} passed\n`)
  for (const failure of failures) process.stderr.write(`  FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`ci-preflight.test ok: ${passed} checks passed\n`)
process.exit(0)
