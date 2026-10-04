#!/usr/bin/env node
/**
 * One-command install for the delivery-assured supervision layer.
 *
 * The manual steps in README.md (link the package, add the bundle, point the config
 * at a pack and a project) are easy to get half-right: a missing bundle name makes
 * the plugin invisible, and a wrong `projectRoot` makes every session report on the
 * wrong repository. This script performs all of them idempotently, verifies the
 * result, and can undo itself.
 *
 * It never touches a repository under version control: only the DSH profile
 * directory (package.json + cordis.patch.yml), with a backup kept next to it.
 *
 * Usage:
 *   node plugins/dsh-delivery-assured/install.mjs --project <delivery repo>
 *   node plugins/dsh-delivery-assured/install.mjs --project <repo> --profile web
 *   node plugins/dsh-delivery-assured/install.mjs --uninstall
 *
 * Options: --profile <name> | --profile-dir <dir> | --pack <dir> | --project <dir>
 *          --node <bin> | --uninstall | --dry-run | --skip-checks
 * Exit codes: 0 installed/verified, 1 refused or verification failed, 2 input error.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here)
const bundleName = 'dsh-delivery-assured'
const patchId = 'delivery-assured'
const backupSuffix = '.delivery-backup'

function parse(argv) {
  const opts = { profile: null, profileDir: null, pack: null, project: null, node: null, uninstall: false, dryRun: false, skipChecks: false, enableDesktop: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--profile') opts.profile = argv[++i]
    else if (token === '--profile-dir') opts.profileDir = argv[++i]
    else if (token === '--pack') opts.pack = argv[++i]
    else if (token === '--project') opts.project = argv[++i]
    else if (token === '--node') opts.node = argv[++i]
    else if (token === '--uninstall') opts.uninstall = true
    else if (token === '--dry-run') opts.dryRun = true
    else if (token === '--skip-checks') opts.skipChecks = true
    else if (token === '--enable-desktop') opts.enableDesktop = true
    else if (token === '--help') opts.help = true
    else {
      process.stderr.write(`install: unknown option ${token}\n`)
      process.exit(2)
    }
  }
  return opts
}

/**
 * Refuse to touch the live desktop profile unless the caller explicitly opts in.
 *
 * The desktop app owns that manifest and rewrites it while it runs, so a plugin row
 * written underneath a running app lands in an open session — and a row the app cannot
 * load breaks that session. That happened once (see REPAIR_NOTES), so the installer
 * now prints the plan and exits without writing. Throwaway profiles passed through
 * `--profile-dir` (tests, trials) are exempt.
 */
function refuseLiveDesktop(directory, opts) {
  if (opts.profileDir || opts.enableDesktop || process.env.DSH_DELIVERY_ALLOW_LIVE_PROFILE === '1') return false
  if (!/(^|[\\/])desktop$/.test(directory)) return false
  process.stderr.write(
    [
      'install: refusing to modify the live desktop profile.',
      '',
      '  The desktop app owns this profile manifest and rewrites it while it runs;',
      '  a plugin row it cannot load breaks the session that is open right now.',
      '',
      '  To install deliberately:',
      '    1. close DeepSeek Harness completely (all processes)',
      `    2. node ${fileURLToPath(import.meta.url)} --project <delivery repo> --enable-desktop`,
      '    3. start DeepSeek Harness again',
      '',
      '  Inspect the plan first with --dry-run (writes nothing). Nothing was written.',
      '',
    ].join('\n'),
  )
  return true
}

const log = (message) => process.stdout.write(`${message}\n`)
const fail = (message) => {
  process.stderr.write(`install: ${message}\n`)
  process.exit(1)
}

function profileDirectory(opts) {
  if (opts.profileDir) return resolve(opts.profileDir)
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
  const profile = opts.profile || process.env.DSH_PROFILE || 'desktop'
  return join(home, 'profiles', profile)
}

