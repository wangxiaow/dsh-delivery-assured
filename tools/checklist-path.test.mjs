import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseYaml } from '../packages/delivery-assured/scripts/lib/yaml.mjs'
const repository = fileURLToPath(new URL('..', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'checklist-path-offline-'))
try {
  const pack = join(root, '安装 pack with spaces #1'), lib = join(pack, 'scripts/lib'), project = join(root, 'isolated project')
  mkdirSync(lib, { recursive: true }); mkdirSync(project)
  // An installed pack ships the whole lib directory. Copying a hand-written file list
  // meant a newly imported module travelled broken and only this suite noticed.
  cpSync(join(repository, 'packages/delivery-assured/scripts/lib'), lib, { recursive: true })
  cpSync(join(repository, 'packages/delivery-assured/templates'), join(pack, 'templates'), { recursive: true })
  const { loadChecklists } = await import(pathToFileURL(join(lib, 'common.mjs')).href)
  const found = loadChecklists(project, { paths: { templateChecklists: null } }, { product: { project_types: ['cli', 'api', 'web_saas'] } })
  assert.equal(found.length, 3)
  for (const definition of found) {
    assert.ok(definition.items.length > 0)
    assert.equal(definition.path, join(pack, 'templates/checklists', `${definition.type}.yaml`))
  }
  const config = parseYaml(readFileSync(join(repository, 'project/.agent/project.yaml'), 'utf8'))
  assert.ok(existsSync(resolve(repository, 'project', config.paths.templateChecklists)), 'declared project checklist override must exist, not silently rely on fallback')
  console.log('checklist-path.test ok: installed pack fallback handles spaces, Unicode and URL escaping; declared override exists')
} finally {
  assert.ok(root.startsWith(join(tmpdir(), 'checklist-path-offline-')))
  rmSync(root, { recursive: true, force: true })
}
