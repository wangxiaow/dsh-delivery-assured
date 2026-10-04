#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const load = (path) => readFileSync(resolve(root, path), 'utf8')
const intent = load('packages/delivery-assured/templates/INTENT.md')
const elicitation = load('packages/delivery-assured/templates/ELICITATION.md')
const kernel = load('project/AGENTS.md')
const readme = load('README.md')
const integration = load('integrations/deepseek-harness/README.md')

function containsAll(text, values) {
  for (const value of values) assert.ok(text.includes(value), `Missing: ${value}`)
}

// These are unit checks of drafting aids, not protected product acceptance.
test('Intent retains every appendix B.1 field and both tables', () => {
  containsAll(intent, [
    '产品意图', '项目：', '目标用户：', '要解决的问题：', '成功结果：',
    'MVP 发布目标：', '目标环境与平台：', '必须保留的限制：', '明确不做：',
    '核心用户旅程', '正式澄清', '| ID | 谁 | 从哪里开始 | 关键动作 | 最终可观察结果 |',
    '| 日期/记录 ID | 原问题 | 你的决定 | 影响的旅程/范围 |',
  ])
})

test('Elicitation retains every appendix B.2 Journey dimension', () => {
  containsAll(elicitation, [
    'Intent：', '项目类型/清单版本：', 'Journey / Step', '前置条件', '成功结果',
    '失败 / 非法输入', '身份 / 权限', '并发 / 重试', '界面 / 输出状态',
    '配置 / 部署 / 定位', 'Unknown / 假设', '来源 / 决定',
  ])
})

test('Elicitation requires full checklist disposition and bounded decisions', () => {
  containsAll(elicitation, [
    '所选清单的每个 ID 一行', 'required', 'excluded', 'not_applicable', 'unknown',
    'deferred_with_approval', 'Contract 义务/结果', 'Unknown/假设 ID', '确认记录',
    '有界假设', '风险', '复查时点', 'Critical', '可观察结果', '来源',
  ])
})

test('Unknowns Gate includes impact, owner decision and unresolved blockers', () => {
  containsAll(elicitation, [
    'Unknowns 表', '不回答的影响', '建议选项', '你的决定', '状态/边界/复查时点',
    'unresolved', 'Gate 结论', '未处理 unknown', '排除及延期的确认引用',
    '阻塞性产品问题', '下一步', '身份判定', '资源归属', '数据破坏', '目标部署',
  ])
})

test('New templates remain drafts and do not self-approve missing facts', () => {
  for (const text of [intent, elicitation]) {
    assert.match(text, /当前状态：draft/)
    assert.match(text, /unknown/)
    assert.match(text, /<[^>]+>/)
    assert.match(text, /阻塞规划/)
    assert.doesNotMatch(text, /当前状态：(?:approved|PASS|MVP_READY)/)
  }
  assert.match(elicitation, /未处理 unknown：unknown/)
  assert.match(intent, /测试通过/)
})

test('Project Kernel points to real source files rather than a fictional Baseline', () => {
  const links = [...kernel.matchAll(/\]\((\.agent\/[^)]+)\)/g)]
  assert.ok(links.length >= 4)
  for (const [, link] of links) assert.ok(existsSync(resolve(root, 'project', link)), link)
  containsAll(kernel, ['.agent/CONTRACT.yaml', '.agent/project.yaml', '.agent/STATE.yaml',
    '.agent/slices/S1.yaml', '没有可信 Baseline revision 可填', '来源 revision',
    'BR-EVIDENCE-NOT-LOCAL', 'BR-STATUS-DERIVED', '数据读取与事务', '身份与授权',
    '错误模型', '目录模块', '命名状态', '共享抽象', '--offline'])
  assert.doesNotMatch(kernel, /BL-\d+|Baseline：[^\n]*(?:已晋升|已验证)/)
})

test('Documentation distinguishes local checks from real delivery authority', () => {
  for (const text of [readme, integration, kernel]) {
    containsAll(text, ['project/', 'origin/main', 'origin/standards/acceptance',
      '远端权限', '未核实', '测试通过非完成', '真实 CI', 'Baseline', '部署证据'])
    assert.doesNotMatch(text, /apply-protection\.ps1/)
  }
  for (const text of [readme, integration]) {
    assert.doesNotMatch(text, /\d+\s*项通过|\d+\/\d+\s*必需用例通过|6 个门本地全绿/)
    assert.match(text, /node \.\.\/packages\/delivery-assured\/scripts\/resume\.mjs --offline/)
    assert.match(text, /node --test packages\/delivery-assured\/tests\/templates\.test\.mjs/)
  }
})

test('New Markdown tables have consistent column counts', () => {
  for (const [name, text] of [['INTENT', intent], ['ELICITATION', elicitation]]) {
    let columns = null
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('|')) { columns = null; continue }
      const count = line.split('|').length
      if (columns === null) columns = count
      assert.equal(count, columns, `${name}: ${line}`)
    }
  }
})