function readProfile(directory) {
  const file = join(directory, 'package.json')
  if (!existsSync(file)) fail(`no profile package.json at ${file}; pass --profile-dir for a different location`)
  try {
    return { file, json: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    fail(`profile package.json is not valid JSON (${error.message}); refusing to rewrite it`)
  }
}

function linkSpec() {
  return `link:${pluginRoot.replace(/\\/g, '/')}`
}

/** Whether a patch file already addresses this plugin — by row id or by package name. */
function mentionsPlugin(text) {
  return new RegExp(`id:\\s*['"]?${patchId}['"]?`).test(text) || text.includes(bundleName)
}

function install(opts) {
  const directory = profileDirectory(opts)
  if (refuseLiveDesktop(directory, opts)) return 1
  const { file, json } = readProfile(directory)
  const pack = opts.pack ? resolve(opts.pack) : resolve(pluginRoot, '..', '..', 'packages', 'delivery-assured')
  const project = opts.project ? resolve(opts.project) : null

  if (!existsSync(join(pack, 'scripts', 'resume.mjs'))) fail(`--pack must contain scripts/resume.mjs (looked in ${pack})`)
  if (project && !existsSync(join(project, '.agent', 'CONTRACT.yaml'))) {
    fail(`--project must contain .agent/CONTRACT.yaml (looked in ${project}); a wrong project root is how a session reports on the wrong repository`)
  }

  const before = JSON.stringify(json, null, 2)
  const next = JSON.parse(before)
  next.dependencies = { ...(next.dependencies || {}), [bundleName]: linkSpec() }
  // The bundles list is deliberately NOT edited: the desktop app's plugin manager owns
  // that manifest and rewrites it while it runs. Enabling the plugin is the patch
  // layer's job (a bundle patches its own row; an unbundled profile gets an insert),
  // so nothing here depends on a field the app may drop.
  const alreadyBundled = Array.isArray(next.dsh?.profile?.bundles) && next.dsh.profile.bundles.includes(bundleName)
  const after = `${JSON.stringify(next, null, 2)}\n`

  const patchFile = join(directory, 'cordis.patch.yml')
  const patchBefore = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  // Self-hosting: the configured project is the operation pack's own repository, so
  // protecting repository material would refuse the edits that improve the pack.
  const selfHosting = Boolean(project) && resolve(project, '..', 'packages', 'delivery-assured').toLowerCase() === pack.toLowerCase()
  const patchPlan = planPatch(patchBefore, { pack, project, node: opts.node, selfHosting, insert: !alreadyBundled })

  log(`profile : ${directory}`)
  log(`plugin  : ${linkSpec()}`)
  log(`pack    : ${pack}`)
  log(`project : ${project || '(not set: sessions discover the project from the workspace)'}`)
  log(`bundle  : ${alreadyBundled ? 'already listed in dsh.profile.bundles' : 'not listed; the patch inserts the plugin row itself'}`)
  log(`patch   : ${patchPlan.kind} (${patchFile})`)
  if (selfHosting) log('note    : the project is the operation pack\'s own repository, so protectRepoMaterial=false (otherwise improving the pack would be refused as a Candidate edit)')

  if (opts.dryRun) {
    log('dry run: nothing was written')
    return 0
  }

  const backup = `${file}${backupSuffix}`
  if (!existsSync(backup)) copyFileSync(file, backup)
  // Only a patch file that predates this plugin is worth preserving; backing up the
  // file we wrote would make `--uninstall` restore our own entry instead of removing it.
  const patchIsOurs = mentionsPlugin(patchBefore)
  if (patchBefore && !patchIsOurs && !existsSync(`${patchFile}${backupSuffix}`)) copyFileSync(patchFile, `${patchFile}${backupSuffix}`)
  writeFileSync(file, after, 'utf8')
  if (['append', 'create', 'replace'].includes(patchPlan.kind)) writeFileSync(patchFile, patchPlan.text, 'utf8')
  log(`wrote   : ${file}${existsSync(backup) ? ` (backup ${backup})` : ''}`)
  if (['append', 'create', 'replace'].includes(patchPlan.kind)) log(`wrote   : ${patchFile}`)
  if (patchPlan.kind === 'present-verified') log('patch   : an entry for this plugin already exists; left untouched')
  if (patchPlan.kind === 'manual') log(`patch   : ${patchPlan.reason}`)

  if (!opts.skipChecks) return selfCheck({ directory, pack, project, node: opts.node })
  return 0
}

/**
 * Decide how to make the profile carry this plugin's config.
 *
 * The bundle's own `cordis.patch.yml` already inserts the plugin row (id
 * `delivery-assured`), and DSH composes bundle patches before the profile's own
 * patch layer. So the profile patch must update that row **by id** — writing a
 * second row with `name:` would insert the plugin twice.
 *
 * Only a file that is already a YAML sequence is appended to; anything else is
 * reported instead of guessed at, because corrupting a profile config is worse than
 * a manual step.
 */
function planPatch(existing, { pack, project, node, selfHosting = false, insert = false }) {
  const firstMeaningful = existing.split('\n').find((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  // A profile patch layer is a top-level YAML array, but an existing file may nest
  // its entries; the appended item must use the same indentation as the entries
  // already there, or it silently becomes part of the previous entry's config.
  const rootIndent = firstMeaningful && firstMeaningful.trimStart().startsWith('-') ? (firstMeaningful.match(/^\s*/) || [''])[0] : ''
  const pad = (depth) => `${rootIndent}${'  '.repeat(depth)}`
  const configLines = [
    `${pad(insert ? 4 : 2)}packRoot: ${quoteYaml(pack)}`,
    ...(project ? [`${pad(insert ? 4 : 2)}projectRoot: ${quoteYaml(project)}`] : []),
    ...(node ? [`${pad(insert ? 4 : 2)}nodeBin: ${quoteYaml(node)}`] : []),
    ...(selfHosting ? [`${pad(insert ? 4 : 2)}protectRepoMaterial: false`] : []),
  ]
  // Two forms, chosen by whether the profile already lists this bundle:
  //   bundled  -> patch the bundle's own inserted row by id (the bundle patch inserts it)
  //   unbundled-> insert the row here, so the plugin does not depend on the profile
  //               manifest — which the desktop app's plugin manager owns and rewrites
  const entry = insert
    ? [`${pad(0)}- insert:`, `${pad(2)}- id: ${patchId}`, `${pad(3)}name: ${bundleName}`, `${pad(3)}config:`, ...configLines].join('\n')
    : [`${pad(0)}- id: ${patchId}`, `${pad(1)}config:`, ...configLines].join('\n')

  if (existing.trim() === '') return { kind: 'create', text: `${entry}\n` }
  const present = new RegExp(`id:\\s*['"]?${patchId}['"]?`).test(existing)
  if (present) {
    const hasPack = /packRoot:\s*\S+/.test(existing)
    const hasProject = !project || /projectRoot:\s*\S+/.test(existing)
    const hasInsert = new RegExp(`${patchId}[\\s\\S]{0,80}?name:\\s*['"]?${bundleName}`).test(existing)
    if (hasPack && hasProject && (hasInsert || !insert)) return { kind: 'present-verified', text: existing }
    if (insert && !hasInsert) {
      // An id-only entry cannot activate an unbundled plugin: there is no bundle patch
      // to insert the row. Upgrade our own entry in place — only when the block is one
      // this installer wrote, otherwise leave the file alone and say so.
      const upgraded = upgradeIdOnlyEntry(existing, entry)
      if (upgraded !== null) return { kind: 'replace', text: upgraded }
    }
    return { kind: 'manual', reason: `an entry for ${patchId} exists but ${hasInsert || !insert ? 'lacks ' + [!hasPack && 'packRoot', !hasProject && 'projectRoot'].filter(Boolean).join(' / ') : `does not insert the plugin row; replace it with:\n${entry}`}; edit cordis.patch.yml by hand` }
  }
  if (firstMeaningful && firstMeaningful.trimStart().startsWith('-')) {
    const text = `${existing.replace(/\s*$/, '')}\n${entry}\n`
    return { kind: 'append', text }
  }
  return { kind: 'manual', reason: 'cordis.patch.yml is not a YAML sequence, so no entry was appended; add the delivery-assured entry by hand' }
}

function quoteYaml(value) {
  return `"${String(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`
}

/**
 * Replace this plugin's own id-only patch entry with the given insert entry.
 *
 * Only a block this installer could have written is touched: the item must start with
 * `- id: delivery-assured`, and every following line must be blank or more deeply
 * indented than that item, carrying only `config:` and the keys we write. Anything else
 * returns null, so an unfamiliar file is reported rather than rewritten.
 */
function upgradeIdOnlyEntry(existing, insertEntry) {
  const lines = existing.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^(\\s*)- id:\\s*['"]?${patchId}['"]?\\s*$`).test(line))
  if (start < 0) return null
  const indent = (lines[start].match(/^\s*/) || [''])[0]
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') { end += 1; continue }
    const leading = (line.match(/^\s*/) || [''])[0]
    if (leading.length <= indent.length) break
    if (!/^\s*(config:|packRoot:|projectRoot:|nodeBin:|protectRepoMaterial:)/.test(line)) return null
    end += 1
  }
  const trimmedTail = lines.slice(end).join('\n').replace(/^\s*\n/, '')
  const head = lines.slice(0, start).join('\n').replace(/\s*$/, '')
  const parts = [head, insertEntry, trimmedTail.replace(/\s*$/, '')].filter((part) => part !== '')
  return `${parts.join('\n')}\n`
}

/** Run the plugin's own suites and one real resume so the install is verified, not assumed. */
function selfCheck({ directory, pack, project, node }) {
  const nodeBin = node || process.execPath
  const suites = [
    ['plugin smoke', join(pluginRoot, 'test', 'smoke.mjs'), { DSH_DA_REPO_ROOT: resolve(pluginRoot, '..', '..') }],
    ['trust boundary (§4.3)', join(pluginRoot, 'test', 'trust-boundary.test.mjs'), {}],
  ]
  for (const [label, file, env] of suites) {
    if (!existsSync(file)) { log(`check   : ${label} not found at ${file}`); continue }
    const result = spawnSync(nodeBin, [file], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 })
    if (result.status !== 0) {
      process.stderr.write(`${result.stdout || ''}${result.stderr || ''}`)
      fail(`${label} failed; the profile was written but the install is not verified`)
    }
    log(`check   : ${label} ok`)
  }
  if (project) {
    const resume = spawnSync(nodeBin, [join(pack, 'scripts', 'resume.mjs'), '--project', project, '--offline', '--json'], { encoding: 'utf8' })
    if (resume.status !== 0 && resume.status !== 1) fail(`resume failed with exit ${resume.status}`)
    try {
      const data = JSON.parse(resume.stdout)
      log(`kernel  : ${data.current_slice ? `Slice ${data.current_slice}` : 'no Slice'} | blockers ${Array.isArray(data.blockers) ? data.blockers.length : 0} | evidence ${data.evidence?.total ?? 0} local record(s)`)
    } catch {
      log('kernel  : resume did not print JSON; the session will show "not ready" until it does')
    }
  }
  log('')
  log('installed. Restart DeepSeek Harness so the profile reloads:')
  const profileName = directory.split(/[\\/]/).pop()
  log(`  - profile ${profileName}: the desktop app is owned by Electron, so a restart is what activates it`)
  log('  - verify in a session: the delivery-assured skill is listed and delivery_resume answers')
  log('  - undo: node plugins/dsh-delivery-assured/install.mjs --uninstall' + (profileName !== 'desktop' ? ` --profile ${profileName}` : ''))
  return 0
}

function uninstall(opts) {
  const directory = profileDirectory(opts)
  const file = join(directory, 'package.json')
  const patchFile = join(directory, 'cordis.patch.yml')
  const backup = `${file}${backupSuffix}`
  const patchBackup = `${patchFile}${backupSuffix}`
  if (!opts.profileDir && /(^|[\\/])desktop$/.test(directory)) {
    process.stderr.write('install: note — the desktop app owns this manifest; restart it after the uninstall so the plugin is really unloaded.\n')
  }

  if (existsSync(backup)) {
    if (opts.dryRun) { log(`would restore ${backup} -> ${file}`); return 0 }
    copyFileSync(backup, file)
    rmSync(backup)
    log(`restored ${file} from ${backup}`)
  } else {
    const { json } = readProfile(directory)
    delete json.dependencies?.[bundleName]
    const bundles = json.dsh?.profile?.bundles
    if (Array.isArray(bundles)) json.dsh.profile.bundles = bundles.filter((name) => name !== bundleName)
    if (!opts.dryRun) writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
    log(`${opts.dryRun ? 'would remove' : 'removed'} ${bundleName} from ${file} (no backup was present)`)
  }
  if (existsSync(patchBackup)) {
    if (!opts.dryRun) {
      copyFileSync(patchBackup, patchFile)
      rmSync(patchBackup)
    }
    log(`restored ${patchFile} from its backup`)
  } else if (existsSync(patchFile) && mentionsPlugin(readFileSync(patchFile, 'utf8'))) {
    // No backup means the installer created this file, so removing it restores the
    // profile exactly. A file that pre-existed always has a backup.
    if (!opts.dryRun) rmSync(patchFile)
    log(`${opts.dryRun ? 'would remove' : 'removed'} ${patchFile} (created by the installer)`)
  }
  log('uninstalled. Restart the app to unload the plugin.')
  return 0
}

const opts = parse(process.argv.slice(2))
if (opts.help) {
  process.stdout.write(
    'install — link dsh-delivery-assured into a DSH profile, add the config, verify\n\n' +
      'Usage: node plugins/dsh-delivery-assured/install.mjs --project <delivery repo> [options]\n' +
      '  --profile <name>     profile to install into (default: $DSH_PROFILE or desktop)\n' +
      '  --profile-dir <dir>  explicit profile directory (trials, tests)\n' +
      '  --pack <dir>         operation pack (default: the pack beside this plugin)\n' +
      '  --node <bin>         Node executable recorded for the session\n' +
      '  --dry-run            print the plan and write nothing\n' +
      '  --skip-checks        skip the plugin self-checks\n' +
      '  --enable-desktop     acknowledge that the live desktop profile may be modified\n' +
      '  --uninstall          restore the profile from the installer\'s backups\n',
  )
  process.exit(0)
}
process.exit(opts.uninstall ? uninstall(opts) : install(opts))
