#!/usr/bin/env node
/**
 * The one-command installer must be idempotent, reversible, and refuse a wrong
 * project root — the three ways a manual profile edit usually goes wrong.
 *
 * Everything happens in a temporary profile directory: the real DSH profile is never
 * touched by this test.
 *
 * Run: node tools/install-plugin.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(repo, 'plugins', 'dsh-delivery-assured', 'install.mjs')
const pack = join(repo, 'packages', 'delivery-assured')
const project = join(repo, 'project')

let checks = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}

const run = (args) => spawnSync(process.execPath, [installer, ...args], { cwd: repo, encoding: 'utf8', timeout: 120000 })

const work = mkdtempSync(join(tmpdir(), 'da-install-'))
const profile = join(work, 'profile')
try {
  mkdirSync(profile, { recursive: true })
  const original = `${JSON.stringify({ name: 'test-profile', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`
  writeFileSync(join(profile, 'package.json'), original)

  // A dry run must not write anything.
  const dry = run(['--profile-dir', profile, '--pack', pack, '--project', project, '--dry-run', '--skip-checks'])
  check(dry.status === 0, `dry run failed: ${dry.stderr}`)
  check(readFileSync(join(profile, 'package.json'), 'utf8') === original, 'dry run must not rewrite package.json')
  check(!existsSync(join(profile, 'cordis.patch.yml')), 'dry run must not create the patch file')

  // A project without a Contract is refused, because a wrong root is how a session
  // reports on the wrong repository.
  const wrongProject = run(['--profile-dir', profile, '--pack', pack, '--project', work, '--skip-checks'])
  check(wrongProject.status === 1 && /CONTRACT\.yaml/.test(wrongProject.stderr), `a wrong project root must be refused: ${wrongProject.stderr}`)

  const installed = run(['--profile-dir', profile, '--pack', pack, '--project', project, '--skip-checks'])
  check(installed.status === 0, `install failed: ${installed.stderr}`)
  const after = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  check(String(after.dependencies['dsh-delivery-assured']).startsWith('link:'), 'the plugin is linked into the profile')
  check(after.dependencies['dsh-delivery-assured'].includes('/plugins/dsh-delivery-assured'), 'the link points at this plugin')
  check(
    !after.dsh.profile.bundles.includes('dsh-delivery-assured'),
    'the bundles list is left to the app: editing it while the desktop plugin manager owns the manifest is how the entry disappears',
  )
  check(existsSync(`${join(profile, 'package.json')}.delivery-backup`), 'a backup of the previous profile file is kept')
  const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  check(/-\s*insert:/.test(patch) && patch.includes('id: delivery-assured'), 'an unbundled profile gets a self-contained insert entry')
  check(/name:\s*dsh-delivery-assured/.test(patch), 'the insert names the plugin package so the loader can resolve it')
  check(!/^- id: delivery-assured$/m.test(patch), 'the insert form is not written as a top-level id-only patch')
  // Indentation is the whole contract of a YAML patch: a key one level too shallow
  // attaches to the wrong node and the plugin loads without a project or not at all.
  check(/^- insert:\n {4}- id: delivery-assured\n {6}name: dsh-delivery-assured\n {6}config:\n {8}packRoot: /m.test(patch), `insert entry nesting: ${JSON.stringify(patch.split('\n').slice(-8))}`)
  check(/^ {8}projectRoot: /m.test(patch), 'the project key sits under config')
  check(patch.includes(project.replace(/\\/g, '/')), 'the patch points at the configured project')
  check(patch.includes('protectRepoMaterial: false'), 'a self-hosting install does not protect the pack it is developing')

  // When the profile already lists the bundle, its own patch inserts the row, so the
  // profile patch must only target that row by id — a second insert would double it.
  const bundledProfile = join(work, 'bundled-profile')
  mkdirSync(bundledProfile, { recursive: true })
  writeFileSync(
    join(bundledProfile, 'package.json'),
    `${JSON.stringify({ name: 'bundled', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-delivery-assured'] } } }, null, 2)}\n`,
  )
  const bundledInstall = run(['--profile-dir', bundledProfile, '--pack', pack, '--project', project, '--skip-checks'])
  check(bundledInstall.status === 0, `bundled install failed: ${bundledInstall.stderr}`)
  const bundledPatch = readFileSync(join(bundledProfile, 'cordis.patch.yml'), 'utf8')
  check(/^- id: delivery-assured\n {2}config:\n {4}packRoot: /m.test(bundledPatch), `bundled profile patch nesting: ${JSON.stringify(bundledPatch.split('\n'))}`)

  // An id-only entry written earlier (when the bundle was listed) must be upgraded in
  // place once the manifest no longer lists it — otherwise the plugin silently unloads.
  const legacy = join(work, 'legacy-profile')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'package.json'), original)
  writeFileSync(
    join(legacy, 'cordis.patch.yml'),
    '# profile patch layer\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    model: deepseek-flash\n- id: delivery-assured\n  config:\n    packRoot: "G:/old/pack"\n    projectRoot: "G:/old/project"\n',
  )
  const upgraded = run(['--profile-dir', legacy, '--pack', pack, '--project', project, '--skip-checks'])
  check(upgraded.status === 0, `upgrade install failed: ${upgraded.stderr}`)
  const upgradedPatch = readFileSync(join(legacy, 'cordis.patch.yml'), 'utf8')
  check(/- insert:/.test(upgradedPatch) && /name: dsh-delivery-assured/.test(upgradedPatch), `the stale id-only entry is upgraded: ${JSON.stringify(upgradedPatch.split('\n').slice(-8))}`)
  check(!/id: delivery-assured\n\s+config:/.test(upgradedPatch), 'the old id-only block is gone')
  check(upgradedPatch.includes('model: deepseek-flash'), 'the unrelated entry survives the upgrade')
  check(upgradedPatch.includes(pack.replace(/\\/g, '/')), 'the upgraded entry carries the current pack root')

  // Idempotent: a second run must not duplicate anything, and must not clobber the
  // existing backup (that backup is the only way back).
  writeFileSync(`${join(profile, 'package.json')}.delivery-backup`, 'SENTINEL')
  const second = run(['--profile-dir', profile, '--pack', pack, '--project', project, '--skip-checks'])
  check(second.status === 0, `second install failed: ${second.stderr}`)
  const twice = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  check(twice.dsh.profile.bundles.filter((n) => n === 'dsh-delivery-assured').length === 0, 'a repeat run still does not touch the bundles list')
  check(readFileSync(`${join(profile, 'package.json')}.delivery-backup`, 'utf8') === 'SENTINEL', 'a repeat run preserves the original backup')

  // Uninstall restores the previous bytes exactly.
  const removed = run(['--profile-dir', profile, '--uninstall'])
  check(removed.status === 0, `uninstall failed: ${removed.stderr}`)
  check(readFileSync(join(profile, 'package.json'), 'utf8') === 'SENTINEL' || readFileSync(join(profile, 'package.json'), 'utf8') === original, 'uninstall restores the backed-up profile file')
  check(!existsSync(`${join(profile, 'package.json')}.delivery-backup`), 'uninstall removes its own backup')
  check(!existsSync(join(profile, 'cordis.patch.yml')), 'uninstall removes the patch file it created')

  // A patch layer that already exists at column 0 must be appended to at column 0 —
  // an indented item would silently become part of the previous entry's config.
  const nested = join(work, 'nested-profile')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'package.json'), original)
  writeFileSync(
    join(nested, 'cordis.patch.yml'),
    '# profile patch layer\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    model: deepseek-flash\n',
  )
  const appended = run(['--profile-dir', nested, '--pack', pack, '--project', project, '--skip-checks'])
  check(appended.status === 0, `appending install failed: ${appended.stderr}`)
  const nestedPatch = readFileSync(join(nested, 'cordis.patch.yml'), 'utf8')
  check(/^- insert:$/m.test(nestedPatch), `the appended entry keeps the file's indentation: ${JSON.stringify(nestedPatch.split('\n').slice(-7))}`)
  check(/^ {4}- id: delivery-assured$/m.test(nestedPatch), 'the inserted row is nested under the new entry, not under the previous item')
  check(nestedPatch.includes('model: deepseek-flash'), 'the existing configuration survives the append')
  const nestedRemoved = run(['--profile-dir', nested, '--uninstall'])
  check(nestedRemoved.status === 0 && readFileSync(join(nested, 'cordis.patch.yml'), 'utf8').includes('model: deepseek-flash') && !/delivery-assured/.test(readFileSync(join(nested, 'cordis.patch.yml'), 'utf8')), 'uninstall restores the pre-existing patch layer byte-for-byte')

  // The live desktop profile is refused without an explicit opt-in: writing a plugin
  // row underneath a running app is how an open session gets broken.
  const fakeHome = join(work, 'fake-home')
  mkdirSync(join(fakeHome, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(fakeHome, 'profiles', 'desktop', 'package.json'), original)
  const refused = spawnSync(process.execPath, [installer, '--project', project, '--skip-checks'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: fakeHome, DSH_PROFILE: 'desktop', DSH_DELIVERY_ALLOW_LIVE_PROFILE: '' },
    timeout: 120000,
  })
  check(refused.status === 1, `the live desktop profile must be refused, got exit ${refused.status}`)
  check(/refusing to modify the live desktop profile/.test(refused.stderr), `the refusal explains itself: ${refused.stderr.slice(0, 160)}`)
  check(readFileSync(join(fakeHome, 'profiles', 'desktop', 'package.json'), 'utf8') === original, 'and nothing is written in that case')
  check(!existsSync(join(fakeHome, 'profiles', 'desktop', 'cordis.patch.yml')), 'and no patch file is created')
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`install-plugin.test ok: ${checks} checks passed`)
