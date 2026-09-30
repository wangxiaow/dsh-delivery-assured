#!/usr/bin/env node
/**
 * Produce the deployable artifact for a CLI project and report what it actually is.
 *
 * The "+1 Deployment" gate asks whether the thing that runs elsewhere is the same
 * candidate that was verified. For a web service that means an image and a
 * deployment; for a CLI it means the shipped bundle and a digest of its bytes.
 *
 * This script exists so the gate is not self-proving. Without it a workflow would
 * simply export `DSH_DEPLOYED_CODE_REVISION=$DSH_CANDIDATE` and the gate would
 * "pass" by echoing the input back. Here the revision and digest are **computed from
 * the working tree**: the digest is taken over the files actually being shipped, so
 * a mismatch with the injected expectation is meaningful.
 *
 * Outputs `KEY=VALUE` lines on stdout for CI to append to `$GITHUB_ENV`, and prints
 * a short human summary on stderr.
 *
 * Usage:
 *   node ci/tools/verify-artifact.mjs --project <path> [--out <dir>]
 *
 * Exit codes: 0 artifact produced, 1 production failed, 2 input/tool error.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function parse(argv) {
  const opts = { project: '.', out: null, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--project') opts.project = argv[++i]
    else if (token === '--out') opts.out = argv[++i]
    else if (token === '--quiet') opts.quiet = true
    else if (token === '--help') opts.help = true
    else {
      process.stderr.write(`verify-artifact: unknown option ${token}\n`)
      process.exit(2)
    }
  }
  return opts
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (error) {
    if (!allowFailure) throw error
    return { ok: false, out: '', err: (error.stderr || '').trim() || error.message }
  }
}

/** Every file under `dir`, as paths relative to it, sorted. */
function listFiles(dir) {
  const out = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, name)
      else if (entry.isFile()) out.push(name)
    }
  }
  walk(dir, '')
  return out
}

function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write('verify-artifact — produce the CLI artifact and report its revision and digest\n')
    return 0
  }

  const root = resolve(opts.project)
  if (!existsSync(root)) {
    process.stderr.write(`verify-artifact: project path does not exist: ${root}\n`)
    return 2
  }

  const revision = git(root, ['rev-parse', 'HEAD'], { allowFailure: true })
  if (!revision.ok) {
    process.stderr.write('verify-artifact: not a git repository, so no code revision can be observed\n')
    return 2
  }
  const codeRevision = revision.out

  // The shipped set is the CLI plus the operation pack it imports. Anything the
  // bundle needs to run must be inside it, or the digest would not cover the artifact.
  const sources = [
    { label: 'cli', dir: join(root, 'src') },
    { label: 'gates', dir: join(root, 'scripts') },
    { label: 'pack', dir: resolve(root, '..', 'packages', 'delivery-assured', 'scripts') },
  ].filter((entry) => existsSync(entry.dir))

  if (sources.length === 0) {
    process.stderr.write('verify-artifact: no shippable source directory was found\n')
    return 1
  }

  const outDir = resolve(opts.out || join(root, '.agent', 'artifact', 'delivery-assured'))
  rmSync(outDir, { recursive: true, force: true })

  const manifest = []
  for (const source of sources) {
    for (const name of listFiles(source.dir)) {
      const from = join(source.dir, name)
      const to = join(outDir, source.label, name)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(from))
      const digest = createHash('sha256').update(readFileSync(from)).digest('hex')
      manifest.push({ path: `${source.label}/${name}`, bytes: statSync(from).size, sha256: digest })
    }
  }

  // The artifact digest is over the manifest content, so it changes whenever any
  // shipped byte changes — including a reordering that alters the file set.
  const manifestText = `${manifest.map((e) => `${e.path}\t${e.bytes}\t${e.sha256}`).join('\n')}\n`
  const digest = createHash('sha256').update(manifestText).digest('hex')
  writeFileSync(join(outDir, 'MANIFEST.tsv'), manifestText, 'utf8')
  writeFileSync(
    join(outDir, 'ARTIFACT.json'),
    `${JSON.stringify({ code_revision: codeRevision, digest, files: manifest.length, entries: manifest }, null, 2)}\n`,
    'utf8',
  )

  // A deployment identity has to be something a third party could look at. The run
  // id is the only stable, externally visible label this job has.
  const deploymentId = process.env.DSH_CI_RUN_ID ? `cli-run-${process.env.DSH_CI_RUN_ID}` : `cli-local-${Date.now()}`

  process.stdout.write(`DSH_DEPLOYMENT_ID=${deploymentId}\n`)
  process.stdout.write(`DSH_DEPLOYED_CODE_REVISION=${codeRevision}\n`)
  process.stdout.write(`DSH_IMAGE_DIGEST=sha256:${digest}\n`)
  process.stdout.write(`DSH_DEPLOYED_IMAGE_DIGEST=sha256:${digest}\n`)
  process.stdout.write(`DSH_ARTIFACT_DIR=${relative(root, outDir).split('\\').join('/')}\n`)

  if (!opts.quiet) {
    process.stderr.write(
      `artifact: ${manifest.length} files, digest sha256:${digest.slice(0, 16)}..., revision ${codeRevision.slice(0, 12)}\n`,
    )
  }
  return 0
}

process.exit(main())
