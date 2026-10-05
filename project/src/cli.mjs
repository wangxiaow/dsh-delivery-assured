#!/usr/bin/env node
/**
 * delivery — the first vertical slice of this repository's product.
 *
 * The product question is the one this whole operation pack exists to answer:
 * "what do I still owe?" `delivery status` answers it from the Contract, the
 * frozen acceptance manifest and CI records — never from a task list or a DONE
 * marker — and it labels every local result as a diagnostic.
 *
 * Exit codes (v0.5 §16.2): 0 nothing blocking, 1 a blocking gap was found,
 * 2 input, configuration or tool error.
 */

import { EXIT, InputError } from '../../packages/delivery-assured/scripts/lib/index.mjs'

const USAGE = `delivery — what do I still owe?

Usage:
  delivery status [--project <path>] [--json] [--all] [--durable-state]
                  [--state-transport <auto|gh|git>] [--state-repo <owner/name>]

Commands:
  status    list every required obligation with its recomputed status and basis

Options:
  --project <path>   repository to inspect (default: nearest .agent marker upward)
  --json             emit the same facts as JSON
  --all              include non-required obligations
  --durable-state    also read refs/heads/delivery-state/main (Baseline, Evidence, Spine);
                     read-only, and the only way to see a promoted Baseline
  --state-transport  how that ref is read: auto (default; gh first), gh (GitHub API),
                     git (ls-remote + fetch); an unreadable state fails, it does not
                     silently fall back to the working tree
  --state-repo       owner/name of the GitHub repository to read from; defaults to the
                     URL configured for the remote in the Git config
  -h, --help         show this help

Exit codes: 0 no blocking gap, 1 blocking gap found, 2 input/configuration error.
A local result is a diagnostic. Evidence comes only from the trusted CI verifier,
and only its Promotion job may advance refs/heads/baseline/*.`

const COMMANDS = new Set(['status', 'help'])

function parse(argv) {
  const opts = { command: null, project: null, json: false, all: false, 'durable-state': false, 'state-transport': null, 'state-repo': null }
  const args = [...argv]
  while (args.length > 0) {
    const token = args.shift()
    if (token === '-h' || token === '--help' || token === 'help') {
      opts.command = 'help'
      continue
    }
    if (token === '--json') { opts.json = true; continue }
    if (token === '--all') { opts.all = true; continue }
    if (token === '--durable-state') { opts['durable-state'] = true; continue }
    if (token === '--project') {
      const value = args.shift()
      if (value === undefined) throw new InputError('--project requires a path')
      opts.project = value
      continue
    }
    if (token === '--state-transport') {
      const value = args.shift()
      if (value === undefined) throw new InputError('--state-transport requires a value')
      if (!['auto', 'gh', 'git'].includes(value)) throw new InputError(`--state-transport must be one of auto, gh, git (got ${value})`)
      opts['state-transport'] = value
      continue
    }
    if (token === '--state-repo') {
      const value = args.shift()
      if (value === undefined) throw new InputError('--state-repo requires a value')
      opts['state-repo'] = value
      continue
    }
    if (token.startsWith('--state-transport=')) {
      const value = token.slice('--state-transport='.length)
      if (!['auto', 'gh', 'git'].includes(value)) throw new InputError(`--state-transport must be one of auto, gh, git (got ${value})`)
      opts['state-transport'] = value
      continue
    }
    if (token.startsWith('--state-repo=')) { opts['state-repo'] = token.slice('--state-repo='.length); continue }
    if (token.startsWith('--project=')) { opts.project = token.slice('--project='.length); continue }
    if (token.startsWith('-')) throw new InputError(`unknown option ${JSON.stringify(token)}`)
    if (opts.command === null) {
      if (!COMMANDS.has(token)) throw new InputError(`unknown command ${JSON.stringify(token)}; run "delivery --help"`)
      opts.command = token
      continue
    }
    throw new InputError(`unexpected argument ${JSON.stringify(token)}`)
  }
  return opts
}

async function main() {
  const opts = parse(process.argv.slice(2))
  if (opts.command === null || opts.command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return EXIT.PASS
  }
  if (opts.command === 'status') {
    const { statusCommand } = await import('./commands/status.mjs')
    return statusCommand(opts)
  }
  throw new InputError(`unknown command ${JSON.stringify(opts.command)}`)
}

try {
  process.exitCode = await main()
} catch (error) {
  if (error instanceof InputError) {
    process.stderr.write(`delivery: ${error.message}\n`)
    process.exitCode = EXIT.ERROR
  } else {
    process.stderr.write(`delivery: unexpected error: ${error?.stack || error}\n`)
    process.exitCode = EXIT.ERROR
  }
}
